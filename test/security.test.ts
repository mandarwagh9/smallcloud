// The boundary the whole platform rests on: an app process can touch its own data and nothing else.
// See docs/PLAN.md 6.5. If any of these fail, the isolation story is broken, not the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as nodeModule from 'node:module'; // namespace: registerHooks does not exist before 22.15
import { startHarness, deploy, bundle, type Harness } from './helpers.js';
import { RateLimiter } from '../src/httputil.js';

let h: Harness;
let token: string;

/**
 * An app can be stopped from reaching a builtin by either layer, and which one fires depends
 * on the Node version: `ERR_MODULE_BLOCKED` from the load-time block (Node >= 22.15), or
 * `ERR_ACCESS_DENIED` from the permission model when the module did load. The guarantee under
 * test is the outcome -- the app did not get at the resource -- not which layer delivered it.
 */
const BLOCKED_CODES = new Set(['ERR_MODULE_BLOCKED', 'ERR_ACCESS_DENIED']);

function assertBlocked(body: { result?: string; code?: string }, what: string): void {
  assert.equal(body.result, 'blocked', `${what} (code: ${body.code ?? 'none'})`);
  assert.ok(BLOCKED_CODES.has(body.code ?? ''), `${what}: unexpected block reason ${body.code}`);
}

before(async () => {
  h = await startHarness();
  token = h.tokenFor('owner@example.com');
});
after(() => h.close());

/** Like probe() but returns just {status, body}; a thin alias for readability. */
async function probeRoute(name: string, routeBody: string): Promise<{ status: number; body: any }> {
  const r = await probe(name, routeBody);
  return { status: r.status, body: r.body };
}

/** Deploy a one-route app whose route returns JSON, and call it. */
async function probe(name: string, routeBody: string): Promise<any> {
  const app = await deploy(
    h,
    token,
    bundle({
      'app.json': JSON.stringify({ name }),
      'api/probe.js': `export default async function (req, ctx) { ${routeBody} }`,
    }),
  );
  const res = await h.fetch(`/a/${app.slug}/api/probe`, { token });
  return { app, status: res.status, body: await res.json().catch(() => null) };
}

test('an app cannot read a file outside its own directory', async () => {
  const secret = join(h.services.cfg.dataDir, 'platform.db');
  const { body } = await probe(
    'fs-escape',
    `try {
       const fs = await import('node:' + 'fs');
       const b = fs.readFileSync(${JSON.stringify(secret)});
       return { json: { result: 'LEAKED', bytes: b.length } };
     } catch (e) { return { json: { result: 'blocked', code: e.code } }; }`,
  );
  assertBlocked(body, 'an app read the platform database');
});

test('an app cannot read another app’s database', async () => {
  const other = await deploy(h, token, bundle({ 'app.json': JSON.stringify({ name: 'other' }), 'api/x.js': 'export default () => ({ json: {} })' }));
  const otherDb = h.services.apps.paths(other.id).db;
  mkdirSync(join(h.services.apps.paths(other.id).data), { recursive: true });
  writeFileSync(otherDb, 'not really a db, but readable');
  const { body } = await probe(
    'cross-app',
    `try {
       const fs = await import('node:' + 'fs');
       fs.readFileSync(${JSON.stringify(otherDb)});
       return { json: { result: 'LEAKED' } };
     } catch (e) { return { json: { result: 'blocked', code: e.code } }; }`,
  );
  assertBlocked(body, 'an app read another app’s database');
});

test('an app cannot write outside its data directory', async () => {
  const target = join(h.services.cfg.dataDir, 'escaped.txt');
  const { body } = await probe(
    'fs-write',
    `try {
       const fs = await import('node:' + 'fs');
       fs.writeFileSync(${JSON.stringify(target)}, 'x');
       return { json: { result: 'LEAKED' } };
     } catch (e) { return { json: { result: 'blocked', code: e.code } }; }`,
  );
  assertBlocked(body, 'an app wrote outside its data directory');
  assert.equal(existsSync(target), false);
});

test('an app cannot spawn a process', async () => {
  const { body } = await probe(
    'spawn',
    `try { const cp = await import('node:' + 'child_process'); cp.spawnSync(process.execPath, ['-e', '0']); return { json: { result: 'LEAKED' } }; }
     catch (e) { return { json: { result: 'blocked', code: e.code ?? e.constructor.name } }; }`,
  );
  assertBlocked(body, 'an app spawned a process');
});

test('an app cannot start a worker thread', async () => {
  const { body } = await probe(
    'worker',
    `try { const w = await import('node:' + 'worker_threads'); new w.Worker('0', { eval: true }); return { json: { result: 'LEAKED' } }; }
     catch (e) { return { json: { result: 'blocked', code: e.code ?? e.constructor.name } }; }`,
  );
  assert.equal(body.result, 'blocked', 'an app started a worker thread');
});

test('an app does not inherit platform environment variables', async () => {
  process.env.SC_TEST_PLATFORM_SECRET = 'super-secret-value';
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS ?? '';
  const { body } = await probe('env', `return { json: { keys: Object.keys(process.env), nodeOptions: process.env.NODE_OPTIONS ?? null } };`);
  assert.ok(!body.keys.includes('SC_TEST_PLATFORM_SECRET'), `platform env leaked: ${body.keys.join(',')}`);
  assert.ok(!body.keys.includes('SC_SECRET'), 'the platform signing secret leaked into an app');
  assert.equal(body.nodeOptions, null, 'NODE_OPTIONS leaked into the app process');
  delete process.env.SC_TEST_PLATFORM_SECRET;
});

test('ctx.fetch refuses private network addresses', async () => {
  const { body } = await probe(
    'ssrf',
    `const out = {};
     for (const url of ['http://127.0.0.1:1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/']) {
       try { await ctx.fetch(url); out[url] = 'ALLOWED'; } catch (e) { out[url] = 'blocked'; }
     }
     return { json: out };`,
  );
  for (const [url, verdict] of Object.entries(body)) assert.equal(verdict, 'blocked', `${url} was reachable from an app`);
});

test('a runaway request is killed and the app recovers', async () => {
  const app = await deploy(
    h,
    token,
    bundle({
      'app.json': JSON.stringify({ name: 'runaway' }),
      'api/spin.js': 'export default () => { while (true) {} }',
      'api/ok.js': 'export default () => ({ json: { ok: true } })',
    }),
  );
  const res = await h.fetch(`/a/${app.slug}/api/spin`, { token });
  assert.equal(res.status, 504);
  // the host was killed; the next request must start a fresh one
  const after = await h.json(`/a/${app.slug}/api/ok`, { token });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, { ok: true });
});

test('an app that crashes does not take the platform down', async () => {
  const app = await deploy(
    h,
    token,
    bundle({
      'app.json': JSON.stringify({ name: 'crasher' }),
      'api/boom.js': 'export default () => { throw new Error("kaboom"); }',
    }),
  );
  const { status, body } = await h.json(`/a/${app.slug}/api/boom`, { token });
  assert.equal(status, 500);
  assert.equal(body.error, 'app_error');
  assert.match(body.message, /kaboom/);
  const health = await h.json('/health');
  assert.equal(health.status, 200);
});

test('bundle paths cannot escape the app directory', async () => {
  for (const bad of ['../evil.js', '/etc/passwd', 'api/../../evil.js', 'C:\\evil.js']) {
    const { status, body } = await h.json('/v1/apps', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'app.json', content: '{"name":"x"}' }, { path: bad, content: 'x' }] }),
    });
    assert.equal(status, 400, `${bad} was accepted`);
    assert.equal(body.error, 'bad_path');
  }
});

test('static serving cannot escape the public directory', async () => {
  const app = await deploy(h, token, bundle({ 'app.json': JSON.stringify({ name: 'static-esc' }), 'public/index.html': 'hi' }));
  for (const attempt of ['..%2f..%2fapp.json', '../../app.json', '..\\..\\app.json']) {
    const res = await h.fetch(`/a/${app.slug}/${attempt}`, { token });
    assert.ok(res.status === 404 || res.status === 400, `${attempt} returned ${res.status}`);
  }
});

test('ctx.files rejects names that traverse', async () => {
  const { body } = await probe(
    'files',
    `const out = {};
     for (const n of ['../escape.txt', '/abs.txt', 'ok.txt']) {
       try { ctx.files.put(n, 'x'); out[n] = 'written'; } catch (e) { out[n] = 'rejected'; }
     }
     return { json: out };`,
  );
  assert.equal(body['ok.txt'], 'written');
  assert.equal(body['/abs.txt'], 'rejected');
  assert.equal(body['../escape.txt'], 'rejected');
});

// --- the node:sqlite gap (see SECURITY.md) --------------------------------
//
// Node's permission model governs `fs`, but not the native file access inside `node:sqlite`.
// Two independent layers close it: a deploy-time guardrail that rejects the import outright,
// and a load-time block inside the app process (Node >= 22.15, which has module.registerHooks).

test('deploying a route that imports a denied builtin is rejected', async () => {
  for (const [code, mod] of [
    [`import { DatabaseSync } from 'node:sqlite';`, 'sqlite'],
    [`const { DatabaseSync } = await import('node:sqlite');`, 'sqlite'],
    [`import fs from 'node:fs';`, 'fs'],
    [`import net from 'net';`, 'net'],
  ]) {
    const { status, body } = await h.json('/v1/apps', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [
          { path: 'app.json', content: '{"name":"denied"}' },
          { path: 'api/x.js', content: `${code} export default () => ({ json: {} });` },
        ],
      }),
    });
    assert.equal(status, 400, `${code} was accepted`);
    assert.equal(body.error, 'denied_import');
    assert.match(body.message, new RegExp(mod));
    assert.match(body.message, /ctx\./, 'the error must point the agent at the supported API');
  }
});

test('an app cannot read the platform database through node:sqlite', async (t) => {
  const platformDb = join(h.services.cfg.dataDir, 'platform.db').replaceAll(String.fromCharCode(92), '/');
  const { body } = await probe(
    'sqlite-escape',
    `try {
       const { DatabaseSync } = await import('node:' + 'sqlite');
       const db = new DatabaseSync(${JSON.stringify(platformDb)}, { readOnly: true });
       return { json: { result: 'LEAKED', rows: db.prepare('select email from api_tokens').all().length } };
     } catch (e) { return { json: { result: 'blocked', code: e.code ?? e.message } }; }`,
  );
  // Detect the capability directly. Importing sandbox-host.mjs here would install its loader
  // hooks in the test runner itself, blocking every later `import('node:...')` in this file.
  const builtinsBlocked = typeof nodeModule.registerHooks === 'function';
  if (!builtinsBlocked) {
    // Do not pretend this passes. It is a real, open hole on this Node version.
    t.diagnostic(
      `KNOWN GAP: Node ${process.versions.node} has no module.registerHooks, so an app that ` +
        `constructs the specifier at runtime still reaches the platform database (result: ${body.result}). ` +
        'Run on Node >= 22.15, or set SC_APP_UID. See SECURITY.md.',
    );
    t.skip('requires Node >= 22.15 (module.registerHooks) or SC_APP_UID');
    return;
  }
  assert.equal(body.result, 'blocked', 'an app read the platform database via node:sqlite');
});

// Node matches --allow-fs-* grants by path prefix, so a grant on ".../apps/aa" could also
// cover ".../apps/aaa" unless it ends with a separator. App ids are fixed-length, so this is
// latent rather than live -- but the runtime appends the separator and this proves it works.
test('a filesystem grant does not leak into a sibling directory with a longer name', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-prefix-'));
  const granted = join(root, 'aa');
  const sibling = join(root, 'aaa');
  mkdirSync(granted, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const secret = join(sibling, 'secret.txt');
  writeFileSync(secret, 'this belongs to the other app');
  const probe = join(granted, 'probe.cjs');
  writeFileSync(
    probe,
    'const fs=require("node:fs");' +
      'try{fs.readFileSync(process.argv[2]);console.log("LEAKED")}' +
      'catch(e){console.log("blocked:"+(e.code||e.message))}',
  );

  const SEP = String.fromCharCode(92); // backslash, without an escape the tooling can mangle
  const withSeparator = granted.endsWith('/') || granted.endsWith(SEP) ? granted : granted + '/';
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${withSeparator}`, '--no-warnings', probe, secret], {
    encoding: 'utf8',
  });
  const out = (r.stdout || r.stderr || '').trim();
  assert.match(out, /^blocked/, `a grant on ${granted} reached ${sibling}: ${out}`);
});

test('the device-login token is not sitting in the database in cleartext', () => {
  const start = h.services.auth.startCliLogin();
  h.services.auth.approveCliLogin(start.code, 'owner@example.com');

  const row = h.services.db.prepare('select token from cli_logins where code = ?').get(start.code) as { token: string };
  assert.ok(row.token, 'a token should be parked for the CLI to collect');
  assert.ok(!row.token.startsWith('sc_'), `the raw token is in platform.db: ${row.token.slice(0, 12)}...`);

  // it still round-trips to a working token exactly once
  const polled = h.services.auth.pollCliLogin(start.code);
  assert.equal(polled.status, 'approved');
  assert.match((polled as { token: string }).token, /^sc_/);
  assert.equal(h.services.auth.userFromApiToken((polled as { token: string }).token)?.email, 'owner@example.com');
  assert.equal(h.services.auth.pollCliLogin(start.code).status, 'unknown', 'and is handed over only once');
});

test('a file vanishing mid-stream does not take the control plane down', () => {
  // Runs in a child with UV_THREADPOOL_SIZE=1 so the open() of a static read queues behind a
  // busy threadpool, widening a window that exists anyway: a concurrent redeploy removes the
  // file, the open fails with ENOENT, and an unguarded read stream would emit 'error' with no
  // listener and kill the server -- every app on the instance with it.
  // Verified to fail (ENOENT, exit 1) when the error handler in serveStatic is removed.
  const fixture = join(import.meta.dirname, 'fixtures', 'stream-race.ts');
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', fixture], {
    encoding: 'utf8',
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
    timeout: 120_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.ok(out.includes('SURVIVED'), `the control plane died during the race:
${out.slice(-1200)}`);
  assert.equal(r.status, 0, `child exited ${r.status}`);
});

// The worst regression this project has had: percent-decoding the api path per segment put a
// real "/" and ".." inside `route`, which the app host used as a filename. An anonymous
// visitor to a public app could upload .js through the app's own ctx.files endpoint and then
// make the platform import and run it, reading the app's decrypted secrets.
test('an api route cannot traverse out of api/ and execute an uploaded file', async () => {
  const app = await deploy(
    h,
    token,
    bundle({
      'app.json': JSON.stringify({ name: 'traversal' }),
      'public/index.html': 'hi',
      'api/up.js': `export default (req, ctx) => {
        ctx.files.put('evil.js', 'export default (req, ctx) => ({ json: { pwned: true, stole: ctx.env.SECRET_KEY } })');
        return { json: { stored: true } };
      }`,
      'api/_helper.js': 'export default () => ({ json: { helper: "reached" } })',
    }),
  );
  await h.json(`/v1/apps/${app.id}/secrets`, {
    method: 'PUT',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'SECRET_KEY', value: 'sk-live-do-not-leak' }),
  });
  await h.json(`/v1/apps/${app.id}/shares`, {
    method: 'PUT',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'public' }),
  });

  assert.equal((await h.json(`/a/${app.slug}/api/up`, { method: 'POST' })).status, 200, 'the upload route itself still works');

  // every shape of traversal, unauthenticated
  for (const attempt of [
    '..%2f..%2fdata%2ffiles%2fevil',
    '..%2F..%2Fdata%2Ffiles%2Fevil',
    '.%2F_helper',
    '%2e%2e%2f%2e%2e%2fdata%2ffiles%2fevil',
    '..%5c..%5cdata%5cfiles%5cevil',
  ]) {
    const res = await h.json(`/a/${app.slug}/api/${attempt}`);
    assert.equal(res.status, 400, `${attempt} returned ${res.status}`);
    assert.equal(res.body.error, 'bad_path');
    assert.ok(!JSON.stringify(res.body).includes('sk-live'), 'a secret must never come back');
  }

  // and the documented invariant that api/_*.js are helpers, not routes, still holds
  assert.equal((await h.fetch(`/a/${app.slug}/api/_helper`)).status, 404);
});

test('the rate limiter map stays bounded under many distinct keys', () => {
  const limiter = new RateLimiter(10, 60_000);
  for (let i = 0; i < 20_000; i++) limiter.take(`key-${i}`);
  assert.ok(limiter.size() <= 5000, `the limiter grew to ${limiter.size()} entries`);
  // and it still limits correctly for a key it is tracking
  const fresh = new RateLimiter(2, 60_000);
  assert.equal(fresh.take('a'), true);
  assert.equal(fresh.take('a'), true);
  assert.equal(fresh.take('a'), false);
});

// Round three found the isolation test only tried a dynamic import, while ATTACH through the
// already-open ctx.db handle read the whole platform database -- full account takeover. These
// probe every SQL path an app or editor can reach, and they FAIL without the boundary guard.
test('app SQL cannot ATTACH, DETACH or VACUUM out of its own database', async () => {
  const other = await deploy(h, token, bundle({ 'app.json': '{"name":"other-db"}', 'api/x.js': 'export default () => ({ json: {} })' }));
  const otherDb = h.services.apps.paths(other.id).db.replaceAll(String.fromCharCode(92), '/');
  const platformDb = join(h.services.cfg.dataDir, 'platform.db').replaceAll(String.fromCharCode(92), '/');

  const probe = (target: string, verb: string) =>
    probeRoute(
      `attack-${verb}`,
      `try {
        ctx.db.exec(${JSON.stringify(verb === 'attach' ? `ATTACH DATABASE '${target}' AS p` : verb === 'vacuum' ? `VACUUM INTO '${target}'` : `DETACH DATABASE p`)});
        return { json: { result: 'ALLOWED' } };
      } catch (e) { return { json: { result: 'blocked', message: e.message } }; }`,
    );

  for (const [target, verb] of [
    [platformDb, 'attach'],
    [otherDb, 'attach'],
    [platformDb + '.copy', 'vacuum'],
  ] as const) {
    const { body } = await probe(target, verb);
    assert.equal(body.result, 'blocked', `${verb} to ${target} was allowed`);
    assert.match(body.message, /ATTACH, DETACH and VACUUM/);
  }

  // and it is enforced on the editor SQL endpoint too, not only ctx.db
  const viaApi = await h.json(`/v1/apps/${other.id}/db`, {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: `attach database '${platformDb}' as p` }),
  });
  assert.equal(viaApi.status, 400, 'ATTACH via /v1/apps/:id/db must be refused');

  // normal single-database SQL is unaffected
  const ok = await probeRoute('normal-sql', `ctx.db.exec('create table if not exists t(x)'); ctx.db.run('insert into t values (1)'); return { json: ctx.db.all('select x from t') };`);
  assert.deepEqual(ok.body, [{ x: 1 }]);
});

test('static serving refuses paths that resolve outside public/ (checked against files that exist)', async () => {
  const app = await deploy(h, token, bundle({ 'app.json': '{"name":"static-guard"}', 'public/index.html': 'root' }));
  // Encoded so client-side normalisation cannot collapse them; each names a real file that
  // exists outside public/ (bundle/app.json, the app db, the platform db), so if safeJoin were
  // removed these would 200 -- the point the old test missed.
  for (const attempt of ['..%2fapp.json', '..%2f..%2fdata%2fapp.db', '..%2f..%2f..%2f..%2fplatform.db', '..%5c..%5cplatform.db']) {
    const res = await h.fetch(`/a/${app.slug}/${attempt}`, { token });
    assert.ok(res.status === 404 || res.status === 400, `${attempt} returned ${res.status}`);
    const body = await res.text();
    assert.ok(!body.startsWith('SQLite format'), `${attempt} leaked a database`);
    assert.ok(!body.includes('static-guard'), `${attempt} leaked the manifest`);
  }
});

test('the rate limiter never forgives a key that is already at its limit', () => {
  const limiter = new RateLimiter(3, 60_000);
  // block one key
  assert.equal(limiter.take('victim'), true);
  assert.equal(limiter.take('victim'), true);
  assert.equal(limiter.take('victim'), true);
  assert.equal(limiter.take('victim'), false, 'victim should now be blocked');
  // flood far past the cap with distinct keys, trying to evict the blocked one
  for (let i = 0; i < 20_000; i++) limiter.take(`flood-${i}`);
  assert.ok(limiter.size() <= 5000, `limiter grew to ${limiter.size()}`);
  // the blocked key must still be blocked -- eviction must not have reset it
  assert.equal(limiter.take('victim'), false, 'a blocked key was forgiven by eviction (limit bypass)');
});
