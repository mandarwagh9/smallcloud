import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPlatformDb } from '../src/db.js';
import { canManage, canUse, parsePrincipal, parseRole, roleFor, setShare, removeShare, listShares } from '../src/shares.js';
import type { AppRecord, EffectiveRole, Principal, Role } from '../src/types.js';

const app: AppRecord = {
  id: 'app1',
  slug: 'app1',
  name: 'App',
  description: '',
  ownerEmail: 'owner@acme.com',
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

function db() {
  return openPlatformDb(':memory:');
}

test('parsePrincipal understands every accepted form', () => {
  assert.equal(parsePrincipal('public'), 'public');
  assert.equal(parsePrincipal('bob@example.com'), 'user:bob@example.com');
  assert.equal(parsePrincipal('user:Bob@Example.com'), 'user:bob@example.com');
  assert.equal(parsePrincipal('domain:example.com'), 'domain:example.com');
  assert.equal(parsePrincipal('example.com'), 'domain:example.com');
  for (const bad of ['', 'nonsense', 'user:notanemail', 'domain:has@at']) {
    assert.throws(() => parsePrincipal(bad), /should be|is not/, `${bad} should be rejected`);
  }
});

test('parseRole defaults to user and rejects anything else', () => {
  assert.equal(parseRole(undefined), 'user');
  assert.equal(parseRole('editor'), 'editor');
  assert.throws(() => parseRole('admin'), /role must be/);
});

// The full truth table. Every row here is a decision the platform makes on every request.
const MATRIX: Array<{ shares: Array<[Principal, Role]>; who: string | null; expect: EffectiveRole | null }> = [
  { shares: [], who: 'owner@acme.com', expect: 'owner' },
  { shares: [], who: 'OWNER@ACME.COM', expect: 'owner' }, // email comparison is case-insensitive
  { shares: [], who: 'stranger@else.com', expect: null },
  { shares: [], who: null, expect: null },

  { shares: [['user:bob@else.com', 'user']], who: 'bob@else.com', expect: 'user' },
  { shares: [['user:bob@else.com', 'editor']], who: 'bob@else.com', expect: 'editor' },
  { shares: [['user:bob@else.com', 'user']], who: 'eve@else.com', expect: null },
  { shares: [['user:bob@else.com', 'user']], who: null, expect: null },

  { shares: [['domain:acme.com', 'user']], who: 'someone@acme.com', expect: 'user' },
  { shares: [['domain:acme.com', 'user']], who: 'someone@other.com', expect: null },
  { shares: [['domain:acme.com', 'editor']], who: 'someone@acme.com', expect: 'editor' },

  { shares: [['public', 'user']], who: null, expect: 'user' },
  { shares: [['public', 'user']], who: 'anyone@anywhere.com', expect: 'user' },

  // the most generous matching share wins
  {
    shares: [
      ['public', 'user'],
      ['user:bob@else.com', 'editor'],
    ],
    who: 'bob@else.com',
    expect: 'editor',
  },
  {
    shares: [
      ['domain:acme.com', 'editor'],
      ['user:bob@acme.com', 'user'],
    ],
    who: 'bob@acme.com',
    expect: 'editor',
  },
  // the owner is always the owner, whatever else is set
  { shares: [['public', 'editor']], who: 'owner@acme.com', expect: 'owner' },
];

test('roleFor resolves the full sharing matrix', () => {
  for (const row of MATRIX) {
    const d = db();
    for (const [p, r] of row.shares) setShare(d, app.id, p, r);
    const got = roleFor(d, app, row.who ? { email: row.who } : null);
    assert.equal(got, row.expect, `shares=${JSON.stringify(row.shares)} who=${row.who} -> expected ${row.expect}, got ${got}`);
    d.close();
  }
});

test('canUse and canManage follow from the role', () => {
  assert.equal(canUse(null), false);
  assert.equal(canUse('user'), true);
  assert.equal(canUse('editor'), true);
  assert.equal(canUse('owner'), true);
  assert.equal(canManage(null), false);
  assert.equal(canManage('user'), false);
  assert.equal(canManage('editor'), true);
  assert.equal(canManage('owner'), true);
});

test('setShare updates in place and removeShare reports whether it existed', () => {
  const d = db();
  setShare(d, app.id, 'user:bob@x.com', 'user');
  setShare(d, app.id, 'user:bob@x.com', 'editor');
  assert.equal(listShares(d, app.id).length, 1);
  assert.equal(listShares(d, app.id)[0].role, 'editor');
  assert.equal(removeShare(d, app.id, 'user:bob@x.com'), true);
  assert.equal(removeShare(d, app.id, 'user:bob@x.com'), false);
  d.close();
});
