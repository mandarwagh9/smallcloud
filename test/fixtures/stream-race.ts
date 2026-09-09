/**
 * Run as a child process by test/security.test.ts with UV_THREADPOOL_SIZE=1.
 *
 * Widens a window that already exists rather than inventing one: a static request passes
 * existsSync/statSync on the main thread, then queues its open on the (single) threadpool
 * thread. A concurrent redeploy that drops the file makes that open fail with ENOENT. If the
 * read stream has no 'error' listener, the whole control plane dies.
 *
 * Prints SURVIVED or CRASHED and exits 0/1.
 */
import { pbkdf2 } from 'node:crypto';
import { startHarness, deploy, bundle } from '../helpers.js';

const h = await startHarness();
const token = h.tokenFor('owner@example.com');

const withFile = bundle({
  'app.json': '{"name":"race"}',
  'public/index.html': 'hi',
  'public/big.bin': 'x'.repeat(400_000),
});
const withoutFile = bundle({ 'app.json': '{"name":"race"}', 'public/index.html': 'hi' });

const app = await deploy(h, token, withFile);

// Occupy the one threadpool thread so the reads below queue behind it.
for (let i = 0; i < 4; i++) pbkdf2('p', 's', 400_000, 64, 'sha512', () => {});

// These pass existsSync/statSync immediately, then wait for a threadpool slot to open().
const inflight = Array.from({ length: 25 }, () =>
  h
    .fetch(`/a/${app.slug}/big.bin`, { token })
    .then((r) => r.status)
    .catch(() => 'threw'),
);

// Pull the file out from under them.
await deploy(h, token, withoutFile, app.id);

const statuses = await Promise.all(inflight);
const health = await h.json('/health');

if (health.status !== 200 || health.body.ok !== true) {
  console.log('CRASHED: health check failed after the race');
  process.exit(1);
}
console.log(`SURVIVED statuses=${[...new Set(statuses)].join(',')}`);
await h.close();
process.exit(0);
