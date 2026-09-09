import { escapeHtml } from './httputil.js';
import type { AppRecord, Share, User } from './types.js';

const FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:ital,wght@0,400;0,600;1,400&display=swap';

const CSS = `
:root {
  --ground: #f4f5f3;
  --panel: #ffffff;
  --ink: #16181b;
  --muted: #63696e;
  --line: #dcdedb;
  --accent: #3340d8;
  --accent-soft: #eceefc;
  --live: #0f6f5c;
  --live-soft: #e4f2ee;
  --warn: #9a3412;
  --radius: 6px;
  --sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --serif: "IBM Plex Serif", Georgia, "Times New Roman", serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #121417;
    --panel: #1a1d21;
    --ink: #e8eaec;
    --muted: #969ba1;
    --line: #2b2f34;
    --accent: #8f9bff;
    --accent-soft: #23283f;
    --live: #5fd0b4;
    --live-soft: #14312a;
    --warn: #f0a480;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --ground: #121417;
  --panel: #1a1d21;
  --ink: #e8eaec;
  --muted: #969ba1;
  --line: #2b2f34;
  --accent: #8f9bff;
  --accent-soft: #23283f;
  --live: #5fd0b4;
  --live-soft: #14312a;
  --warn: #f0a480;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font: 400 15px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.wrap { max-width: 720px; margin: 0 auto; padding: 28px 20px 72px; }
.wrap.wide { max-width: 900px; }
header.bar {
  display: flex; align-items: baseline; gap: 14px;
  padding-bottom: 14px; margin-bottom: 26px; border-bottom: 1px solid var(--line);
}
header.bar .brand { font-family: var(--mono); font-weight: 500; letter-spacing: -0.02em; color: var(--ink); }
header.bar .brand:hover { text-decoration: none; }
header.bar nav { margin-left: auto; display: flex; gap: 16px; font-size: 13.5px; }
header.bar nav span { color: var(--muted); }
h1 { font: 600 27px/1.2 var(--sans); letter-spacing: -0.02em; margin: 0 0 6px; text-wrap: balance; }
h2 { font: 600 15px/1.3 var(--sans); margin: 30px 0 10px; letter-spacing: -0.01em; }
p { margin: 0 0 14px; }
p.lede { color: var(--muted); margin-bottom: 26px; }
.mono { font-family: var(--mono); font-size: 0.92em; }
.muted { color: var(--muted); }
label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
input[type=text], input[type=email], select, textarea {
  width: 100%; padding: 9px 11px; font: 400 14.5px/1.4 var(--sans);
  color: var(--ink); background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--radius);
}
input:focus, select:focus { border-color: var(--accent); }
.row-form { display: flex; gap: 8px; flex-wrap: wrap; }
.row-form > * { flex: 1 1 160px; }
.row-form > button { flex: 0 0 auto; }
button, .btn {
  display: inline-block; padding: 9px 15px; font: 500 14px/1.2 var(--sans);
  color: #fff; background: var(--accent); border: 1px solid transparent;
  border-radius: var(--radius); cursor: pointer;
}
button:hover, .btn:hover { filter: brightness(1.08); text-decoration: none; }
button.ghost, .btn.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
button.danger { background: transparent; color: var(--warn); border-color: var(--line); }
/* app rows: index cards, not boxes */
ul.apps { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
ul.apps li { display: flex; align-items: baseline; gap: 12px; padding: 13px 2px; border-bottom: 1px solid var(--line); }
ul.apps .name { font-weight: 500; }
ul.apps .slug { font-family: var(--mono); font-size: 12.5px; color: var(--muted); }
ul.apps .right { margin-left: auto; display: flex; align-items: baseline; gap: 14px; font-size: 13px; }
.tag {
  font: 500 11px/1 var(--sans); letter-spacing: 0.05em; text-transform: uppercase;
  padding: 4px 7px; border-radius: 4px; background: var(--accent-soft); color: var(--accent);
}
.tag.live { background: var(--live-soft); color: var(--live); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font: 500 11.5px/1 var(--sans); letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); padding: 0 8px 8px 0; }
td { padding: 9px 8px 9px 0; border-top: 1px solid var(--line); vertical-align: baseline; }
td.actions { text-align: right; }
pre.logs {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 14px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
  max-height: 340px; margin: 0;
}
pre.logs .err { color: var(--warn); }
.notice { padding: 11px 14px; border-radius: var(--radius); background: var(--accent-soft); color: var(--ink); margin-bottom: 20px; font-size: 14px; }
.notice.bad { background: var(--live-soft); }
code.copy {
  display: block; white-space: pre; font-family: var(--mono); font-size: 13px; line-height: 1.7;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 11px 13px; overflow-x: auto;
}
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.empty { padding: 30px 0; color: var(--muted); }
`;

export function layout(title: string, body: string, opts: { user?: User | null; wide?: boolean } = {}): string {
  const nav = opts.user
    ? `<nav><a href="/me">apps</a><a href="/me/tokens">tokens</a><span class="mono">${escapeHtml(opts.user.email)}</span><a href="/logout">sign out</a></nav>`
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
<header class="bar"><a class="brand" href="/">smallcloud</a>${nav}</header>
${body}
<footer>smallcloud &middot; <a href="/v1/contract">app contract</a></footer>
</div>
</body>
</html>`;
}

export function renderLanding(baseUrl: string, signedIn: boolean): string {
  return layout(
    'smallcloud',
    `<h1>A cloud for small software.</h1>
<p class="lede" style="font-family: var(--serif); font-size: 18px; max-width: 46ch;">
Your agent hands this server a folder. It hands back a link you can send to someone.
Hosting, a database, file storage, sign-in and sharing are already there.</p>

<h2>Ship something</h2>
<code class="copy">npx smallcloud login ${escapeHtml(baseUrl)}
npx smallcloud deploy ./my-app
# -> ${escapeHtml(baseUrl)}/a/my-app</code>

<h2>What an app looks like</h2>
<code class="copy">my-app/
  app.json            {"name": "Todo"}
  public/index.html   the frontend
  api/todos.js        export default (req, ctx) =&gt; ({ json: ctx.db.all('select * from todos') })</code>
<p class="muted" style="margin-top:14px">Read the full <a href="/v1/contract">app contract</a> &mdash; it is the only document an agent needs.</p>

<h2>${signedIn ? 'Your apps' : 'Get in'}</h2>
<p>${signedIn ? '<a class="btn" href="/me">Open your dashboard</a>' : '<a class="btn" href="/login">Sign in with your email</a>'}</p>`,
    { user: null },
  );
}

export function renderLogin(next: string, error?: string): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
<p class="lede">Enter your email and we will send you a link. No password.</p>
${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/login" class="row-form">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="email" name="email" placeholder="you@example.com" required autofocus autocomplete="email">
  <button type="submit">Email me a link</button>
</form>`,
  );
}

export function renderCheckEmail(email: string, devLink?: string): string {
  return layout(
    'Check your email',
    `<h1>Check your email</h1>
<p class="lede">We sent a sign-in link to <span class="mono">${escapeHtml(email)}</span>. It works once and expires in 15 minutes.</p>
${devLink ? `<div class="notice"><strong>Development mode:</strong> no email provider is configured, so here is the link.<br><a class="mono" href="${escapeHtml(devLink)}">${escapeHtml(devLink)}</a></div>` : ''}`,
  );
}

export function renderDashboard(user: User, apps: Array<AppRecord & { relation: 'owner' | 'shared'; url: string; shares: number }>): string {
  const rows = apps
    .map(
      (a) => `<li>
  <span class="name"><a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></span>
  <span class="slug">/a/${escapeHtml(a.slug)}</span>
  <span class="right">
    ${a.relation === 'shared' ? '<span class="tag">shared with you</span>' : a.shares > 0 ? `<span class="tag live">shared &times;${a.shares}</span>` : '<span class="muted">private</span>'}
    <span class="muted">v${a.version}</span>
    <a href="/apps/${escapeHtml(a.id)}">manage</a>
  </span>
</li>`,
    )
    .join('\n');
  return layout(
    'Your apps',
    `<h1>Your apps</h1>
<p class="lede">${apps.length ? 'Everything you own or that has been shared with you.' : 'Nothing here yet.'}</p>
${apps.length ? `<ul class="apps">${rows}</ul>` : `<div class="empty">Deploy your first app with <span class="mono">smallcloud deploy ./my-app</span>, or point your agent at the <a href="/v1/contract">app contract</a>.</div>`}`,
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
  <td class="mono">${escapeHtml(sh.principal)}</td>
  <td>${escapeHtml(sh.role)}</td>
  <td class="actions"><form method="post" action="/apps/${escapeHtml(app.id)}/unshare" style="display:inline">
    <input type="hidden" name="principal" value="${escapeHtml(sh.principal)}">
    <button class="danger" type="submit">Remove</button></form></td>
</tr>`,
        )
        .join('\n')
    : '<tr><td colspan="3" class="muted">Not shared with anyone yet.</td></tr>';

  const logLines = logs.length
    ? logs
        .map((l) => {
          const t = new Date(l.at).toISOString().slice(11, 19);
          const cls = l.level === 'error' ? ' class="err"' : '';
          return `<span${cls}>${t}  ${escapeHtml(l.msg)}</span>`;
        })
        .join('\n')
    : '<span class="muted">No log lines yet.</span>';

  return layout(
    app.name,
    `<h1>${escapeHtml(app.name)}</h1>
<p class="lede">${escapeHtml(app.description || 'No description.')}</p>
<code class="copy"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></code>
<p class="muted" style="margin-top:10px">Version ${app.version} &middot; owner <span class="mono">${escapeHtml(app.ownerEmail)}</span> &middot; updated ${new Date(app.updatedAt).toLocaleString()}</p>

<h2>Who can open it</h2>
<div class="panel">
<table>
  <thead><tr><th>Who</th><th>Role</th><th></th></tr></thead>
  <tbody>${shareRows}</tbody>
</table>
<form method="post" action="/apps/${escapeHtml(app.id)}/share" class="row-form" style="margin-top:16px">
  <input type="text" name="principal" placeholder="bob@example.com, domain:example.com, or public" required>
  <select name="role"><option value="user">can use</option><option value="editor">can edit</option></select>
  <button type="submit">Share</button>
</form>
</div>

<h2>Secrets</h2>
<div class="panel">
${secretKeys.length ? `<p class="mono">${secretKeys.map(escapeHtml).join(', ')}</p>` : '<p class="muted">None. Secrets appear to the app as <span class="mono">ctx.env.KEY</span>.</p>'}
<form method="post" action="/apps/${escapeHtml(app.id)}/secret" class="row-form">
  <input type="text" name="key" placeholder="API_KEY" required>
  <input type="text" name="value" placeholder="value" required>
  <button type="submit">Set</button>
</form>
</div>

<h2>Logs</h2>
<pre class="logs">${logLines}</pre>

<h2>Export and delete</h2>
<p><a class="btn ghost" href="/v1/apps/${escapeHtml(app.id)}/export">Download everything (.zip)</a>
${isOwner ? `<form method="post" action="/apps/${escapeHtml(app.id)}/delete" style="display:inline; margin-left:8px" onsubmit="return confirm('Delete ${escapeHtml(app.name)} and all its data? This cannot be undone.')"><button class="danger" type="submit">Delete app</button></form>` : ''}</p>`,
    { user, wide: true },
  );
}

export function renderTokens(user: User, tokens: Array<{ name: string; createdAt: number; lastUsed: number | null }>, fresh?: string): string {
  const rows = tokens.length
    ? tokens
        .map(
          (t) =>
            `<tr><td>${escapeHtml(t.name)}</td><td class="muted">${new Date(t.createdAt).toLocaleDateString()}</td><td class="muted">${t.lastUsed ? new Date(t.lastUsed).toLocaleString() : 'never used'}</td></tr>`,
        )
        .join('\n')
    : '<tr><td colspan="3" class="muted">No tokens yet.</td></tr>';
  return layout(
    'Agent tokens',
    `<h1>Agent tokens</h1>
<p class="lede">A token lets an agent or the CLI deploy on your behalf. The usual way to get one is <span class="mono">smallcloud login</span>, which approves itself through this browser.</p>
${fresh ? `<div class="notice"><strong>Your new token.</strong> Copy it now; it is not shown again.<br><code class="copy" style="margin-top:8px">${escapeHtml(fresh)}</code></div>` : ''}
<div class="panel">
<table><thead><tr><th>Name</th><th>Created</th><th>Last used</th></tr></thead><tbody>${rows}</tbody></table>
<form method="post" action="/me/tokens" class="row-form" style="margin-top:16px">
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
      ? `<h1>Connected</h1><p class="lede">The agent is now signed in as <span class="mono">${escapeHtml(user.email)}</span>. You can close this tab and go back to your terminal.</p>`
      : `<h1>Connect an agent</h1>
<p class="lede">A command line on this machine is asking to deploy as <span class="mono">${escapeHtml(user.email)}</span>. Approve it only if you started it.</p>
<form method="post" action="/cli/${escapeHtml(code)}"><button type="submit">Approve</button></form>`,
    { user },
  );
}

export function renderError(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p><p><a href="/me">Go to your apps</a></p>`);
}
