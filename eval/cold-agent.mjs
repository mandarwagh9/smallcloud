/**
 * The cold agent test (docs/PLAN.md S1 / T3.6).
 *
 * Stands up a real smallcloud server, hands a *fresh* Claude Code session nothing but the
 * smallcloud MCP server and a scratch directory, and asks it to ship a multi-user todo app.
 * No human help, no prior context, no example to copy: if the contract does not explain the
 * platform well enough, this fails.
 *
 * The harness never touches the app it is grading -- it only reads the platform API and makes
 * ordinary HTTP requests, the way a recipient would.
 *
 *   node --import tsx eval/cold-agent.mjs [--runs 3] [--model sonnet] [--keep]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { createServices, createHttpServer } from '../src/server.js';
import { consoleMailer } from '../src/email.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve the real binary so the child can be spawned without a shell. Going through a shell
 * on Windows splits a multi-line prompt argument at the first space, which silently sends the
 * agent the single word "Use".
 */
const CLAUDE_BIN = (() => {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const lines = execSync(cmd, { encoding: 'utf8' }).split(String.fromCharCode(10));
    return lines.map((l) => l.trim()).find(Boolean) || 'claude';
  } catch {
    return 'claude';
  }
})();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : args[i + 1]) : fallback;
};
const RUNS = Number(flag('runs', 1));
const MODEL = flag('model', null);
const KEEP = args.includes('--keep');
const TIMEOUT_MS = Number(flag('timeout', 15 * 60_000));

const OWNER = 'builder@example.com';
const RECIPIENT = 'bob@example.com';

// The goal names the API shape so the harness can grade a working app rather than guess at
// whatever endpoints the agent invented. Everything else -- storage, frontend, sharing, the
// folder layout -- the agent has to work out from the contract.
const GOAL = `Use the smallcloud MCP server to build and ship a shared todo list, then share it.

Requirements:
1. Read the smallcloud contract first (smallcloud_contract) so you follow the platform's rules.
2. Write the app into a new folder under the current directory, then deploy it with smallcloud_deploy.
3. It must have a browser frontend at the app root (public/index.html) that lists todos and lets you add one.
4. It must expose exactly these API routes:
   - GET  api/todos  -> {"todos": [{"id": <number>, "text": <string>, "done": 0|1, "who": <email string>}]}
   - POST api/todos  with body {"text": "..."} -> adds a todo and returns the same {"todos": [...]} shape
   Store todos in the app's database so they survive a redeploy. Record who added each todo
   using the signed-in person's email.
5. Share it with ${RECIPIENT} so they can use it (role: user).
6. Report the app's URL when you are done.

Do not ask me any questions; make reasonable choices and finish the task.`;

async function main() {
  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`\n${'='.repeat(72)}\nRUN ${i} of ${RUNS}\n${'='.repeat(72)}\n`);
    results.push(await runOnce(i));
  }
  const passed = results.filter((r) => r.pass).length;
  process.stdout.write(`\n${'='.repeat(72)}\nCOLD AGENT TEST: ${passed}/${RUNS} passed\n`);
  for (const [i, r] of results.entries()) {
    process.stdout.write(`  run ${i + 1}: ${r.pass ? 'PASS' : 'FAIL'}  (${Math.round(r.seconds)}s, ${r.turns ?? '?'} turns)\n`);
    for (const c of r.checks) process.stdout.write(`    ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` -- ${c.detail}` : ''}\n`);
  }
  process.exit(passed === RUNS ? 0 : 1);
}

async function runOnce(runIndex) {
  const started = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), `sc-eval-data-${runIndex}-`));
  const workDir = mkdtempSync(join(tmpdir(), `sc-eval-work-${runIndex}-`));
  const services = createServices(
    {
      dataDir,
      baseUrl: 'http://127.0.0.1:0',
      port: 0,
      secret: 'cold-agent-eval-secret',
      allowedEmails: [],
      trustProxy: false,
    },
    consoleMailer(() => {}),
  );
  const server = createHttpServer(services);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  services.cfg.baseUrl = base;

  const ownerToken = services.auth.createApiToken(OWNER, 'cold-agent-eval');
  const mcpConfig = join(workDir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        smallcloud: {
          command: process.execPath,
          args: [join(ROOT, 'bin', 'smallcloud.mjs'), 'mcp'],
          env: { SMALLCLOUD_URL: base, SMALLCLOUD_TOKEN: ownerToken },
        },
      },
    }),
  );

  const cli = [
    '-p',
    GOAL,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--allowedTools',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'mcp__smallcloud',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
    ...(MODEL ? ['--model', MODEL] : []),
  ];

  process.stdout.write(`server ${base}\nworkdir ${workDir}\nasking a fresh agent to ship the app...\n`);
  const agent = await runAgent(cli, workDir);
  process.stdout.write(`agent finished in ${Math.round((Date.now() - started) / 1000)}s (${agent.turns ?? '?'} turns)\n`);
  if (agent.text) process.stdout.write(`--- agent's answer ---\n${agent.text.trim().slice(0, 1200)}\n----------------------\n`);

  const checks = await grade(services, base, ownerToken);
  const pass = checks.every((c) => c.ok);

  writeFileSync(join(workDir, 'agent-output.json'), JSON.stringify(agent.raw ?? {}, null, 2));
  services.runtime.stopAll();
  await new Promise((r) => server.close(r));
  services.db.close();
  if (!KEEP) {
    rmSync(dataDir, { recursive: true, force: true });
    if (pass) rmSync(workDir, { recursive: true, force: true });
    else process.stdout.write(`kept the failing run's files: ${workDir}\n`);
  }
  return { pass, checks, seconds: (Date.now() - started) / 1000, turns: agent.turns };
}

function runAgent(cliArgs, cwd) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, cliArgs, {
      cwd,
      shell: false,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ text: '(timed out)', turns: null, raw: { error: 'timeout', stderr: err.slice(-2000) } });
    }, TIMEOUT_MS);
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        resolve({ text: parsed.result ?? '', turns: parsed.num_turns, raw: parsed });
      } catch {
        resolve({ text: out.slice(-2000), turns: null, raw: { stdout: out.slice(-4000), stderr: err.slice(-2000) } });
      }
    });
  });
}

/** Grade the deployed app the way a user would: over HTTP, knowing nothing about its source. */
async function grade(services, base, ownerToken) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const listed = await api(base, ownerToken, 'GET', '/v1/apps');
  const apps = listed.body?.apps ?? [];
  add('the agent deployed exactly one app', apps.length === 1, `found ${apps.length}`);
  if (apps.length !== 1) return checks;
  const app = apps[0];

  // 1. the frontend
  const page = await fetch(`${base}/a/${app.slug}/`, { headers: { authorization: `Bearer ${ownerToken}` } });
  const html = await page.text();
  add('the app serves an HTML frontend at its root', page.ok && /<html|<!doctype|<body|<h1|<div/i.test(html), `status ${page.status}`);

  // 2. the API, exercised as the owner
  const empty = await api(base, ownerToken, 'GET', `/a/${app.slug}/api/todos`);
  add('GET api/todos returns a todos array', Array.isArray(empty.body?.todos), JSON.stringify(empty.body)?.slice(0, 160));

  const added = await api(base, ownerToken, 'POST', `/a/${app.slug}/api/todos`, { text: 'written by the grader' });
  const hasItem = (b) => Array.isArray(b?.todos) && b.todos.some((t) => t.text === 'written by the grader');
  add('POST api/todos adds a todo', added.status < 400 && (hasItem(added.body) || hasItem((await api(base, ownerToken, 'GET', `/a/${app.slug}/api/todos`)).body)));

  // 3. sharing, and that the app sees who is calling
  const detail = await api(base, ownerToken, 'GET', `/v1/apps/${app.id}`);
  const shares = detail.body?.shares ?? [];
  add('shared with the second person', shares.some((s) => s.principal === `user:${RECIPIENT}`), JSON.stringify(shares));

  const bobToken = services.auth.createApiToken(RECIPIENT, 'grader');
  const bobOpen = await fetch(`${base}/a/${app.slug}/`, { headers: { authorization: `Bearer ${bobToken}` } });
  add('the second person can open it', bobOpen.status === 200, `status ${bobOpen.status}`);

  const bobPost = await api(base, bobToken, 'POST', `/a/${app.slug}/api/todos`, { text: 'bob was here' });
  const afterBob = bobPost.status < 400 ? bobPost.body : (await api(base, bobToken, 'GET', `/a/${app.slug}/api/todos`)).body;
  const bobItem = (afterBob?.todos ?? []).find((t) => t.text === 'bob was here');
  add('the second person can add a todo', Boolean(bobItem));
  add('the app attributes it to the right person', bobItem?.who === RECIPIENT, `who = ${JSON.stringify(bobItem?.who)}`);

  const strangerToken = services.auth.createApiToken('stranger@nowhere.com', 'grader');
  const stranger = await fetch(`${base}/a/${app.slug}/`, { headers: { authorization: `Bearer ${strangerToken}` } });
  add('a stranger is refused', stranger.status === 403, `status ${stranger.status}`);

  // 4. the data is really in the app's database, so it survives a redeploy
  const rows = await api(base, ownerToken, 'POST', `/v1/apps/${app.id}/db`, { sql: "select count(*) as n from sqlite_master where type='table'" });
  add('the app created tables in its own database', (rows.body?.rows?.[0]?.n ?? 0) > 0, JSON.stringify(rows.body)?.slice(0, 120));

  return checks;
}

async function api(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

void mkdirSync;
main();
