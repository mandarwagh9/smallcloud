// Verifies the OS-level boundary: with SC_APP_UID set, an app process runs as an
// unprivileged user that the kernel refuses access to platform.db -- regardless of what
// Node's permission model does or does not cover for a given builtin.
//
// POSIX only, must run as root (it chowns the app tree the way docker-entrypoint.sh does).
// Run inside the container: node --import tsx scripts/verify-uid-isolation.mjs

import { mkdtempSync, chmodSync, chownSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, createHttpServer } from '../src/server.js';
import { consoleMailer } from '../src/email.js';

const APP_UID = Number(process.env.SC_APP_UID ?? 10001);
const APP_UID_NAME = process.env.SC_APP_USER ?? 'scapp';
const APP_GID = Number(process.env.SC_APP_GID ?? 10001);

if (process.platform === 'win32') {
  console.log('SKIP: POSIX only');
  process.exit(0);
}
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  console.error('FAIL: must run as root so it can drop privileges when forking app hosts');
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'sc-uid-'));
const cfg = {
  dataDir,
  baseUrl: 'http://127.0.0.1:0',
  port: 0,
  secret: 'uid-test-secret',
  allowedEmails: [],
  trustProxy: false,
  staticRpm: 100000,
  apiRpm: 100000,
  deployPerHour: 100000,
  appQuotaBytes: 100 * 1024 * 1024,
  appMaxFiles: 10000,
    staticRpm: 100000,
    apiRpm: 100000,
  appUid: APP_UID,
  appGid: APP_GID,
};

const services = createServices(cfg, consoleMailer(() => {}));
const server = createHttpServer(services);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
services.cfg.baseUrl = base;

// Exactly what docker-entrypoint.sh does on boot.
mkdirSync(join(dataDir, 'apps'), { recursive: true });
chownSync(join(dataDir, 'apps'), APP_UID, APP_GID);
chmodSync(dataDir, 0o711);
for (const f of ['platform.db', 'platform.db-wal', 'platform.db-shm']) {
  const p = join(dataDir, f);
  if (existsSync(p)) chmodSync(p, 0o600);
}

const token = services.auth.createApiToken('owner@example.com', 'uid-test');
const platformDb = join(dataDir, 'platform.db');

// The specifier is built at runtime so the deploy-time guardrail does not catch it:
// this is testing the OS boundary specifically, on its own.
const files = [
  { path: 'app.json', content: JSON.stringify({ name: 'uid probe' }) },
  {
    path: 'api/probe.js',
    content: `export default async function (req, ctx) {
      const out = { uid: typeof process.getuid === 'function' ? process.getuid() : null };
      try {
        const { DatabaseSync } = await import('node:' + 'sqlite');
        const db = new DatabaseSync(${JSON.stringify(platformDb)}, { readOnly: true });
        out.sqlite = { result: 'LEAKED', rows: db.prepare('select email from api_tokens').all().length };
      } catch (e) { out.sqlite = { result: 'blocked', code: e.code ?? e.message }; }
      try {
        const fs = await import('node:' + 'fs');
        fs.readFileSync(${JSON.stringify(platformDb)});
        out.fs = 'LEAKED';
      } catch (e) { out.fs = 'blocked:' + (e.code ?? e.message); }
      return { json: out };
    }`,
  },
];

const deployed = await fetch(`${base}/v1/apps`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ files }),
});
const app = await deployed.json();
if (!deployed.ok) {
  console.error('FAIL: deploy rejected', app);
  process.exit(1);
}

// The app's own tree must belong to the app user, or it cannot open its own database.
chownRecursive(services.apps.paths(app.id).root, APP_UID, APP_GID);

const res = await fetch(`${base}/a/${app.slug}/api/probe`, { headers: { authorization: `Bearer ${token}` } });
const body = await res.json();
console.log('probe:', JSON.stringify(body));

// The probe above proves the app is stopped, but on Node >= 22.15 the module block fires
// first, so it does not by itself prove the *kernel* refuses access. Check that layer alone:
// plain Node, no --permission and no module block, running as the app user.
let kernel = 'not run';
try {
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'kernel-probe.cjs');
  kernel = execFileSync('su', ['-s', '/bin/sh', String(APP_UID_NAME), '-c', `node --no-warnings ${probe} ${platformDb}`], {
    encoding: 'utf8',
  }).trim();
} catch (err) {
  kernel = `probe failed: ${String(err.stderr ?? err.message).slice(0, 200)}`;
}
console.log('kernel-only probe:', kernel);

const failures = [];
if (!kernel.startsWith('blocked by kernel')) failures.push(`the OS did not refuse the app user access to platform.db: ${kernel}`);
if (body.uid !== APP_UID) failures.push(`app process ran as uid ${body.uid}, expected ${APP_UID}`);
if (body.sqlite?.result !== 'blocked') failures.push(`node:sqlite reached the platform database: ${JSON.stringify(body.sqlite)}`);
if (body.fs !== undefined && String(body.fs).startsWith('LEAKED')) failures.push('fs reached the platform database');
console.log(`platform.db mode: 0${(statSync(platformDb).mode & 0o777).toString(8)}`);

services.runtime.stopAll();
server.close();

if (failures.length) {
  for (const f of failures) console.error('FAIL:', f);
  process.exit(1);
}
console.log('PASS: app process runs as the unprivileged user and cannot reach the platform database');
process.exit(0);

function chownRecursive(dir, uid, gid) {
  chownSync(dir, uid, gid);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) chownRecursive(p, uid, gid);
    else chownSync(p, uid, gid);
  }
}
