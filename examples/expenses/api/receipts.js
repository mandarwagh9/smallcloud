// POST api/receipts/:expenseId  -> raw image bytes in the body, stored with ctx.files
// GET  api/receipts/:expenseId  -> the stored image back
//
// The only example that uses ctx.files. Bytes go in with req.bytes() and come back out as a
// Uint8Array return, which smallcloud serves verbatim.

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export default async function (req, ctx) {
  const id = Number(req.subpath.replace('/', '')) || null;
  if (!id) return { status: 400, json: { error: 'name an expense: api/receipts/12' } };

  const expense = ctx.db.get('select id, who, receipt from expenses where id = ?', id);
  if (!expense) return { status: 404, json: { error: 'no such expense' } };

  if (req.method === 'POST') {
    const who = ctx.user ? ctx.user.email : null;
    if (!who) return { status: 401, json: { error: 'sign in to attach a receipt' } };
    if (expense.who !== who) return { status: 403, json: { error: 'only the person who added the expense can attach a receipt' } };

    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = TYPES[type];
    if (!ext) return { status: 415, json: { error: `receipts must be one of: ${Object.keys(TYPES).join(', ')}` } };

    const bytes = req.bytes();
    if (!bytes || !bytes.length) return { status: 400, json: { error: 'the request body was empty' } };
    if (bytes.length > MAX_BYTES) return { status: 413, json: { error: `receipts must be under ${MAX_BYTES / 1024 / 1024} MB` } };

    const name = `receipt-${id}.${ext}`;
    ctx.files.put(name, bytes);
    ctx.db.run('update expenses set receipt = ? where id = ?', name, id);
    ctx.log(`${who} attached ${name} (${bytes.length} bytes)`);
    return { json: { ok: true, receipt: name, bytes: bytes.length } };
  }

  if (!expense.receipt) return { status: 404, json: { error: 'this expense has no receipt' } };
  const data = ctx.files.get(expense.receipt);
  if (!data) return { status: 404, json: { error: 'the receipt file is missing' } };
  const ext = expense.receipt.split('.').pop();
  const type = Object.keys(TYPES).find((t) => TYPES[t] === ext) ?? 'application/octet-stream';
  return { status: 200, headers: { 'content-type': type }, body: data };
}
