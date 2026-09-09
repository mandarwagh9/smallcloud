// The boundary the whole platform rests on: an app process can touch its own data and nothing else.
// See docs/PLAN.md 6.5. If any of these fail, the isolation story is broken, not the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, deploy, bundle, type Harness } from './helpers.js';

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
  const { BUILTINS_BLOCKED } = await import('../src/sandbox-host.mjs');
  if (!BUILTINS_BLOCKED) {
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
