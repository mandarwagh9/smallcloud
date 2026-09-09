import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Apps, normalizePath, slugify } from '../src/apps.js';
import { openPlatformDb } from '../src/db.js';
import { encrypt, decrypt, sign, verify } from '../src/crypto.js';
import { zip } from '../src/zip.js';
import type { AppFile } from '../src/types.js';

function withApps<T>(fn: (apps: Apps, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sc-apps-'));
  const db = openPlatformDb(join(dir, 'platform.db'));
  try {
    return fn(new Apps(db, dir, 'secret'), dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok: AppFile[] = [
  { path: 'app.json', content: '{"name":"My App"}' },
  { path: 'public/index.html', content: '<h1>hi</h1>' },
  { path: 'api/things.js', content: 'export default () => ({json:{}})' },
];

test('normalizePath accepts ordinary bundle paths', () => {
  for (const p of ['app.json', 'public/index.html', 'api/todos.js', 'public/assets/logo.svg', 'README.md']) {
    assert.equal(normalizePath(p), p, `${p} should be accepted`);
  }
  assert.equal(normalizePath('./app.json'), 'app.json');
  assert.equal(normalizePath('public\\index.html'), 'public/index.html');
});

test('normalizePath rejects traversal and absolute paths', () => {
  for (const p of ['../x', 'a/../../b', '/etc/passwd', 'C:\\x', '', 'a//b', 'a/./b']) {
    assert.equal(normalizePath(p), null, `${p} should be rejected`);
  }
});

test('slugify makes url-safe names', () => {
  assert.equal(slugify('My Todo App!'), 'my-todo-app');
  assert.equal(slugify('  Expenses / 2026  '), 'expenses-2026');
  assert.equal(slugify('!!!'), '');
});

test('validate accepts a well-formed bundle', () => {
  withApps((apps) => {
    const out = apps.validate(ok);
    assert.equal(out.manifest.name, 'My App');
    assert.equal(out.files.length, 3);
  });
});

test('validate rejects bundles an agent can fix, with a message saying how', () => {
  withApps((apps) => {
    const cases: Array<[AppFile[], string]> = [
      [[], 'empty'],
      [[{ path: 'public/index.html', content: 'x' }], 'no_manifest'],
      [[{ path: 'app.json', content: 'not json' }], 'bad_manifest'],
      [[{ path: 'app.json', content: '{"description":"no name"}' }], 'bad_manifest'],
      [[{ path: 'app.json', content: '{"name":"x"}' }], 'nothing_to_serve'],
      [[{ path: 'app.json', content: '{"name":"x"}' }, { path: 'src/index.js', content: 'x' }], 'bad_path'],
      [[{ path: 'app.json', content: '{"name":"x"}' }, { path: 'api/nested/route.js', content: 'x' }], 'bad_path'],
      [[{ path: 'app.json', content: '{"name":"x"}' }, { path: 'api/route.ts', content: 'x' }], 'bad_path'],
      [[...ok, { path: 'app.json', content: '{"name":"dup"}' }], 'dup_path'],
    ];
    for (const [files, code] of cases) {
      assert.throws(
        () => apps.validate(files),
        (err: any) => {
          assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
          assert.ok(err.message.length > 10, 'error messages must tell the agent what to change');
          return true;
        },
      );
    }
  });
});

test('validate enforces the size limit', () => {
  withApps((apps) => {
    const big = [...ok, { path: 'public/big.txt', content: 'x'.repeat(6 * 1024 * 1024) }];
    assert.throws(() => apps.validate(big), /exceeds/);
  });
});

test('deploy then redeploy keeps id, slug and data; version increments', () => {
  withApps((apps) => {
    const user = { email: 'a@b.com' };
    const first = apps.deploy(user, ok);
    assert.equal(first.version, 1);
    assert.equal(first.slug, 'my-app');

    const second = apps.deploy(user, [{ path: 'app.json', content: '{"name":"My App"}' }, { path: 'public/index.html', content: '<h1>v2</h1>' }], first.id);
    assert.equal(second.id, first.id);
    assert.equal(second.slug, first.slug);
    assert.equal(second.version, 2);

    const source = apps.source(first.id);
    assert.equal(source.find((f) => f.path === 'public/index.html')?.content, '<h1>v2</h1>');
    assert.equal(source.find((f) => f.path === 'api/things.js'), undefined, 'removed files should be gone after redeploy');
    assert.ok(!source.some((f) => f.path === 'package.json'), 'the generated package.json is not part of the source');
  });
});

test('slugs are unique across apps with the same name', () => {
  withApps((apps) => {
    const u = { email: 'a@b.com' };
    assert.equal(apps.deploy(u, ok).slug, 'my-app');
    assert.equal(apps.deploy(u, ok).slug, 'my-app-2');
    assert.equal(apps.deploy(u, ok).slug, 'my-app-3');
  });
});

test('secrets round-trip, list by key only, and can be removed', () => {
  withApps((apps) => {
    const app = apps.deploy({ email: 'a@b.com' }, ok);
    apps.setSecret(app.id, 'API_KEY', 'shh-1234');
    assert.deepEqual(apps.secretKeys(app.id), ['API_KEY']);
    assert.equal(apps.env(app.id).API_KEY, 'shh-1234');
    assert.throws(() => apps.setSecret(app.id, 'lower case', 'x'), /upper snake case/);
    assert.equal(apps.deleteSecret(app.id, 'API_KEY'), true);
    assert.deepEqual(apps.secretKeys(app.id), []);
  });
});

test('logs keep the most recent lines', () => {
  withApps((apps) => {
    const app = apps.deploy({ email: 'a@b.com' }, ok);
    for (let i = 0; i < 520; i++) apps.log(app.id, 'info', `line ${i}`);
    const logs = apps.logs(app.id, 500);
    assert.ok(logs.length <= 500);
    assert.equal(logs.at(-1)?.msg, 'line 519');
  });
});

test('listFor separates owned from shared', () => {
  withApps((apps, dir) => {
    const db = openPlatformDb(join(dir, 'platform.db'));
    const mine = apps.deploy({ email: 'me@x.com' }, ok);
    const theirs = apps.deploy({ email: 'you@y.com' }, [{ path: 'app.json', content: '{"name":"Yours"}' }, { path: 'public/index.html', content: 'y' }]);
    db.prepare('insert into shares (app_id, principal, role) values (?, ?, ?)').run(theirs.id, 'user:me@x.com', 'user');
    const list = apps.listFor({ email: 'me@x.com' });
    assert.equal(list.length, 2);
    assert.equal(list.find((a) => a.id === mine.id)?.relation, 'owner');
    assert.equal(list.find((a) => a.id === theirs.id)?.relation, 'shared');
    db.close();
  });
});

test('crypto: signatures verify and tampering is rejected', () => {
  const signed = sign('k', 'hello');
  assert.equal(verify('k', signed), 'hello');
  assert.equal(verify('k', signed.slice(0, -1) + 'x'), null);
  assert.equal(verify('other-key', signed), null);
  assert.equal(verify('k', 'nosignature'), null);
});

test('crypto: secrets encrypt and decrypt', () => {
  const blob = encrypt('key', 'a value with unicode: ✓');
  assert.notEqual(blob, 'a value with unicode: ✓');
  assert.equal(decrypt('key', blob), 'a value with unicode: ✓');
});

test('zip writes a readable archive header', () => {
  const buf = zip([{ path: 'a.txt', data: Buffer.from('hello') }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header magic');
  assert.ok(buf.includes(Buffer.from('a.txt')));
  assert.ok(buf.includes(Buffer.from('hello')));
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'end of central directory magic');
});

// The contract is the only document an agent reads, and a "contract-truth" auditor already
// found one place where it promised something the code did not do. These pin the specific
// claims most likely to drift: what an app may set, and what a path segment may contain.
test('the contract lists exactly the response headers the code allows', async () => {
  const { CONTRACT } = await import('../src/contract.js');
  const { APP_HEADER_ALLOWLIST } = await import('../src/server.js');

  const section = CONTRACT.slice(CONTRACT.indexOf('**Headers you may set.**'));
  const documented = new Set(
    [...section.slice(0, section.indexOf('Anything else')).matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((h) => h !== 'x-'),
  );

  for (const h of APP_HEADER_ALLOWLIST) {
    assert.ok(documented.has(h), `the code allows "${h}" but the contract does not mention it`);
  }
  for (const h of documented) {
    assert.ok(APP_HEADER_ALLOWLIST.has(h), `the contract promises "${h}" but the code drops it`);
  }
  assert.match(section, /cannot set `set-cookie`/, 'the contract must say why set-cookie is refused');
});

test('the contract warns that a path segment cannot contain a separator', async () => {
  const { CONTRACT } = await import('../src/contract.js');
  assert.match(CONTRACT, /encoded separator/, 'agents need to know an encoded slash is rejected');
  assert.match(CONTRACT, /percent-decoded/, 'and that segments are decoded');
});

test('AGENTS.md is in sync with the contract it is generated from', async () => {
  const { CONTRACT } = await import('../src/contract.js');
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const path = join(repo, 'AGENTS.md');
  assert.ok(existsSync(path), 'AGENTS.md should exist; run: npm run agents');
  // It is written by `npm run agents`, so it drifts the moment someone edits contract.ts and
  // forgets. Compare ignoring line endings, since git normalises them on this repo.
  const onDisk = readFileSync(path, 'utf8').split('\r\n').join('\n');
  assert.equal(onDisk.trim(), CONTRACT.trim(), 'AGENTS.md is stale; run: npm run agents');
});
