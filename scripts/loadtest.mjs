/**
 * Load sanity check (docs/PLAN.md NF2 / T4.6).
 *
 * Not a benchmark -- a check that a small box behaves sensibly under the traffic a handful of
 * people actually generate, and that nothing errors or leaks processes along the way.
 *
 *   node scripts/loadtest.mjs <baseUrl> <token> <slug> [--seconds 20]
 *
 * Targets from the plan: static p50 < 5ms, warm API p50 < 20ms, cold start < 600ms,
 * 50 rps static and 20 rps API with zero errors.
 */
const [baseUrl, token, slug] = process.argv.slice(2);
if (!baseUrl || !token || !slug) {
  console.error('usage: node scripts/loadtest.mjs <baseUrl> <token> <slug> [--seconds 20]');
  process.exit(2);
}
const SECONDS = Number(process.argv.includes('--seconds') ? process.argv[process.argv.indexOf('--seconds') + 1] : 20);
const auth = { authorization: `Bearer ${token}` };

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const fmt = (n) => `${n.toFixed(1)}ms`;

async function timed(url, init) {
  const t = process.hrtime.bigint();
  const res = await fetch(url, init);
  await res.arrayBuffer();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: res.status };
}

/** Drive a fixed request rate for a fixed time; report latency and any non-2xx. */
async function drive(name, url, rps, seconds, init) {
  const results = [];
  const errors = [];
  const started = Date.now();
  const gap = 1000 / rps;
  let scheduled = 0;
  const inflight = [];
  while (Date.now() - started < seconds * 1000) {
    const due = started + scheduled * gap;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    scheduled++;
    inflight.push(
      timed(url, init).then(
        (r) => {
          results.push(r.ms);
          if (r.status >= 400) errors.push(r.status);
        },
        (e) => errors.push(String(e.message ?? e)),
      ),
    );
    if (inflight.length > 500) inflight.splice(0, 250);
  }
  await Promise.all(inflight);
  const sorted = results.sort((a, b) => a - b);
  const actualRps = results.length / seconds;
  console.log(
    `  ${name.padEnd(22)} ${String(results.length).padStart(5)} reqs  ${actualRps.toFixed(0).padStart(3)} rps  ` +
      `p50 ${fmt(pct(sorted, 50)).padStart(8)}  p95 ${fmt(pct(sorted, 95)).padStart(8)}  max ${fmt(sorted.at(-1)).padStart(8)}  ` +
      `errors ${errors.length}`,
  );
  return { p50: pct(sorted, 50), p95: pct(sorted, 95), errors: errors.length, count: results.length, errorSamples: errors.slice(0, 3) };
}

const appUrl = `${baseUrl}/a/${slug}`;
console.log(`load sanity against ${appUrl} (${SECONDS}s per phase)\n`);

// 1. Cold start: the app process exits after 60s idle, so the first hit pays for a spawn.
//    Force it by redeploying, which stops the running host.
const source = await (await fetch(`${baseUrl}/v1/apps/${slug}/source`, { headers: auth })).json();
await fetch(`${baseUrl}/v1/apps`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ files: source.files, appId: source.appId }),
});
const cold = await timed(`${appUrl}/api/todos`, { headers: auth });
const warm = await timed(`${appUrl}/api/todos`, { headers: auth });
console.log(`  cold start            ${fmt(cold.ms)}   (target < 600ms)`);
console.log(`  first warm request    ${fmt(warm.ms)}\n`);

// 2. Sustained load
const staticRes = await drive('static 50 rps', `${appUrl}/`, 50, SECONDS, { headers: auth });
const apiRead = await drive('API GET 20 rps', `${appUrl}/api/todos`, 20, SECONDS, { headers: auth });
const apiWrite = await drive('API POST 20 rps', `${appUrl}/api/todos`, 20, SECONDS, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'load test' }),
});

const health = await (await fetch(`${baseUrl}/health`)).json();
console.log(`\n  server still healthy: ${health.ok}, app processes running: ${health.apps}`);

const checks = [
  ['cold start under 600ms', cold.ms < 600, fmt(cold.ms)],
  ['static p50 under 5ms', staticRes.p50 < 5, fmt(staticRes.p50)],
  ['API read p50 under 20ms', apiRead.p50 < 20, fmt(apiRead.p50)],
  ['API write p50 under 20ms', apiWrite.p50 < 20, fmt(apiWrite.p50)],
  ['no errors under load', staticRes.errors + apiRead.errors + apiWrite.errors === 0, `${staticRes.errors + apiRead.errors + apiWrite.errors} errors`],
  ['one app process, not a leak', health.apps === 1, `${health.apps} running`],
];
console.log('');
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} ${detail}`);
}
for (const r of [staticRes, apiRead, apiWrite]) if (r.errorSamples.length) console.log('  error samples:', r.errorSamples);
process.exit(failed ? 1 : 0);
