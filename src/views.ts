import { escapeHtml } from './httputil.js';
import type { AppRecord, Share, User } from './types.js';

// Type is loaded from Google Fonts, matching the design system: an editorial serif masthead
// (Instrument Serif) over a technical body (Space Grotesk) and a monospace for anything the
// machine touches (Space Mono). Each family carries a real fallback stack in the CSS below,
// so the pages stay legible if the font host is blocked.
const FONTS =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap';

const CSS = `
:root {
  --paper: #f0ece1;
  --paper-2: #e7e0cf;
  --card: #f7f4ec;
  --ink: #1c1a16;
  --ink-2: #5c574c;
  --faint: #8a8474;
  --line: #d8d0bd;
  --line-2: #c7bda6;
  --brand: #d94f27;
  --brand-ink: #b23c18;
  --brand-soft: #f3ddd0;
  --live: #1f6f4f;
  --live-ink: #175a40;
  --live-soft: #dce8de;
  --danger: #8f2d2d;
  --btn-fg: #fbf3ec;
  --term-bg: #17150f;
  --radius: 4px;
  --serif: "Instrument Serif", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --sans: "Space Grotesk", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  --mono: "Space Mono", ui-monospace, "Cascadia Mono", SFMono-Regular, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #17150f;
    --paper-2: #211d15;
    --card: #201c15;
    --ink: #ece5d6;
    --ink-2: #a89f8c;
    --faint: #7c745f;
    --line: #332d21;
    --line-2: #423a28;
    --brand: #e86a43;
    --brand-ink: #f0895f;
    --brand-soft: #3a2016;
    --live: #5fd0a2;
    --live-ink: #5fd0a2;
    --live-soft: #16342a;
    --danger: #e0846b;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #17150f;
  --paper-2: #211d15;
  --card: #201c15;
  --ink: #ece5d6;
  --ink-2: #a89f8c;
  --faint: #7c745f;
  --line: #332d21;
  --line-2: #423a28;
  --brand: #e86a43;
  --brand-ink: #f0895f;
  --brand-soft: #3a2016;
  --live: #5fd0a2;
  --live-ink: #5fd0a2;
  --live-soft: #16342a;
  --danger: #e0846b;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 16px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--brand-ink); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 2px; }
.wrap { max-width: 720px; margin: 0 auto; padding: 24px 26px 84px; }
.wrap.wide { max-width: 900px; }
header.bar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding-bottom: 16px; margin-bottom: 8px; border-bottom: 1px solid var(--line);
}
header.bar .brand {
  display: inline-flex; align-items: center; gap: 9px;
  font: 700 16px/1 var(--mono); letter-spacing: -0.02em; color: var(--ink);
}
header.bar .brand:hover { text-decoration: none; }
header.bar .brand .mk { width: 18px; height: 18px; color: var(--brand); }
header.bar nav { margin-left: auto; display: flex; align-items: center; gap: 18px; font-size: 13.5px; }
header.bar nav .em { color: var(--faint); font-family: var(--mono); font-size: 12.5px; }
h1 { font: 400 46px/1.02 var(--serif); letter-spacing: -0.01em; margin: 30px 0 0; text-wrap: balance; }
h1.hero { font-size: 72px; line-height: 0.98; max-width: 13ch; margin-top: 36px; }
h2 {
  font: 500 12px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint); margin: 44px 0 14px; display: flex; align-items: center; gap: 10px;
}
h2 .tick { width: 14px; height: 2px; background: var(--brand); display: inline-block; }
p { margin: 14px 0 0; }
p.lede { font-size: 19px; line-height: 1.5; color: var(--ink-2); margin: 14px 0 0; max-width: 48ch; }
.serif { font-family: var(--serif); }
.mono { font-family: var(--mono); font-size: 0.9em; }
.muted { color: var(--ink-2); }
.faint { color: var(--faint); }
.meta { font: 400 13px/1.6 var(--mono); color: var(--faint); margin: 14px 0 0; }
label { display: block; font: 500 13px/1 var(--sans); margin: 0 0 8px; color: var(--ink-2); }
input[type=text], input[type=email], select, textarea {
  width: 100%; padding: 11px 13px; font: 400 15px/1.4 var(--sans);
  color: var(--ink); background: var(--card);
  border: 1.5px solid var(--line-2); border-radius: var(--radius);
}
input::placeholder { color: var(--faint); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--brand); }
.row-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.row-form > * { flex: 1 1 180px; }
.row-form > button, .row-form > .btn { flex: 0 0 auto; }
button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 11px 17px; font: 500 14.5px/1 var(--sans); white-space: nowrap;
  color: var(--btn-fg); background: var(--brand);
  border: 1.5px solid transparent; border-radius: var(--radius); cursor: pointer;
}
button:hover, .btn:hover { background: var(--brand-ink); text-decoration: none; }
button svg, .btn svg { width: 15px; height: 15px; }
button.ghost, .btn.ghost { background: transparent; color: var(--ink); border-color: var(--line-2); }
button.ghost:hover, .btn.ghost:hover { background: transparent; border-color: var(--ink); }
button.danger, .btn.danger { background: transparent; color: var(--danger); border-color: var(--line-2); }
button.danger:hover, .btn.danger:hover { background: transparent; border-color: var(--danger); }
button.small, .btn.small { padding: 6px 12px; font-size: 13px; }
ul.apps { list-style: none; margin: 16px 0 0; padding: 0; border-top: 1.5px solid var(--ink); }
ul.apps li { display: flex; align-items: center; gap: 14px; padding: 16px 2px; border-bottom: 1px solid var(--line); }
ul.apps .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--live); flex: 0 0 auto; }
ul.apps .dot.idle { background: var(--faint); }
ul.apps .name { font: 400 18px/1.2 var(--sans); }
ul.apps .name a { color: var(--ink); }
ul.apps .slug { font-family: var(--mono); font-size: 12.5px; color: var(--faint); }
ul.apps .right { margin-left: auto; display: flex; align-items: center; gap: 16px; font-size: 13px; color: var(--ink-2); }
ul.apps .ver { font-family: var(--mono); font-size: 12px; color: var(--faint); }
.tag {
  display: inline-flex; align-items: center; gap: 6px;
  font: 500 10.5px/1 var(--mono); letter-spacing: 0.09em; text-transform: uppercase;
  padding: 5px 9px; border-radius: 3px; background: var(--brand-soft); color: var(--brand-ink);
}
.tag.live { background: var(--live-soft); color: var(--live-ink); }
.tag.muted { background: transparent; color: var(--faint); border: 1px solid var(--line-2); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 5px; padding: 20px 22px; }
table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
th { text-align: left; font: 500 11px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); padding: 0 10px 12px 0; }
td { padding: 12px 10px 12px 0; border-top: 1px solid var(--line); vertical-align: baseline; }
td.actions { text-align: right; }
td.who { font-family: var(--mono); font-size: 13.5px; }
pre.logs {
  background: var(--term-bg); color: #d7d0c2; border-radius: 5px;
  padding: 15px 18px; overflow-x: auto; font: 400 12.5px/1.8 var(--mono);
  margin: 0; white-space: pre; max-height: 360px;
}
pre.logs .t { color: #6f6a5c; }
pre.logs .err { color: #f0895f; }
code.copy {
  display: block; white-space: pre; font-family: var(--mono); font-size: 13px; line-height: 1.8;
  background: var(--card); border: 1px solid var(--line); border-radius: 5px;
  padding: 14px 16px; overflow-x: auto; color: var(--ink);
}
code.copy .c { color: var(--faint); }
pre.term {
  background: var(--term-bg); color: #e9e2d4; border-radius: 5px; overflow-x: auto;
  font: 400 13.5px/1.85 var(--mono); margin: 0; padding: 16px 18px; white-space: pre;
}
pre.term .c { color: #8f897a; }
pre.term .g { color: #7fc9a6; }
pre.term .o { color: #f0895f; }
.urlbox {
  display: flex; align-items: center; gap: 12px; background: var(--card);
  border: 1px solid var(--line); border-radius: 5px; padding: 13px 15px;
  font: 400 14px/1 var(--mono); margin: 22px 0 0;
}
.urlbox a { color: var(--ink); }
.notice {
  border: 1px solid var(--line-2); border-left: 3px solid var(--brand); background: var(--card);
  border-radius: var(--radius); padding: 14px 16px; margin: 22px 0 0; font-size: 14.5px; color: var(--ink-2);
}
.notice.bad { border-left-color: var(--danger); }
.notice .h { font-weight: 500; color: var(--ink); }
.notice .lk { display: block; margin-top: 8px; font-family: var(--mono); font-size: 13px; color: var(--brand-ink); word-break: break-all; }
.notes { list-style: none; margin: 14px 0 0; padding: 0; }
.notes li { display: flex; gap: 13px; align-items: baseline; padding: 12px 0; border-top: 1px solid var(--line); }
.notes li:first-child { border-top: 0; }
.notes .no { font: 400 15px/1 var(--mono); color: var(--brand-ink); flex: 0 0 auto; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 34px; }
.empty { padding: 28px 0; color: var(--faint); border-top: 1.5px solid var(--ink); margin-top: 16px; }
footer {
  margin-top: 52px; padding-top: 18px; border-top: 1.5px solid var(--ink);
  display: flex; gap: 14px; align-items: baseline; font-size: 12.5px; color: var(--faint);
}
footer a { color: var(--ink-2); }
@media (max-width: 640px) {
  h1 { font-size: 36px; }
  h1.hero { font-size: 46px; }
  .grid2 { grid-template-columns: 1fr; gap: 22px; }
  p.lede { font-size: 17px; }
  .urlbox a { overflow-wrap: anywhere; }
}
/* On a phone the app-list row can't hold name, slug and the status group on one
   line, so let the status group (tag, version, manage) drop beneath the name. */
@media (max-width: 480px) {
  ul.apps li { flex-wrap: wrap; row-gap: 8px; }
  ul.apps .right { margin-left: 0; width: 100%; }
}
`;

const MARK =
  '<svg class="mk" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="15" height="15" rx="2"></rect><rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor" stroke="none"></rect></svg>';
const ARROW =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10h11M11 6l4 4-4 4"></path></svg>';

export function layout(title: string, body: string, opts: { user?: User | null; wide?: boolean } = {}): string {
  const nav = opts.user
    ? `<nav><a href="/me">apps</a><a href="/me/tokens">tokens</a><span class="em">${escapeHtml(opts.user.email)}</span><a href="/logout">sign out</a></nav>`
    : '<nav><a href="/login">sign in</a></nav>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap${opts.wide ? ' wide' : ''}">
<header class="bar"><a class="brand" href="/">${MARK}smallcloud</a>${nav}</header>
${body}
<footer><a class="brand" href="/" style="color:var(--faint)">smallcloud</a><span>a cloud for small software</span><span style="margin-left:auto"><a href="/v1/contract">app contract</a></span></footer>
</div>
</body>
</html>`;
}

export function renderLanding(baseUrl: string, signedIn: boolean): string {
  const url = escapeHtml(baseUrl);
  return layout(
    'smallcloud',
    `<h1 class="hero">A cloud for small software.</h1>
<p class="lede serif" style="font-size:21px">Your agent hands this server a folder. It hands back a link you can send to someone. Hosting, a database, file storage, sign&#8209;in and sharing are already there.</p>
<p style="margin-top:26px"><a class="btn" href="${signedIn ? '/me' : '/login'}">${signedIn ? 'Open your dashboard' : 'Sign in with your email'} ${ARROW}</a></p>

<h2><span class="tick"></span>Ship something</h2>
<pre class="term"><span class="c"># three lines from folder to a link you can send</span>
npx smallcloud login ${url}
npx smallcloud deploy ./standup
<span class="c">#</span> <span class="o">&#8594;</span> <span class="g">${url}/a/standup</span></pre>

<h2><span class="tick"></span>What an app looks like</h2>
<code class="copy">standup/
  app.json            <span class="c">{"name": "Standup Notes"}</span>
  public/index.html   <span class="c">the frontend</span>
  api/notes.js        <span class="c">export default (req, ctx) =&gt; ({ json: ctx.db.all('select * from notes') })</span></code>
<p class="muted" style="margin-top:14px">No Dockerfile, no database to provision, no auth library. Read the full <a href="/v1/contract">app contract</a> &mdash; it is the only document an agent needs.</p>

<h2><span class="tick"></span>What it deliberately is not</h2>
<ul class="notes">
  <li><span class="no">no</span><span>Not a scale&#8209;out cloud. It is for software that will only ever have a few users.</span></li>
  <li><span class="no">no</span><span>Not a place to let strangers deploy code. Open it only to people you would hand a shell.</span></li>
  <li><span class="no">no</span><span>No lock&#8209;in. <span class="mono">smallcloud export</span> hands back your source, database and files.</span></li>
</ul>

<h2><span class="tick"></span>${signedIn ? 'Your apps' : 'Get in'}</h2>
<p><a class="btn" href="${signedIn ? '/me' : '/login'}">${signedIn ? 'Open your dashboard' : 'Sign in with your email'} ${ARROW}</a></p>`,
    { user: null },
  );
}

export function renderLogin(next: string, error?: string): string {
  return layout(
    'Sign in',
    `<h1>Sign in.</h1>
<p class="lede">Enter your email and we will send you a link. No password.</p>
${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/login" class="row-form" style="margin-top:26px">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="email" name="email" placeholder="you@example.com" required autofocus autocomplete="email">
  <button type="submit">Email me a link ${ARROW}</button>
</form>
<p class="faint" style="font-size:13.5px;margin-top:18px">The link works once and expires in 15 minutes. New here? Signing in creates your account.</p>`,
  );
}

export function renderCheckEmail(email: string, devLink?: string): string {
  return layout(
    'Check your email',
    `<h1>Check your email.</h1>
<p class="lede">We sent a sign&#8209;in link to <span class="mono">${escapeHtml(email)}</span>. It works once and expires in 15 minutes.</p>
${devLink ? `<div class="notice"><span class="h">Development mode</span> &mdash; no email provider is configured, so here is the link.<a class="lk" href="${escapeHtml(devLink)}">${escapeHtml(devLink)}</a></div>` : ''}`,
  );
}

export function renderDashboard(user: User, apps: Array<AppRecord & { relation: 'owner' | 'shared'; url: string; shares: number }>): string {
  const rows = apps
    .map(
      (a) => `<li>
  <span class="dot${a.relation === 'shared' ? ' idle' : ''}"></span>
  <span class="name"><a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></span>
  <span class="slug">/a/${escapeHtml(a.slug)}</span>
  <span class="right">
    ${a.relation === 'shared' ? '<span class="tag muted">shared with you</span>' : a.shares > 0 ? `<span class="tag">shared &times;${a.shares}</span>` : '<span class="tag muted">private</span>'}
    <span class="ver">v${a.version}</span>
    <a href="/apps/${escapeHtml(a.id)}">${a.relation === 'shared' ? 'open' : 'manage'}</a>
  </span>
</li>`,
    )
    .join('\n');
  return layout(
    'Your apps',
    `<h1>Your apps.</h1>
<p class="lede">${apps.length ? 'Everything you own or that has been shared with you.' : 'Nothing here yet.'}</p>
${
  apps.length
    ? `<ul class="apps">${rows}</ul>`
    : `<div class="empty">Deploy your first app with <span class="mono">smallcloud deploy ./my-app</span>, or point your agent at the <a href="/v1/contract">app contract</a>.</div>`
}`,
    { user },
  );
}

export function renderManage(
  user: User,
  app: AppRecord,
  url: string,
  shares: Share[],
  secretKeys: string[],
  logs: Array<{ at: number; level: string; msg: string }>,
  isOwner: boolean,
): string {
  const shareRows = shares.length
    ? shares
        .map(
          (sh) => `<tr>
  <td class="who">${escapeHtml(sh.principal.startsWith('user:') ? sh.principal.slice(5) : sh.principal)}</td>
  <td>${escapeHtml(sh.role)}</td>
  <td class="actions"><form method="post" action="/apps/${escapeHtml(app.id)}/unshare" style="display:inline">
    <input type="hidden" name="principal" value="${escapeHtml(sh.principal)}">
    <button class="danger small" type="submit">Remove</button></form></td>
</tr>`,
        )
        .join('\n')
    : '<tr><td colspan="3" class="faint">Not shared with anyone yet.</td></tr>';

  const logLines = logs.length
    ? logs
        .map((l) => {
          const t = new Date(l.at).toISOString().slice(11, 19);
          const cls = l.level === 'error' ? ' class="err"' : '';
          return `<span class="t">${t}</span>  <span${cls}>${escapeHtml(l.msg)}</span>`;
        })
        .join('\n')
    : '<span class="faint">No log lines yet.</span>';

  return layout(
    app.name,
    `<h1>${escapeHtml(app.name)}</h1>
<p class="lede">${escapeHtml(app.description || 'No description.')}</p>
<div class="urlbox"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></div>
<p class="meta">version ${app.version} &nbsp;&#183;&nbsp; owner ${escapeHtml(app.ownerEmail)} &nbsp;&#183;&nbsp; updated ${escapeHtml(new Date(app.updatedAt).toLocaleString())}</p>

<h2><span class="tick"></span>Who can open it</h2>
<div class="panel">
<table>
  <thead><tr><th>Who</th><th>Role</th><th></th></tr></thead>
  <tbody>${shareRows}</tbody>
</table>
<form method="post" action="/apps/${escapeHtml(app.id)}/share" class="row-form" style="margin-top:18px">
  <input type="text" name="principal" placeholder="bob@example.com, domain:example.com, or public" required>
  <select name="role"><option value="user">user</option><option value="editor">editor</option></select>
  <button type="submit">Share</button>
</form>
</div>

<h2><span class="tick"></span>Secrets</h2>
<div class="panel">
${secretKeys.length ? `<p class="mono" style="margin-top:0">${secretKeys.map(escapeHtml).join(', ')}</p>` : '<p class="faint" style="margin-top:0">None. Secrets appear to the app as <span class="mono">ctx.env.KEY</span>.</p>'}
<form method="post" action="/apps/${escapeHtml(app.id)}/secret" class="row-form" style="margin-top:14px">
  <input type="text" name="key" placeholder="API_KEY" required>
  <input type="text" name="value" placeholder="value" required>
  <button type="submit">Set</button>
</form>
</div>

<h2><span class="tick"></span>Logs</h2>
<pre class="logs">${logLines}</pre>

<h2><span class="tick"></span>Export and delete</h2>
<p style="display:flex;gap:12px;flex-wrap:wrap;align-items:center"><a class="btn ghost" href="/v1/apps/${escapeHtml(app.id)}/export">Download everything (.zip)</a>
${isOwner ? `<form method="post" action="/apps/${escapeHtml(app.id)}/delete" style="display:inline" data-confirm-delete><button class="danger" type="submit">Delete app</button></form>` : ''}</p>
<script>
// The app name is author-controlled, so it never goes into a JS string. It is read from the
// already-escaped DOM at click time instead.
document.querySelectorAll('form[data-confirm-delete]').forEach(function (f) {
  f.addEventListener('submit', function (e) {
    var name = document.querySelector('h1') ? document.querySelector('h1').textContent : 'this app';
    if (!confirm('Delete ' + name + ' and all its data? This cannot be undone.')) e.preventDefault();
  });
});
</script>`,
    { user, wide: true },
  );
}

export function renderTokens(user: User, tokens: Array<{ id: string | null; name: string; createdAt: number; lastUsed: number | null }>, fresh?: string): string {
  const rows = tokens.length
    ? tokens
        .map(
          (t) =>
            `<tr><td class="who">${escapeHtml(t.name)}</td><td class="faint">${escapeHtml(new Date(t.createdAt).toLocaleDateString())}</td><td class="faint">${t.lastUsed ? escapeHtml(new Date(t.lastUsed).toLocaleString()) : 'never used'}</td></tr>`,
        )
        .join('\n')
    : '<tr><td colspan="3" class="faint">No tokens yet.</td></tr>';
  return layout(
    'Agent tokens',
    `<h1>Agent tokens.</h1>
<p class="lede">A token lets an agent or the CLI deploy on your behalf. The usual way to get one is <span class="mono">smallcloud login</span>, which approves itself through this browser.</p>
${fresh ? `<div class="notice"><span class="h">Your new token</span> &mdash; copy it now; it is not shown again.<code class="copy" style="margin-top:10px">${escapeHtml(fresh)}</code></div>` : ''}
<h2><span class="tick"></span>Active tokens</h2>
<div class="panel">
<table><thead><tr><th>Name</th><th>Created</th><th>Last used</th></tr></thead><tbody>${rows}</tbody></table>
<form method="post" action="/me/tokens" class="row-form" style="margin-top:18px">
  <input type="text" name="name" placeholder="my-laptop" required>
  <button type="submit">Create token</button>
</form>
</div>`,
    { user },
  );
}

export function renderCliApprove(user: User, code: string, done: boolean): string {
  return layout(
    'Connect an agent',
    done
      ? `<h1>Connected.</h1><p class="lede">The agent is now signed in as <span class="mono">${escapeHtml(user.email)}</span>. You can close this tab and go back to your terminal.</p>`
      : `<h1>Connect an agent.</h1>
<p class="lede">A command line on this machine is asking to deploy as <span class="mono">${escapeHtml(user.email)}</span>. Approve it only if you started it.</p>
<form method="post" action="/cli/${escapeHtml(code)}" style="margin-top:24px"><button type="submit">Approve</button></form>
<p class="faint" style="font-size:13px;margin-top:20px">An approved token can deploy, read logs and manage sharing for your apps. Revoke it any time from <span class="mono">tokens</span>.</p>`,
    { user },
  );
}

export function renderError(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p><p style="margin-top:22px"><a class="btn ghost" href="/me">Go to your apps</a></p>`);
}
