// GET    api/expenses          -> { you, expenses, settlement }
// POST   api/expenses          -> {what, amount} adds an expense paid by the signed-in person
// DELETE api/expenses/:id      -> remove one (only the person who added it)
//
// Receipts live in api/receipts.js, which stores the bytes with ctx.files.

import { settle, parseAmount } from './_split.js';

function setup(ctx) {
  ctx.db.exec(`create table if not exists expenses (
    id integer primary key autoincrement,
    what text not null,
    cents integer not null,
    who text not null,
    receipt text,
    at integer not null
  )`);
}

export default async function (req, ctx) {
  setup(ctx);
  const who = ctx.user ? ctx.user.email : 'anonymous';
  const id = Number(req.subpath.replace('/', '')) || null;

  if (req.method === 'POST' && !id) {
    const { what, amount } = req.json() ?? {};
    const cents = parseAmount(amount);
    const label = String(what ?? '').trim();
    if (!label) return { status: 400, json: { error: 'what was it for?' } };
    if (cents === null) return { status: 400, json: { error: 'amount must be a positive number' } };
    const row = ctx.db.run('insert into expenses (what, cents, who, at) values (?, ?, ?, ?)', label.slice(0, 200), cents, who, Date.now());
    ctx.log(`${who} added "${label}" for ${(cents / 100).toFixed(2)}`);
    return { json: { ...load(ctx, who), added: row.lastInsertRowid } };
  }

  if (req.method === 'DELETE' && id) {
    const row = ctx.db.get('select who, receipt from expenses where id = ?', id);
    if (!row) return { status: 404, json: { error: 'no such expense' } };
    if (row.who !== who) return { status: 403, json: { error: 'only the person who added it can remove it' } };
    if (row.receipt) ctx.files.delete(row.receipt);
    ctx.db.run('delete from expenses where id = ?', id);
  }

  return { json: load(ctx, who) };
}

function load(ctx, who) {
  const expenses = ctx.db.all('select * from expenses order by id desc');
  return { you: ctx.user ? who : null, expenses, settlement: settle(expenses) };
}
