import type { Db } from './db.js';
import type { AppRecord, EffectiveRole, Principal, Role, Share, User } from './types.js';
import { normalizeEmail } from './auth.js';

export const ROLES: Role[] = ['user', 'editor'];

export function parsePrincipal(raw: string): Principal {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'public') return 'public';
  if (s.startsWith('user:')) {
    const email = s.slice(5);
    if (!email.includes('@')) throw new ShareError('bad_principal', `"${raw}" is not an email`);
    return `user:${email}`;
  }
  if (s.startsWith('domain:')) {
    const d = s.slice(7);
    if (!d || d.includes('@') || d.includes('/')) throw new ShareError('bad_principal', `"${raw}" is not a domain`);
    return `domain:${d}`;
  }
  // bare email or bare domain, be forgiving
  if (s.includes('@')) return `user:${s}`;
  if (s.includes('.')) return `domain:${s}`;
  throw new ShareError('bad_principal', `"${raw}" should be an email, a domain, or "public"`);
}

export function parseRole(raw: string | undefined): Role {
  const r = (raw ?? 'user').trim().toLowerCase();
  if (!ROLES.includes(r as Role)) throw new ShareError('bad_role', `role must be one of ${ROLES.join(', ')}`);
  return r as Role;
}

export class ShareError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function listShares(db: Db, appId: string): Share[] {
  const rows = db.prepare('select app_id, principal, role from shares where app_id = ? order by principal').all(appId) as Array<{
    app_id: string;
    principal: Principal;
    role: Role;
  }>;
  return rows.map((r) => ({ appId: r.app_id, principal: r.principal, role: r.role }));
}

export function setShare(db: Db, appId: string, principal: Principal, role: Role): Share {
  db.prepare(
    'insert into shares (app_id, principal, role) values (?, ?, ?) on conflict (app_id, principal) do update set role = excluded.role',
  ).run(appId, principal, role);
  return { appId, principal, role };
}

export function removeShare(db: Db, appId: string, principal: Principal): boolean {
  const r = db.prepare('delete from shares where app_id = ? and principal = ?').run(appId, principal);
  return Number(r.changes) > 0;
}

/** The single truth table: what can this person do with this app? */
export function roleFor(db: Db, app: AppRecord, user: User | null): EffectiveRole | null {
  if (user && normalizeEmail(user.email) === normalizeEmail(app.ownerEmail)) return 'owner';
  const shares = listShares(db, app.id);
  let best: Role | null = null;
  const bump = (r: Role) => {
    if (r === 'editor' || best === null) best = r;
  };
  const email = user ? normalizeEmail(user.email) : null;
  const domain = email ? email.split('@')[1] : null;
  for (const s of shares) {
    if (s.principal === 'public') bump(s.role);
    if (email && s.principal === `user:${email}`) bump(s.role);
    if (domain && s.principal === `domain:${domain}`) bump(s.role);
  }
  return best;
}

export function canUse(role: EffectiveRole | null): boolean {
  return role !== null;
}

export function canManage(role: EffectiveRole | null): boolean {
  return role === 'owner' || role === 'editor';
}

export function isPublic(db: Db, appId: string): boolean {
  return listShares(db, appId).some((s) => s.principal === 'public');
}
