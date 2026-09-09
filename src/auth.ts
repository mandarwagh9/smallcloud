import type { Db } from './db.js';
import type { Mailer } from './email.js';
import type { User } from './types.js';
import { randomToken, sha256 } from './crypto.js';

const MAGIC_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLI_LOGIN_TTL_MS = 10 * 60 * 1000;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthOptions {
  db: Db;
  mailer: Mailer;
  baseUrl: string;
  allowedEmails?: string[]; // empty = anyone
  now?: () => number;
}

export class Auth {
  private db: Db;
  private mailer: Mailer;
  private baseUrl: string;
  private allowed: Set<string>;
  private now: () => number;

  constructor(o: AuthOptions) {
    this.db = o.db;
    this.mailer = o.mailer;
    this.baseUrl = o.baseUrl.replace(/\/$/, '');
    this.allowed = new Set((o.allowedEmails ?? []).map(normalizeEmail).filter(Boolean));
    this.now = o.now ?? Date.now;
  }

  isAllowed(email: string): boolean {
    return this.allowed.size === 0 || this.allowed.has(normalizeEmail(email));
  }

  /** Step 1: email someone a one-time link. Returns the link (never show it to the requester in prod). */
  async requestMagicLink(rawEmail: string, next = '/me'): Promise<string> {
    const email = normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(email)) throw new AuthError('invalid_email', 'that does not look like an email address');
    if (!this.isAllowed(email)) throw new AuthError('not_allowed', 'this email is not allowed to sign in here');
    const token = randomToken(32);
    this.db
      .prepare('insert into magic_links (token, email, next, expires_at) values (?, ?, ?, ?)')
      .run(token, email, next, this.now() + MAGIC_TTL_MS);
    const link = `${this.baseUrl}/auth/${token}`;
    await this.mailer.send(
      email,
      'Your smallcloud sign-in link',
      `Open this link to sign in (valid 15 minutes):\n\n${link}\n\nIf you did not ask for this, ignore it.`,
      `<p>Open this link to sign in (valid 15 minutes):</p><p><a href="${link}">${link}</a></p><p>If you did not ask for this, ignore it.</p>`,
    );
    return link;
  }

  /** Step 2: the link is opened. Returns a session id to set as a cookie, plus where to go next. */
  consumeMagicLink(token: string): { sessionId: string; email: string; next: string } | null {
    const row = this.db
      .prepare('select email, next, expires_at, used from magic_links where token = ?')
      .get(token) as { email: string; next: string | null; expires_at: number; used: number } | undefined;
    if (!row || row.used || row.expires_at < this.now()) return null;
    this.db.prepare('update magic_links set used = 1 where token = ?').run(token);
    this.db.prepare('insert or ignore into users (email, created_at) values (?, ?)').run(row.email, this.now());
    const sessionId = this.createSession(row.email);
    return { sessionId, email: row.email, next: row.next || '/me' };
  }

  createSession(email: string): string {
    const id = randomToken(32);
    this.db
      .prepare('insert into sessions (id, email, created_at, expires_at) values (?, ?, ?, ?)')
      .run(id, normalizeEmail(email), this.now(), this.now() + SESSION_TTL_MS);
    return id;
  }

  userFromSession(sessionId: string | null | undefined): User | null {
    if (!sessionId) return null;
    const row = this.db.prepare('select email, expires_at from sessions where id = ?').get(sessionId) as
      | { email: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < this.now()) return null;
    return { email: row.email };
  }

  destroySession(sessionId: string): void {
    this.db.prepare('delete from sessions where id = ?').run(sessionId);
  }

  /** API tokens are what agents hold. Only the hash is stored; the raw token is shown once. */
  createApiToken(email: string, name = 'agent'): string {
    const raw = `sc_${randomToken(24)}`;
    const e = normalizeEmail(email);
    this.db.prepare('insert into api_tokens (hash, email, name, created_at) values (?, ?, ?, ?)').run(sha256(raw), e, name, this.now());
    this.db.prepare('insert or ignore into users (email, created_at) values (?, ?)').run(e, this.now());
    return raw;
  }

  userFromApiToken(raw: string | null | undefined): User | null {
    if (!raw || !raw.startsWith('sc_')) return null;
    const hash = sha256(raw);
    const row = this.db.prepare('select email from api_tokens where hash = ?').get(hash) as { email: string } | undefined;
    if (!row) return null;
    this.db.prepare('update api_tokens set last_used = ? where hash = ?').run(this.now(), hash);
    return { email: row.email };
  }

  listApiTokens(email: string): Array<{ name: string; createdAt: number; lastUsed: number | null }> {
    const rows = this.db
      .prepare('select name, created_at, last_used from api_tokens where email = ? order by created_at desc')
      .all(normalizeEmail(email)) as Array<{ name: string; created_at: number; last_used: number | null }>;
    return rows.map((r) => ({ name: r.name, createdAt: r.created_at, lastUsed: r.last_used }));
  }

  revokeApiTokens(email: string): void {
    this.db.prepare('delete from api_tokens where email = ?').run(normalizeEmail(email));
  }

  /**
   * CLI/agent login without copy-pasting tokens: the CLI asks for a code, prints a URL,
   * the person opens it in a signed-in browser and approves, the CLI polls and receives a token.
   */
  startCliLogin(): { code: string; url: string } {
    this.db.prepare('delete from cli_logins where created_at < ?').run(this.now() - CLI_LOGIN_TTL_MS);
    const code = randomToken(16);
    this.db.prepare('insert into cli_logins (code, created_at) values (?, ?)').run(code, this.now());
    return { code, url: `${this.baseUrl}/cli/${code}` };
  }

  approveCliLogin(code: string, email: string): boolean {
    const row = this.db.prepare('select token, created_at from cli_logins where code = ?').get(code) as
      | { token: string | null; created_at: number }
      | undefined;
    if (!row || row.token || row.created_at + CLI_LOGIN_TTL_MS < this.now()) return false;
    const token = this.createApiToken(email, 'cli');
    this.db.prepare('update cli_logins set token = ? where code = ?').run(token, code);
    return true;
  }

  /** Returns the token exactly once, then forgets it. */
  pollCliLogin(code: string): { status: 'pending' } | { status: 'approved'; token: string } | { status: 'unknown' } {
    const row = this.db.prepare('select token, created_at from cli_logins where code = ?').get(code) as
      | { token: string | null; created_at: number }
      | undefined;
    if (!row || row.created_at + CLI_LOGIN_TTL_MS < this.now()) return { status: 'unknown' };
    if (!row.token) return { status: 'pending' };
    this.db.prepare('delete from cli_logins where code = ?').run(code);
    return { status: 'approved', token: row.token };
  }
}

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeEmail(e: string): string {
  return (e ?? '').trim().toLowerCase();
}
