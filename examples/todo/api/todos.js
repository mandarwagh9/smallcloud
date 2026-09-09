// GET  api/todos      -> list
// POST api/todos      -> {text} adds one
// POST api/todos/:id  -> toggles done
// DELETE api/todos/:id-> removes it

function setup(ctx) {
  ctx.db.exec(`create table if not exists todos (
    id integer primary key autoincrement,
    text text not null,
    done integer not null default 0,
    who text,
    at integer not null
  )`);
}

export default async function (req, ctx) {
  setup(ctx);
  const id = Number(req.subpath.replace('/', '')) || null;
  const who = ctx.user ? ctx.user.email : 'anonymous';

  if (req.method === 'POST' && !id) {
    const { text } = req.json() ?? {};
    if (!text || !String(text).trim()) return { status: 400, json: { error: 'text is required' } };
    ctx.db.run('insert into todos (text, done, who, at) values (?, 0, ?, ?)', String(text).trim().slice(0, 500), who, Date.now());
    ctx.log(`${who} added a todo`);
  } else if (req.method === 'POST' && id) {
    ctx.db.run('update todos set done = 1 - done where id = ?', id);
  } else if (req.method === 'DELETE' && id) {
    ctx.db.run('delete from todos where id = ?', id);
  }

  return { json: { you: who, todos: ctx.db.all('select * from todos order by done, id desc') } };
}
