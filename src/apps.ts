import { mkdirSync, rmSync, renameSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix, extname } from 'node:path';
import type { Db } from './db.js';
import type { AppFile, AppRecord, Manifest, User } from './types.js';
import { randomId, encrypt, decrypt } from './crypto.js';
import { normalizeEmail } from './auth.js';

export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024; // small software stays small
export const MAX_FILES = 500;
const ROUTE_EXT = new Set(['.js', '.mjs']);

/**
 * Builtins a route may not reference. This is a deploy-time guardrail, not the boundary:
 * it catches the accidental and the obvious (and gives the agent a message it can act on),
 * while `src/sandbox-host.mjs` blocks the modules at load time. See SECURITY.md.
 */
const DENIED_BUILTINS = [
  'sqlite', 'fs', 'fs/promises', 'child_process', 'worker_threads', 'cluster', 'module',
  'net', 'tls', 'dgram', 'dns', 'http', 'https', 'http2', 'inspector', 'os', 'v8', 'vm',
  'repl', 'process',
];
const DENIED_RE = new RegExp(
  String.raw`(?:require\s*\(|import\s*\(|from)\s*['"\`](?:node:)?(` + DENIED_BUILTINS.join('|') + String.raw`)['"\`]`,
);
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.csv', '.xml', '.map', '.webmanifest']);

export class DeployError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AppPaths {
  root: string; // data/apps/<id>
  bundle: string; // data/apps/<id>/bundle      (read-only to the app)
  data: string; // data/apps/<id>/data          (the app may write here)
  db: string; // data/apps/<id>/data/app.db
  files: string; // data/apps/<id>/data/files
}

export class Apps {
  constructor(
    private db: Db,
    private dataDir: string,
    private secret: string,
  ) {}

  paths(appId: string): AppPaths {
    const root = join(this.dataDir, 'apps', appId);
    return { root, bundle: join(root, 'bundle'), data: join(root, 'data'), db: join(root, 'data', 'app.db'), files: join(root, 'data', 'files') };
  }

  // ---- validation ----------------------------------------------------------

  /** Normalizes and checks a bundle. Throws DeployError with a message an agent can act on. */
  validate(files: AppFile[]): { manifest: Manifest; files: AppFile[] } {
    if (!Array.isArray(files) || files.length === 0) throw new DeployError('empty', 'bundle has no files');
    if (files.length > MAX_FILES) throw new DeployError('too_many_files', `bundle has more than ${MAX_FILES} files`);
    const seen = new Set<string>();
    let total = 0;
    const out: AppFile[] = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') throw new DeployError('bad_file', 'each file needs a string path and string content');
      const p = normalizePath(f.path);
      if (!p) throw new DeployError('bad_path', `"${f.path}" is not a safe relative path`);
      if (seen.has(p)) throw new DeployError('dup_path', `"${p}" appears twice`);
      const ok = p === 'app.json' || p === 'README.md' || p.startsWith('public/') || p.startsWith('api/');
      if (!ok) throw new DeployError('bad_path', `"${p}" is outside app.json, public/ or api/`);
      if (p.startsWith('api/')) {
        const rel = p.slice(4);
        if (rel.includes('/')) throw new DeployError('bad_path', `"${p}": api/ routes must be flat files, e.g. api/todos.js (put shared code in api/_lib.js)`);
        if (!ROUTE_EXT.has(extname(rel))) throw new DeployError('bad_path', `"${p}": api/ files must be .js (ES modules)`);
        const banned = DENIED_RE.exec(f.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : f.content);
        if (banned) {
          throw new DeployError(
            'denied_import',
            `"${p}" imports "${banned[1]}", which apps may not use. Use ctx.db for storage, ctx.files for files, and ctx.fetch for HTTP.`,
          );
        }
      }
      const bytes = f.encoding === 'base64' ? Buffer.byteLength(f.content, 'base64') : Buffer.byteLength(f.content, 'utf8');
      total += bytes;
      if (total > MAX_BUNDLE_BYTES) throw new DeployError('too_big', `bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
      seen.add(p);
      out.push({ path: p, content: f.content, encoding: f.encoding === 'base64' ? 'base64' : 'utf8' });
    }
    const manifestFile = out.find((f) => f.path === 'app.json');
    if (!manifestFile) throw new DeployError('no_manifest', 'bundle needs an app.json with at least {"name": "..."}');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(decode(manifestFile));
    } catch {
      throw new DeployError('bad_manifest', 'app.json is not valid JSON');
    }
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name.trim()) throw new DeployError('bad_manifest', 'app.json needs a "name"');
    manifest.name = manifest.name.trim().slice(0, 80);
    manifest.description = typeof manifest.description === 'string' ? manifest.description.trim().slice(0, 500) : '';
    const hasFrontend = seen.has('public/index.html');
    const hasApi = out.some((f) => f.path.startsWith('api/') && !posix.basename(f.path).startsWith('_'));
    if (!hasFrontend && !hasApi) throw new DeployError('nothing_to_serve', 'bundle needs public/index.html and/or at least one api/<route>.js');
    return { manifest, files: out };
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Create a new app, or redeploy an existing one in place (its id, url, db and files survive). */
  deploy(owner: User, rawFiles: AppFile[], existingId?: string): AppRecord {
    const { manifest, files } = this.validate(rawFiles);
    const now = Date.now();
    let rec: AppRecord;
    if (existingId) {
      const cur = this.get(existingId);
      if (!cur) throw new DeployError('not_found', `no app with id ${existingId}`);
      this.db
        .prepare('update apps set name = ?, description = ?, version = version + 1, updated_at = ? where id = ?')
        .run(manifest.name, manifest.description ?? '', now, cur.id);
      rec = this.get(cur.id)!;
    } else {
      const id = randomId(9);
      const slug = this.uniqueSlug(slugify(manifest.name) || 'app');
      this.db
        .prepare('insert into apps (id, slug, name, description, owner_email, version, created_at, updated_at) values (?, ?, ?, ?, ?, 1, ?, ?)')
        .run(id, slug, manifest.name, manifest.description ?? '', normalizeEmail(owner.email), now, now);
      rec = this.get(id)!;
    }
    this.writeBundle(rec.id, files);
    return rec;
  }

  private writeBundle(appId: string, files: AppFile[]): void {
    const p = this.paths(appId);
    mkdirSync(p.files, { recursive: true });
    const tmp = `${p.bundle}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const f of files) {
      const abs = join(tmp, ...f.path.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content);
    }
    // api/ files are ES modules; this stops Node from walking up the tree looking for a package.json.
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const old = `${p.bundle}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(p.bundle)) renameSync(p.bundle, old);
    renameSync(tmp, p.bundle);
    rmSync(old, { recursive: true, force: true });
  }

  delete(appId: string): void {
    this.db.prepare('delete from shares where app_id = ?').run(appId);
    this.db.prepare('delete from secrets where app_id = ?').run(appId);
    this.db.prepare('delete from logs where app_id = ?').run(appId);
    this.db.prepare('delete from apps where id = ?').run(appId);
    rmSync(this.paths(appId).root, { recursive: true, force: true });
  }

  // ---- lookup --------------------------------------------------------------

  get(idOrSlug: string): AppRecord | null {
    const row = this.db.prepare('select * from apps where id = ? or slug = ?').get(idOrSlug, idOrSlug) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Apps this person owns, then apps shared with them directly, by domain, or publicly listed to them. */
  listFor(user: User): Array<AppRecord & { relation: 'owner' | 'shared' }> {
    const email = normalizeEmail(user.email);
    const domain = email.split('@')[1] ?? '';
    const owned = (this.db.prepare('select * from apps where owner_email = ? order by updated_at desc').all(email) as Row[]).map((r) => ({
      ...toRecord(r),
      relation: 'owner' as const,
    }));
    const shared = (
      this.db
        .prepare(
          `select distinct a.* from apps a join shares s on s.app_id = a.id
           where a.owner_email != ? and (s.principal = ? or s.principal = ?) order by a.updated_at desc`,
        )
        .all(email, `user:${email}`, `domain:${domain}`) as Row[]
    ).map((r) => ({ ...toRecord(r), relation: 'shared' as const }));
    return [...owned, ...shared];
  }

  /** Read the deployed files back (so an agent can revise them). */
  source(appId: string): AppFile[] {
    const p = this.paths(appId);
    const out: AppFile[] = [];
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(abs).isDirectory()) walk(abs, r);
        else if (r !== 'package.json') {
          const buf = readFileSync(abs);
          if (TEXT_EXT.has(extname(name)) || name === 'app.json') out.push({ path: r, content: buf.toString('utf8'), encoding: 'utf8' });
          else out.push({ path: r, content: buf.toString('base64'), encoding: 'base64' });
        }
      }
    };
    if (existsSync(p.bundle)) walk(p.bundle, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Everything needed to leave: bundle, database file, uploaded files. */
  exportEntries(appId: string): Array<{ path: string; data: Buffer }> {
    const p = this.paths(appId);
    const out: Array<{ path: string; data: Buffer }> = [];
    const walk = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const r = `${rel}/${name}`;
        if (statSync(abs).isDirectory()) walk(abs, r);
        else out.push({ path: r, data: readFileSync(abs) });
      }
    };
    walk(p.bundle, 'app');
    walk(p.files, 'files');
    if (existsSync(p.db)) out.push({ path: 'app.db', data: readFileSync(p.db) });
    return out.filter((e) => e.path !== 'app/package.json');
  }

  // ---- secrets -------------------------------------------------------------

  setSecret(appId: string, key: string, value: string): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new DeployError('bad_secret_key', 'secret keys look like API_KEY (upper snake case)');
    this.db
      .prepare('insert into secrets (app_id, key, value) values (?, ?, ?) on conflict (app_id, key) do update set value = excluded.value')
      .run(appId, key, encrypt(this.secret, value));
  }

  deleteSecret(appId: string, key: string): boolean {
    return Number(this.db.prepare('delete from secrets where app_id = ? and key = ?').run(appId, key).changes) > 0;
  }

  secretKeys(appId: string): string[] {
    return (this.db.prepare('select key from secrets where app_id = ? order by key').all(appId) as Array<{ key: string }>).map((r) => r.key);
  }

  /** Decrypted, for handing to the app at request time. */
  env(appId: string): Record<string, string> {
    const rows = this.db.prepare('select key, value from secrets where app_id = ?').all(appId) as Array<{ key: string; value: string }>;
    const env: Record<string, string> = {};
    for (const r of rows) env[r.key] = decrypt(this.secret, r.value);
    return env;
  }

  // ---- logs ----------------------------------------------------------------

  log(appId: string, level: 'info' | 'error', msg: string): void {
    this.db.prepare('insert into logs (app_id, at, level, msg) values (?, ?, ?, ?)').run(appId, Date.now(), level, msg.slice(0, 4000));
    // keep the last 500 lines per app
    this.db
      .prepare('delete from logs where app_id = ? and id < (select coalesce(min(id), 0) from (select id from logs where app_id = ? order by id desc limit 500))')
      .run(appId, appId);
  }

  logs(appId: string, limit = 100): Array<{ at: number; level: string; msg: string }> {
    return (
      this.db.prepare('select at, level, msg from logs where app_id = ? order by id desc limit ?').all(appId, limit) as Array<{
        at: number;
        level: string;
        msg: string;
      }>
    ).reverse();
  }

  // ---- helpers -------------------------------------------------------------

  private uniqueSlug(base: string): string {
    let slug = base;
    for (let i = 2; this.db.prepare('select 1 from apps where slug = ?').get(slug); i++) slug = `${base}-${i}`;
    return slug;
  }
}

type Row = {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_email: string;
  version: number;
  created_at: number;
  updated_at: number;
};

function toRecord(r: Row): AppRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    ownerEmail: r.owner_email,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function decode(f: AppFile): string {
  return f.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : f.content;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** posix-normalized relative path, or null if it escapes or is weird. */
export function normalizePath(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/');
  // reject empties, traversal, and characters illegal in Windows filenames or control chars.
  const ILLEGAL_CHARS = /[<>:"|?*]/;
  if (parts.some((x) => x === '' || x === '.' || x === '..' || ILLEGAL_CHARS.test(x) || hasControlChar(x))) return null;
  return parts.join('/');
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
  return false;
}

/** Read a folder on disk into AppFile[] (used by the CLI and MCP server). */
export function readDirAsFiles(dir: string): AppFile[] {
  const out: AppFile[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else {
        const buf = readFileSync(abs);
        if (TEXT_EXT.has(extname(name)) || name === 'app.json') out.push({ path: r, content: buf.toString('utf8'), encoding: 'utf8' });
        else out.push({ path: r, content: buf.toString('base64'), encoding: 'base64' });
      }
    }
  };
  walk(dir, '');
  return out;
}
