// The journeys from docs/PLAN.md 3, exercised against a real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, deploy, todoBundle, bundle, type Harness } from './helpers.js';

let h: Harness;
let ownerToken: string;

before(async () => {
  h = await startHarness();
  ownerToken = h.tokenFor('owner@acme.com');
});
after(() => h.close());

/** Pull the sign-in link out of the mail the server "sent". */
function lastLink(): string {
  const text = h.mail.last?.text ?? '';
  const m = /(http:\/\/\S+\/auth\/\w+)/.exec(text);
  assert.ok(m, `no sign-in link in the last email: ${text}`);
  return m[1];
}

/** Sign in through the browser flow and return the session cookie. */
async function signIn(email: string): Promise<string> {
  const res = await h.fetch('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, next: '/me' }).toString(),
  });
  assert.equal(res.status, 200);
  const link = lastLink();
  const followed = await fetch(link, { redirect: 'manual' });
  assert.equal(followed.status, 302);
  const cookie = followed.headers.get('set-cookie') ?? '';
  const m = /sc_session=([^;]+)/.exec(cookie);
  assert.ok(m, `no session cookie: ${cookie}`);
  return `sc_session=${m[1]}`;
}

// --- J2: ship -------------------------------------------------------------

test('J2: deploy a folder and get a working URL', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Standup'));
  assert.equal(app.slug, 'standup');
  assert.equal(app.version, 1);
  assert.equal(app.url, `${h.base}/a/standup`);

  const page = await h.fetch(`/a/${app.slug}/`, { token: ownerToken });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await page.text(), /todo/);

  const post = await h.json(`/a/${app.slug}/api/todos`, {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ship it' }),
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.todos.length, 1);
  assert.equal(post.body.todos[0].text, 'ship it');
  assert.equal(post.body.you, 'owner@acme.com', 'the app should see who is calling');
});

test('a route can return HTML, JSON, bytes, a status, or nothing', async () => {
  const app = await deploy(
    h,
    ownerToken,
    bundle({
      'app.json': '{"name":"Shapes"}',
      'api/html.js': 'export default () => "<b>hi</b>"',
      'api/json.js': 'export default () => ({ json: { n: 1 } })',
      'api/bytes.js': 'export default () => new Uint8Array([1,2,3])',
      'api/status.js': 'export default () => ({ status: 418, body: "teapot" })',
      'api/nothing.js': 'export default () => {}',
    }),
  );
  const at = (p: string) => h.fetch(`/a/${app.slug}/api/${p}`, { token: ownerToken });

  const html = await at('html');
  assert.match(html.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await html.text(), '<b>hi</b>');

  const json = await at('json');
  assert.deepEqual(await json.json(), { n: 1 });

  const bytes = await at('bytes');
  assert.deepEqual([...new Uint8Array(await bytes.arrayBuffer())], [1, 2, 3]);

  assert.equal((await at('status')).status, 418);
  assert.equal((await at('nothing')).status, 204);
  assert.equal((await at('missing')).status, 404);
});

test('static files and the SPA fallback', async () => {
  const app = await deploy(
    h,
    ownerToken,
    bundle({
      'app.json': '{"name":"Statics"}',
      'public/index.html': '<h1>root</h1>',
      'public/style.css': 'body{color:red}',
      'public/nested/page.html': 'nested',
    }),
  );
  const css = await h.fetch(`/a/${app.slug}/style.css`, { token: ownerToken });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);

  assert.equal((await h.fetch(`/a/${app.slug}/nested/page.html`, { token: ownerToken })).status, 200);

  // a navigation to an unknown path falls back to index.html so client routers work
  const spa = await h.fetch(`/a/${app.slug}/some/deep/route`, { token: ownerToken, headers: { accept: 'text/html' } });
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /root/);

  // a missing asset is a 404, not the index page
  const missing = await h.fetch(`/a/${app.slug}/nope.css`, { token: ownerToken });
  assert.equal(missing.status, 404);
});

// --- J1 + J3: sign in and share -------------------------------------------

test('J1: magic-link sign-in issues a session', async () => {
  const cookie = await signIn('owner@acme.com');
  const me = await h.fetch('/me', { headers: { cookie, accept: 'text/html' } });
  assert.equal(me.status, 200);
  assert.match(await me.text(), /Your apps/);
});

test('a sign-in link works once and not twice', async () => {
  await h.fetch('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'once@acme.com' }).toString(),
  });
  const link = lastLink();
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 302);
  const second = await fetch(link, { redirect: 'manual' });
  assert.equal(second.status, 400);
  assert.match(await second.text(), /did not work/);
});

test('J3: sharing lets a second person in, and only them', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Shared List'));

  // before sharing: a stranger is refused
  const strangerToken = h.tokenFor('stranger@else.com');
  assert.equal((await h.fetch(`/a/${app.slug}/`, { token: strangerToken })).status, 403);

  // an anonymous browser is sent to sign in
  const anon = await h.fetch(`/a/${app.slug}/`, { headers: { accept: 'text/html' } });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location') ?? '', /^\/login\?next=/);

  // share with one person
  const shared = await h.json(`/v1/apps/${app.id}/shares`, {
    method: 'PUT',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'bob@else.com', role: 'user' }),
  });
  assert.equal(shared.status, 200);

  const bobToken = h.tokenFor('bob@else.com');
  assert.equal((await h.fetch(`/a/${app.slug}/`, { token: bobToken })).status, 200);
  assert.equal((await h.fetch(`/a/${app.slug}/`, { token: strangerToken })).status, 403, 'sharing with one person must not admit everyone');

  // the app sees bob, not the owner
  const asBob = await h.json(`/a/${app.slug}/api/todos`, { token: bobToken });
  assert.equal(asBob.body.you, 'bob@else.com');

  // a "user" cannot manage the app
  assert.equal((await h.fetch(`/v1/apps/${app.id}/logs`, { token: bobToken })).status, 403);
  assert.equal((await h.fetch(`/v1/apps/${app.id}`, { method: 'DELETE', token: bobToken })).status, 403);
});

test('a public app is reachable with no sign-in at all', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Public Board'));
  await h.json(`/v1/apps/${app.id}/shares`, {
    method: 'PUT',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'public' }),
  });
  const res = await h.fetch(`/a/${app.slug}/`);
  assert.equal(res.status, 200);
  const api = await h.json(`/a/${app.slug}/api/todos`);
  assert.equal(api.status, 200);
  assert.equal(api.body.you, null, 'ctx.user is null when nobody is signed in');
});

test('a domain share admits everyone at that domain', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Team Wiki'));
  await h.json(`/v1/apps/${app.id}/shares`, {
    method: 'PUT',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'domain:acme.com' }),
  });
  assert.equal((await h.fetch(`/a/${app.slug}/`, { token: h.tokenFor('anyone@acme.com') })).status, 200);
  assert.equal((await h.fetch(`/a/${app.slug}/`, { token: h.tokenFor('nope@other.com') })).status, 403);
});

test('an editor can redeploy and manage shares but not delete', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Editable'));
  await h.json(`/v1/apps/${app.id}/shares`, {
    method: 'PUT',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'ed@else.com', role: 'editor' }),
  });
  const edToken = h.tokenFor('ed@else.com');
  const redeployed = await deploy(h, edToken, todoBundle('Editable'), app.id);
  assert.equal(redeployed.version, 2);
  assert.equal((await h.fetch(`/v1/apps/${app.id}/logs`, { token: edToken })).status, 200);
  assert.equal((await h.fetch(`/v1/apps/${app.id}`, { method: 'DELETE', token: edToken })).status, 403, 'only the owner deletes');
});

// --- J4: iterate ----------------------------------------------------------

test('J4: redeploying keeps the URL and the data', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Persistent'));
  await h.json(`/a/${app.slug}/api/todos`, {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'survive the redeploy' }),
  });

  const v2 = await deploy(h, ownerToken, [...todoBundle('Persistent'), { path: 'public/new.txt', content: 'added' }], app.id);
  assert.equal(v2.id, app.id);
  assert.equal(v2.url, app.url);
  assert.equal(v2.version, 2);

  const after = await h.json(`/a/${app.slug}/api/todos`, { token: ownerToken });
  assert.equal(after.body.todos.length, 1, 'data must survive a redeploy');
  assert.equal(after.body.todos[0].text, 'survive the redeploy');
  assert.equal((await h.fetch(`/a/${app.slug}/new.txt`, { token: ownerToken })).status, 200, 'new files must be live immediately');
});

test('J4: logs and source come back for debugging', async () => {
  const app = await deploy(
    h,
    ownerToken,
    bundle({ 'app.json': '{"name":"Loud"}', 'api/say.js': 'export default (req, ctx) => { ctx.log("hello from the app", { n: 1 }); return { json: {} }; }' }),
  );
  await h.fetch(`/a/${app.slug}/api/say`, { token: ownerToken });
  const logs = await h.json(`/v1/apps/${app.id}/logs`, { token: ownerToken });
  assert.equal(logs.status, 200);
  assert.ok(
    logs.body.logs.some((l: any) => l.msg.includes('hello from the app')),
    `ctx.log output should appear: ${JSON.stringify(logs.body.logs)}`,
  );

  const source = await h.json(`/v1/apps/${app.id}/source`, { token: ownerToken });
  assert.equal(source.status, 200);
  assert.ok(source.body.files.some((f: any) => f.path === 'api/say.js'));
});

// --- J5: secrets ----------------------------------------------------------

test('J5: a secret reaches the app as ctx.env and is never returned', async () => {
  const app = await deploy(
    h,
    ownerToken,
    bundle({ 'app.json': '{"name":"Secretive"}', 'api/key.js': 'export default (req, ctx) => ({ json: { key: ctx.env.API_KEY ?? null } })' }),
  );
  assert.equal((await h.json(`/a/${app.slug}/api/key`, { token: ownerToken })).body.key, null);

  await h.json(`/v1/apps/${app.id}/secrets`, {
    method: 'PUT',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'API_KEY', value: 'sk-live-xyz' }),
  });
  assert.equal((await h.json(`/a/${app.slug}/api/key`, { token: ownerToken })).body.key, 'sk-live-xyz');

  const listed = await h.json(`/v1/apps/${app.id}/secrets`, { token: ownerToken });
  assert.deepEqual(listed.body.keys, ['API_KEY']);
  assert.ok(!JSON.stringify(listed.body).includes('sk-live-xyz'), 'secret values must never be returned');

  const detail = await h.json(`/v1/apps/${app.id}`, { token: ownerToken });
  assert.ok(!JSON.stringify(detail.body).includes('sk-live-xyz'));
});

// --- J6: leave ------------------------------------------------------------

test('J6: export returns a zip containing the source and the database', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Exportable'));
  await h.json(`/a/${app.slug}/api/todos`, {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'in the export' }),
  });
  const res = await h.fetch(`/v1/apps/${app.id}/export`, { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes(Buffer.from('app.json')), 'the manifest should be in the export');
  assert.ok(buf.includes(Buffer.from('api/todos.js')), 'the routes should be in the export');
  assert.ok(buf.includes(Buffer.from('app.db')), 'the database should be in the export');
});

test('deleting an app removes it and its data', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Doomed'));
  assert.equal((await h.fetch(`/v1/apps/${app.id}`, { method: 'DELETE', token: ownerToken })).status, 200);
  assert.equal((await h.fetch(`/a/${app.slug}/`, { token: ownerToken })).status, 404);
});

// --- agent surface --------------------------------------------------------

test('the API refuses anonymous callers and bad tokens', async () => {
  assert.equal((await h.fetch('/v1/apps')).status, 401);
  assert.equal((await h.fetch('/v1/apps', { token: 'sc_not-a-real-token' })).status, 401);
  const me = await h.json('/v1/me', { token: ownerToken });
  assert.equal(me.body.email, 'owner@acme.com');
});

test('a revoked token stops working', async () => {
  const token = h.tokenFor('revokable@acme.com');
  assert.equal((await h.fetch('/v1/me', { token })).status, 200);
  h.services.auth.revokeApiTokens('revokable@acme.com');
  assert.equal((await h.fetch('/v1/me', { token })).status, 401);
});

test('device login: start, approve in the browser, poll once', async () => {
  const start = await h.json('/v1/cli-login', { method: 'POST' });
  assert.equal(start.status, 200);
  const code = start.body.code;
  assert.equal((await h.json(`/v1/cli-login/${code}`)).body.status, 'pending');

  const cookie = await signIn('owner@acme.com');
  const approved = await h.fetch(`/cli/${code}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(approved.status, 200);

  const polled = await h.json(`/v1/cli-login/${code}`);
  assert.equal(polled.body.status, 'approved');
  assert.match(polled.body.token, /^sc_/);
  // the token is handed over exactly once
  assert.equal((await h.fetch(`/v1/cli-login/${code}`)).status, 404);

  const who = await h.json('/v1/me', { token: polled.body.token });
  assert.equal(who.body.email, 'owner@acme.com');
});

test('the contract is served and covers what an agent needs', async () => {
  const res = await h.fetch('/v1/contract');
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const needle of ['app.json', 'public/index.html', 'api/', 'ctx.db', 'ctx.files', 'ctx.user', 'ctx.env', 'export default']) {
    assert.ok(text.includes(needle), `the contract must mention ${needle}`);
  }
});

test('agents can run SQL against an app database', async () => {
  const app = await deploy(h, ownerToken, todoBundle('Queryable'));
  await h.json(`/a/${app.slug}/api/todos`, {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'query me' }),
  });
  const q = await h.json(`/v1/apps/${app.id}/db`, {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'select text from todos' }),
  });
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.rows, [{ text: 'query me' }]);

  const bad = await h.json(`/v1/apps/${app.id}/db`, {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'select * from nope' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'sql_error');
});

test('deploy errors name the file and the fix', async () => {
  const { status, body } = await h.json('/v1/apps', {
    method: 'POST',
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ path: 'app.json', content: '{"name":"x"}' }, { path: 'api/deep/route.js', content: 'x' }] }),
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_path');
  assert.match(body.message, /api\/todos\.js/, 'the error should show the shape that would work');
});

test('health and stats report the instance', async () => {
  assert.equal((await h.json('/health')).body.ok, true);
  const stats = await h.json('/v1/stats');
  assert.equal(stats.status, 200);
  assert.ok(typeof stats.body.apps === 'number');
});

// Found by the cold agent test (eval/cold-agent.mjs): the share link has no trailing slash,
// so a relative fetch in the app's own page resolved one directory too high and 404'd at
// exactly the URL recipients are given.
test('the app root redirects to its directory form so relative URLs work', async () => {
  const app = await deploy(
    h,
    ownerToken,
    bundle({
      'app.json': '{"name":"Relative"}',
      'public/index.html': '<!doctype html><script>fetch("api/ping")</script>',
      'api/ping.js': 'export default () => ({ json: { pong: true } })',
    }),
  );

  const res = await h.fetch(`/a/${app.slug}`, { token: ownerToken, headers: { accept: 'text/html' } });
  assert.equal(res.status, 302, 'the no-slash form should redirect');
  assert.equal(res.headers.get('location'), `/a/${app.slug}/`);

  // the query string survives the redirect
  const q = await h.fetch(`/a/${app.slug}?tab=open`, { token: ownerToken, headers: { accept: 'text/html' } });
  assert.equal(q.headers.get('location'), `/a/${app.slug}/?tab=open`);

  // and after following it, a relative URL in the page reaches the app's own API
  const resolved = new URL('api/ping', `${h.base}/a/${app.slug}/`).pathname;
  assert.equal(resolved, `/a/${app.slug}/api/ping`);
  const ping = await h.json(resolved, { token: ownerToken });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.body, { pong: true });

  // the URL the platform hands out must actually serve the app to a browser that follows it
  const followed = await fetch(`${h.base}/a/${app.slug}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(followed.status, 200);
  assert.match(await followed.text(), /doctype/i);
});
