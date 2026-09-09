/**
 * The app contract. This is the one document an agent needs in order to ship.
 * Served at GET /v1/contract, printed by `smallcloud contract`, and quoted in MCP tool
 * descriptions. Keep it short enough to paste into a prompt.
 */
export const CONTRACT = `# smallcloud app contract

You hand smallcloud a folder. It gives you back a URL that other people can open.
The platform supplies hosting, a database, file storage, sign-in, sharing and secrets.

## Folder layout

    app.json            required. {"name": "Todo", "description": "..."}
    public/index.html   the frontend (any HTML/CSS/JS). Required unless the app is API-only.
    public/**           any other static assets
    api/<route>.js      one file per API route, an ES module
    api/_helpers.js     files starting with _ are shared code, not routes
    README.md           optional

Requests to \`/a/<slug>/api/todos\` run \`api/todos.js\`. If there is no file for a route,
\`api/index.js\` handles it (use it as a catch-all router).

Each path segment is one component: it is percent-decoded, so \`/api/notes/hello%20world\` gives
you \`hello world\`, but a segment may not contain an encoded separator or \`..\` (that request is
rejected with 400). If an identifier of yours can contain a slash, put it in the query string.

## Writing a route

\`\`\`js
export default async function (req, ctx) {
  if (req.method === 'POST') {
    const { text } = req.json();
    ctx.db.run('insert into todos (text, done) values (?, 0)', text);
    return { json: { ok: true } };
  }
  return { json: ctx.db.all('select * from todos order by id desc') };
}
\`\`\`

### req
| field | meaning |
|---|---|
| \`req.method\` | GET, POST, ... |
| \`req.path\` | path inside the api, e.g. \`/todos/12\` |
| \`req.route\` | first segment, selects the file: \`todos\` |
| \`req.subpath\` | the rest: \`/12\` |
| \`req.query\` | query string as an object |
| \`req.headers\` | a safe subset of request headers |
| \`req.body\` | body as a string, or null |
| \`req.json()\` | body parsed as JSON |
| \`req.bytes()\` | body as a Buffer (uploads) |

### ctx
| field | meaning |
|---|---|
| \`ctx.db.run(sql, ...params)\` | write; returns \`{changes, lastInsertRowid}\` |
| \`ctx.db.get(sql, ...params)\` | one row, or undefined |
| \`ctx.db.all(sql, ...params)\` | array of rows |
| \`ctx.db.exec(sql)\` | run schema statements; use \`create table if not exists\` at the top of every route |
| \`ctx.files.put(name, data)\` | store a file (string or Buffer) |
| \`ctx.files.get(name)\` | Buffer, or null |
| \`ctx.files.getText(name)\` | string, or null |
| \`ctx.files.list()\` | array of names |
| \`ctx.files.delete(name)\` | true if it existed |
| \`ctx.user\` | \`{email}\` of the signed-in person, or null if nobody is signed in |
| \`ctx.env\` | secrets the owner set (never in your code) |
| \`ctx.log(...)\` | writes to the app log, visible via \`logs\` |
| \`ctx.fetch(url, init)\` | outbound HTTP; private/internal addresses are blocked |

\`ctx.user\` is the signed-in person whenever there is one. It is null only on an app shared
\`public\`, opened by someone who never signed in. Do not use it as a permission check for who
may open the app: smallcloud already did that before your code ran.

### What a route returns
| return | result |
|---|---|
| a string | HTML, 200 |
| \`{json: value}\` | JSON, 200 |
| \`{status, headers, body}\` | exactly that |
| a Uint8Array/Buffer | raw bytes |
| nothing | 204 |

**Headers you may set.** \`content-type\`, \`content-disposition\`, \`content-language\`,
\`cache-control\`, \`location\`, \`etag\`, \`last-modified\`, \`vary\`, \`refresh\`, \`link\`, and any
header starting with \`x-\`. Anything else is dropped and the reason is written to your app log.
In particular an app cannot set \`set-cookie\`: apps share an origin with the platform, so a
cookie from an app could overwrite the visitor's sign-in session. Keep per-visitor state in
\`ctx.db\` keyed by \`ctx.user.email\` instead.

## Frontend

\`public/index.html\` is served at the app root. Call your API with a **relative** path so the
app works at any URL:

\`\`\`js
const res = await fetch('api/todos');
\`\`\`

You may load libraries from a CDN in the browser. There is no build step: ship plain
HTML/CSS/JS or ES modules.

## Limits and rules

- Bundle: 5 MB, 500 files max.
- A request must finish in 10 seconds; the app gets 128 MB of heap.
- \`api/\` code may not use npm packages in v1, and may not import these built-ins:
  \`sqlite\`, \`fs\`, \`child_process\`, \`worker_threads\`, \`net\`, \`http\`, \`os\`, \`process\`, \`module\`, \`vm\`
  (a deploy that references one is rejected). Use \`ctx.db\` for storage, \`ctx.files\` for files
  and \`ctx.fetch\` for HTTP. Safe built-ins such as \`crypto\`, \`path\`, \`url\` and \`buffer\` are fine.
- The app can read only its own folder and write only its own data. It cannot start processes.
- Redeploying keeps the same URL, database and files. Deploy with the same \`appId\` to update.

## Sharing

Share with \`bob@example.com\` (one person), \`domain:example.com\` (everyone at that domain),
or \`public\` (anyone with the link, no sign-in). Roles: \`user\` (can open it) and \`editor\`
(can also redeploy and manage sharing). Recipients sign in with an emailed link.

## Typical flow

1. write the folder
2. deploy it, keep the returned \`id\`
3. open the returned \`url\` to check it works
4. share it
5. on a bug: read \`logs\`, fix, deploy again with the same \`id\`
`;
