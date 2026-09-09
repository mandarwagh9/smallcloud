import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
create table if not exists users (
  email text primary key,
  created_at integer not null
);
create table if not exists magic_links (
  token text primary key,
  email text not null,
  next text,
  expires_at integer not null,
  used integer not null default 0
);
create table if not exists sessions (
  id text primary key,
  email text not null,
  created_at integer not null,
  expires_at integer not null
);
create table if not exists api_tokens (
  hash text primary key,
  email text not null,
  name text not null,
  created_at integer not null,
  last_used integer
);
create table if not exists cli_logins (
  code text primary key,
  token text,
  created_at integer not null
);
create table if not exists apps (
  id text primary key,
  slug text unique not null,
  name text not null,
  description text not null default '',
  owner_email text not null,
  version integer not null default 1,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists shares (
  app_id text not null,
  principal text not null,
  role text not null,
  primary key (app_id, principal)
);
create table if not exists secrets (
  app_id text not null,
  key text not null,
  value text not null,
  primary key (app_id, key)
);
create table if not exists logs (
  id integer primary key autoincrement,
  app_id text not null,
  at integer not null,
  level text not null,
  msg text not null
);
create index if not exists logs_app on logs(app_id, id);
`;

export function openPlatformDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 3000; pragma foreign_keys = on;');
  db.exec(SCHEMA);
  if (path !== ':memory:') restrictMode(path);
  return db;
}

/**
 * The platform database holds session ids and API token hashes, so nothing but the platform
 * user may read it. Doing this here rather than in an entrypoint script matters: the files do
 * not exist until this function creates them, so an entrypoint that runs first finds nothing
 * to chmod and leaves them world-readable. WAL adds two sibling files with the same secrets.
 */
function restrictMode(path: string): void {
  if (process.platform === 'win32') return;
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      // A read-only or exotic filesystem is not worth refusing to boot over; the operator
      // still has SC_APP_UID and directory modes.
    }
  }
}
