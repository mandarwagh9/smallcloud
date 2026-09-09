// GET  api/entries        -> the last 200 entries, newest first
// POST api/entries {text}  -> add one for today
//
// Shows the two things a shared tool almost always needs: who is writing, and a day boundary.
// ctx.user is null only when the app is shared `public` and the reader never signed in.

function setup(ctx) {
  ctx.db.exec(`create table if not exists entries (
    id integer primary key autoincrement,
    day text not null,
    who text not null,
    text text not null,
    at integer not null
  )`);
  ctx.db.exec('create index if not exists entries_day on entries (day)');
}

const today = () => new Date().toISOString().slice(0, 10);

export default async function (req, ctx) {
  setup(ctx);
  const who = ctx.user ? ctx.user.email : 'anonymous';

  if (req.method === 'POST') {
    const { text } = req.json() ?? {};
    const clean = String(text ?? '').trim();
    if (!clean) return { status: 400, json: { error: 'say something first' } };
    ctx.db.run('insert into entries (day, who, text, at) values (?, ?, ?, ?)', today(), who, clean.slice(0, 2000), Date.now());
    ctx.log(`${who} posted a standup entry`);
  }

  const rows = ctx.db.all('select * from entries order by id desc limit 200');
  // group by day so the frontend does not have to
  const days = [];
  for (const r of rows) {
    if (!days.length || days[days.length - 1].day !== r.day) days.push({ day: r.day, entries: [] });
    days[days.length - 1].entries.push(r);
  }
  return { json: { you: ctx.user ? ctx.user.email : null, today: today(), days } };
}
