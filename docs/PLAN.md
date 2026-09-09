# smallcloud — end-to-end plan

Working name: **smallcloud** (placeholder, rename before launch).
Status: **v1 built** (M1-M4 complete, 52 tests green). See `## Build log` at the end.
Owner: Mandar. Author: Claude, 2026-09-09.

Decisions already taken: self-hosted single server; magic-link email sign-in; project lives at `Desktop\smallcloud`.

---

## 1. Product brief

**Problem.** With a coding agent, building a small tool takes minutes. Getting it running somewhere with a URL, sign-in, a database, file storage and a share list still takes hours of infra glue: pick a host, wire an auth provider, provision a DB, set env vars, buy a domain. For software used by one person or a handful, that glue is most of the work and none of the value, and the agent cannot do it end to end because it spans five vendors' dashboards.

**What smallcloud is.** One self-hosted server. An agent hands it a folder; it hands back a link. The platform supplies everything around the code: static frontend hosting, backend routes, a per-app database, per-app file storage, sign-in, sharing and permissions, secrets, logs, and a one-call export. The agent is the primary operator. People only ever open links.

**What it is not.** Not a scale-out cloud. Not a hostile multi-tenant platform (strangers do not deploy to your instance). Not a code generator (agents bring the code). Not a no-code builder. Not a marketplace.

**Success criteria for v1.**

| # | Criterion | How we check |
|---|---|---|
| S1 | *Cold agent test*: a fresh Claude Code session with only the MCP server configured ships a working multi-user todo app (frontend + API + DB + shared with a second email) in one conversation, with no human help | scripted `claude -p` run, 3/3 passes |
| S2 | Recipient flow: link → email → open → use in under 60 s, on a phone | manual, timed |
| S3 | Redeploy keeps the URL and the data | automated test |
| S4 | One Docker container, one volume, runs on a $5 VPS with TLS | deployed instance |
| S5 | Export returns everything: code, database, files | automated test |
| S6 | An app cannot read another app's data, the platform DB, or the platform's env | automated security tests |

---

## 2. People and their jobs

| Who | Jobs to be done | What they must never have to do |
|---|---|---|
| **Agent** (Claude Code, Codex, Cursor…) | learn the contract in one call; deploy; read errors it can act on; read logs and source back; redeploy idempotently; share; set secrets | guess at conventions; read a website; handle auth UI |
| **Builder** (you) | drive the agent; get the link; occasionally manage shares in a browser; own the instance | touch a cloud console; write auth code; think about DBs |
| **Recipient** (teammate, friend) | open a link; sign in with their email; use the tool | install anything; create a password; know what smallcloud is |
| **Admin** (same person as builder in v1) | run the container; keep env vars; back up the volume; upgrade | run a database server; manage certificates by hand |

---

## 3. End-to-end journeys

- **J1 First install.** `docker run` with a volume and three env vars → open the URL → enter email → click the link in the email → dashboard → "Connect an agent" → a device-login URL → approve in the browser → the agent has a token. No copy-pasting secrets into chat.
- **J2 Ship.** Agent calls `contract` → writes a folder (`app.json`, `public/`, `api/`) → calls `deploy` → gets `{id, url}` → fetches the URL to smoke-test → reports the link.
- **J3 Share.** Agent (or builder in the UI) shares with `bob@x.com` → Bob opens the link → enters email → clicks the emailed link → is inside the app; the app sees `ctx.user.email === 'bob@x.com'`.
- **J4 Iterate.** Bob reports a bug → agent calls `logs` and `source` → edits → `deploy` with the same id → same URL, data intact, app process restarted.
- **J5 Secrets.** App needs a third-party key → `secret_set OPENAI_KEY` → route reads `ctx.env.OPENAI_KEY`; never written into the bundle.
- **J6 Leave.** `export` → a zip with the source, `app.db`, and uploaded files. Nothing proprietary in it.
- **J7 Operate.** Pull the new image, restart; nightly backup of the volume; rotate `SC_SECRET` with a re-encrypt command.

---

## 4. Scope

### v1 (must ship)

1. Deploy a folder over HTTP; atomic in-place redeploy; delete.
2. Serve `public/` as static files with SPA fallback to `index.html`.
3. Run `api/<route>.js` ES-module routes in an isolated per-app process.
4. Per-app SQLite database (`ctx.db`), per-app file storage (`ctx.files`).
5. Magic-link sign-in, 30-day sessions, optional email allowlist.
6. Sharing: `user:<email>`, `domain:<domain>`, `public`; roles `user` and `editor`; owner implicit.
7. Dashboard (my apps, shared with me), per-app manage page (shares, tokens), sign-in pages.
8. Secrets encrypted at rest, exposed as `ctx.env`.
9. Per-app logs (ring buffer of 500 lines) from `ctx.log` and uncaught errors.
10. JSON API v1; CLI; MCP server; `AGENTS.md` contract served at `/v1/contract`.
11. Device-flow login for the CLI/agent.
12. Export as zip.
13. Rate limits on sign-in; request timeout, memory cap and idle shutdown for app processes.
14. Docker image, compose file, Caddy TLS example, backup script.

### v1.x (after v1 is in daily use, in this order)

- Per-app subdomains (`todo.yourhost.com`) to isolate cookies and origins between apps.
- npm dependencies for `api/` (install at deploy time inside the sandbox, or bundle with esbuild).
- Scheduled jobs per app (`api/_cron.js` + schedule in `app.json`).
- Server-sent events / websockets for live UIs.
- Google sign-in as a second provider.
- App templates the agent can start from.

### Non-goals (say no in reviews)

Horizontal scaling · hostile multi-tenant isolation · realtime collaborative editing · billing · marketplace · code generation · a visual builder.

---

## 5. Requirements

### Functional

| ID | Requirement |
|---|---|
| F1 | `POST /v1/apps` accepts `{files[], appId?}`; validates; returns `{id, slug, url, version}` |
| F2 | Bundle rules: ≤ 5 MB, ≤ 500 files, only `app.json`, `README.md`, `public/**`, `api/*.js`; `api/_*.js` are helpers, not routes |
| F3 | `GET /a/<slug>/**` serves `public/`, falls back to `index.html` for navigations, 404 for assets |
| F4 | `ANY /a/<slug>/api/<route>[/subpath]` runs `api/<route>.js` default export `(req, ctx)`; `api/index.js` is the catch-all |
| F5 | `ctx.db` = `run / get / all / exec` over the app's own SQLite; `ctx.files` = `put / get / getText / list / delete`, names sanitized |
| F6 | `ctx.user` is `{email}` of the signed-in person, or `null` when nobody is signed in (only possible on a `public` app); `ctx.env` is the decrypted secrets; `ctx.log` writes to app logs; `ctx.fetch` is `fetch` minus private-network targets |
| F7 | Route returns: string → HTML; `{json}` → JSON; `{status, headers, body}`; `Uint8Array` → bytes |
| F8 | Anyone opening an app they cannot use is sent to sign-in (if anonymous) or shown a 403 page (if signed in) |
| F9 | `roleFor(user, app)` is the only authorization function; every page and endpoint goes through it |
| F10 | Magic links: 15-min TTL, single use, `next` preserved; sessions 30 days, HttpOnly, SameSite=Lax, Secure on https |
| F11 | API tokens: `sc_` prefix, only the SHA-256 stored, shown once, revocable |
| F12 | Device login: `POST /v1/cli-login` → code+URL; browser approve; CLI polls; token returned exactly once |
| F13 | Redeploy with `appId` bumps `version`, keeps id/slug/db/files/shares/secrets, restarts the app process |
| F14 | Secrets: `PUT /v1/apps/:id/secrets {key,value}`, keys `[A-Z][A-Z0-9_]*`, AES-256-GCM at rest, values never returned |
| F15 | Logs: last 500 lines per app, `GET /v1/apps/:id/logs?limit=` |
| F16 | `GET /v1/apps/:id/export` → zip: `app/**`, `app.db`, `files/**` |
| F17 | `POST /v1/apps/:id/db {sql, params}` runs SQL as the app owner/editor (for agent debugging and migrations) |
| F18 | CLI: `login, deploy <dir>, list, open, share, unshare, logs, db, secrets set/rm, export, delete, mcp, serve, contract` |
| F19 | MCP tools mirror the CLI one-to-one plus `contract`; every tool description states the app contract's key rules |
| F20 | `/health` and `/v1/stats` (counts only) for the operator |

### Non-functional

| ID | Requirement |
|---|---|
| NF1 | Isolation: an app process can read only its bundle and write only its data dir; cannot spawn processes; receives no platform env vars; is killed after 10 s per request; 128 MB heap |
| NF2 | Performance on a 1-vCPU VPS: static < 5 ms, warm route overhead < 20 ms, cold app start < 600 ms, 50 rps static / 20 rps API without errors |
| NF3 | Operability: one process, one volume, no external service except an email API; `/health`; structured stdout logs; backups by copying one directory |
| NF4 | Portability: Node ≥ 22.13; Linux in production; Windows and macOS for development; CI on Linux + Windows |
| NF5 | Size: core under ~5 k lines of TypeScript; zero runtime dependencies except the MCP SDK |
| NF6 | Agent ergonomics: every error is `{error: code, message: what to change}`; every tool call returns in < 2 s except deploy |

---

## 6. Architecture

### 6.1 Components

```
 agent (MCP / CLI) ──HTTP JSON──┐          ┌── browser (people)
                                ▼          ▼
            ┌──────────────── control plane (one Node process) ───────────────┐
            │ router · auth · ACL · registry · deploy · secrets · logs · static │
            │ platform.db (SQLite, WAL)                                        │
            └──────┬──────────────────┬──────────────────┬───────────────────┘
                   │ IPC              │ IPC              │ IPC
            ┌──────▼──────┐   ┌───────▼─────┐    ┌───────▼─────┐
            │ app A host  │   │ app B host  │    │ app C host  │   node --permission
            │ api/*.js    │   │ (idle→exit) │    │             │   one process per app
            │ app.db files│   │             │    │             │   lazy start, idle stop
            └─────────────┘   └─────────────┘    └─────────────┘
```

- **Control plane** owns every decision: who is calling, what they may do, which app, which file. It serves static files itself (no need to wake the app for HTML/CSS/JS).
- **App host** is a Node child started with `--permission --allow-fs-read=<app dir> --allow-fs-write=<app data dir> --max-old-space-size=128`, a clean environment, and an IPC channel. It imports `api/*.js`, builds `ctx`, runs the route, and returns the response over IPC. It exits after 60 s idle and is restarted lazily.
- **MCP server and CLI** are thin clients of the JSON API. One surface to test, three ways in.

### 6.2 Storage layout

```
$SC_DATA_DIR/
  platform.db                 users, sessions, tokens, apps, shares, secrets, logs
  apps/<id>/
    bundle/                   the deployed folder + a generated package.json ({"type":"module"})
    data/app.db               the app's own SQLite (ctx.db)
    data/files/               ctx.files
```

Backups are `cp -r` of this directory (with `VACUUM INTO` for a consistent DB snapshot).

### 6.3 Data model (platform.db)

```
users        (email pk, created_at)
magic_links  (token pk, email, next, expires_at, used)
sessions     (id pk, email, created_at, expires_at)
api_tokens   (hash pk, email, name, created_at, last_used)
cli_logins   (code pk, token?, created_at)
apps         (id pk, slug unique, name, description, owner_email, version, created_at, updated_at)
shares       (app_id, principal, role, pk(app_id, principal))
secrets      (app_id, key, value_encrypted, pk(app_id, key))
logs         (id, app_id, at, level, msg)
```

### 6.4 Request flows

- **Static.** `GET /a/todo/style.css` → identify caller (cookie or bearer) → `roleFor` → sanitize path → stream from `bundle/public`. Cache-Control: no-cache (small software changes often).
- **API.** `POST /a/todo/api/todos` → identify → `roleFor` → serialize `{method, path, route, subpath, query, headers, body}` + `{user, env}` → runtime → IPC to app host (start it if needed) → route runs → response over IPC → write to client. Timeout kills the host and returns 504; next request restarts it.
- **Deploy.** `POST /v1/apps` → identify by bearer → validate bundle → write to `bundle.tmp` → rename swap → bump version → tell runtime to stop the old host → return `{id, url}`.
- **Magic link.** `POST /login {email}` → allowlist + rate limit → insert token → email link → `GET /auth/<token>` → single-use check → create session → set cookie → redirect to `next`.
- **Device login.** CLI `POST /v1/cli-login` → `{code, url}` → person opens `url` signed in → approve → token minted and parked on the code → CLI polls `GET /v1/cli-login/<code>` → token returned once and deleted.

### 6.5 Isolation model (spike verified 2026-09-09 on Node 22.14, Windows)

Boundary = **OS process + Node permission model**. Verified: an app host wrote its own SQLite DB, was denied reading a file outside its directory (`ERR_ACCESS_DENIED`), and cannot load `child_process`.

Defended: cross-app data reads · platform DB reads · platform env leakage (child gets a scrubbed env) · process spawning · runaway CPU (per-request timeout → kill) · runaway memory (heap cap) · crashing the platform (crash is per-app) · SSRF to the control plane from `ctx.fetch` (private-range block).

Not defended in v1 (documented in SECURITY.md): hostile code from strangers · cross-app XSS/CSRF while apps share one origin (v1.x subdomains fix this) · DNS-rebinding SSRF · side channels · raw `node:net` sockets to localhost (mitigated: control-plane endpoints all require auth).

### 6.6 The app contract (what the agent is told)

```
myapp/
  app.json            {"name": "Todo", "description": "…"}
  public/index.html   static frontend; fetch('/a/<slug>/api/…') or relative 'api/…'
  public/**           any assets
  api/todos.js        export default async function (req, ctx) { … }
  api/_lib.js         helpers (underscore = not a route)

req:  method, path ("/todos/12"), route ("todos"), subpath ("/12"), query, headers, body, json()
ctx:  db.run(sql, ...p) → {changes, lastInsertRowid}
      db.get(sql, ...p) → row | undefined
      db.all(sql, ...p) → rows
      db.exec(sql)               (migrations; run on every request, use IF NOT EXISTS)
      files.put(name, data) / get(name) → Buffer|null / getText / list() / delete(name)
      user → {email} | null      (null only when the app is shared publicly)
      env  → secrets set by the owner
      log(...args)
      fetch(url, init)           (no private networks)
return: "<html>…"  |  {json: …}  |  {status, headers, body}  |  Uint8Array

Limits: 5 MB bundle · 10 s per request · 128 MB · Node built-ins only in api/ (no npm in v1) · frontend may load ESM from CDNs
```

### 6.7 Surfaces

**JSON API v1** (bearer `sc_…` or session cookie)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/me` | who am I |
| GET | `/v1/contract` | the app contract (markdown) |
| POST | `/v1/apps` | deploy / redeploy |
| GET | `/v1/apps` | mine + shared with me |
| GET | `/v1/apps/:id` | record + shares + url |
| DELETE | `/v1/apps/:id` | delete (owner only) |
| GET | `/v1/apps/:id/source` | files back |
| GET | `/v1/apps/:id/logs` | last N lines |
| GET/PUT/DELETE | `/v1/apps/:id/shares[/:principal]` | manage sharing |
| GET/PUT/DELETE | `/v1/apps/:id/secrets[/:key]` | keys only on GET |
| POST | `/v1/apps/:id/db` | run SQL as editor |
| GET | `/v1/apps/:id/export` | zip |
| POST/GET | `/v1/cli-login[/:code]` | device flow |
| GET | `/health`, `/v1/stats` | operator |

**CLI**: `smallcloud login | deploy <dir> [--app id] | list | open <app> | share <app> <principal> [role] | unshare | logs | db <app> "<sql>" | secrets set <app> K=V | secrets rm | export <app> [file] | delete | contract | mcp | serve`. `deploy` writes `.smallcloud.json` (`{appId}`) into the folder so the next deploy is a redeploy.

**MCP tools** (stdio, official SDK): `smallcloud_contract, smallcloud_deploy, smallcloud_list, smallcloud_get, smallcloud_source, smallcloud_logs, smallcloud_share, smallcloud_unshare, smallcloud_secret_set, smallcloud_db, smallcloud_export, smallcloud_delete`. Install: `smallcloud mcp-install` writes the entry into Claude Code's MCP config.

**Pages**: `/` landing · `/login` · `/auth/:token` · `/me` dashboard · `/me/tokens` · `/cli/:code` approve · `/apps/:id/manage` · `/a/:slug/**` apps · 403 / 404.

---

## 7. Decisions (ADRs)

| # | Decision | Alternatives considered | Why | Revisit when |
|---|---|---|---|---|
| D1 | One restricted Node process per app (`--permission`) | `vm` + SourceTextModule; V8 isolates (isolated-vm); Cloudflare Workers for Platforms; Docker per app | Real FS boundary from the OS, no native deps, simple mental model, crash isolation for free; spike verified | Strangers deploy to one instance, or > ~50 concurrently active apps per box |
| D2 | SQLite for everything via `node:sqlite` | Postgres; better-sqlite3 | Zero external services, zero native builds, one directory to back up | Multiple servers |
| D3 | Magic-link email sign-in | Google OAuth; passwords; link-with-secret | Works for any email; no password storage; provider-agnostic | Users ask for one-click Google |
| D4 | Apps served under one origin at `/a/<slug>` | Per-app subdomains | Works with zero DNS setup on day one | v1.x: subdomains once a domain exists |
| D5 | No npm dependencies in `api/` for v1 | Install at deploy; esbuild bundle | Removes the biggest attack surface and the slowest step; built-ins + `fetch` cover most small tools | Cold agent test shows agents keep reaching for packages |
| D6 | MCP via the official `@modelcontextprotocol/sdk` | Hand-rolled JSON-RPC | Spec drift is the SDK's problem, not ours | Never, unless the SDK becomes heavy |
| D7 | CLI and MCP are thin clients over the JSON API | Direct DB access from CLI | One surface to test and secure | Never |
| D8 | TypeScript, Node 22, no web framework | Hono/Fastify | ~40 routes; a framework buys little and adds a dependency tree to audit | Router grows past ~80 routes |
| D9 | Control plane serves static files; the app host only runs routes | Everything through the host | HTML/CSS/JS should not wake a process | Never |
| D10 | Secrets encrypted with a key derived from `SC_SECRET` | KMS; plaintext | Self-hosted, one env var to protect | Multi-server or compliance needs |
| D11 | A request that exceeds the timeout kills the app process, aborting that app's other in-flight requests | reject only the offending invoke | a runaway synchronous loop cannot be interrupted from outside, so a kill is the only reliable recovery; at 1-5 users per app the blast radius is one person | apps routinely serve concurrent users |
| D12 | `ctx.user` is the signed-in person whenever there is one; `public` only removes the *requirement* to sign in | null for every request on a public app | a public app still needs to tell its users apart | never |

---

## 8. Security posture

- **Trust model.** The instance owner trusts the builders; builders' agents write code that runs on the owner's box. Recipients are untrusted browsers. Apps are untrusted-by-default processes with a small capability surface.
- **AuthN.** Session cookie (HttpOnly, SameSite=Lax, Secure) or bearer token. No anonymous compute except apps explicitly shared `public`.
- **AuthZ.** Single `roleFor()`; tests cover the full matrix (owner/editor/user/none × cookie/bearer/anon × private/domain/public).
- **Input.** Path sanitization for bundles and `ctx.files`; body limit 5 MB; JSON only on API; SQL only via the app's own DB.
- **Abuse.** Rate limits: `/login` 5 per email and 20 per IP per 15 min; `/a/**` 300 req/min per IP; deploy 30 per hour per token.
- **Processes.** Scrubbed env, restricted FS, heap cap, timeout, idle stop, restart on deploy; host crash never takes the control plane down.
- **Secrets.** AES-256-GCM at rest; decrypted only at request time and handed over IPC; never logged; rotate command re-encrypts.
- **Disclosure.** `SECURITY.md` states exactly what is and isn't defended (§6.5).

---

## 9. Work breakdown

Estimates are for one builder plus an agent. Each milestone ends with a demo and a green CI.

### M1 — Core runtime (days 1–2) · "works on my laptop"

| Ticket | Work | Est | Depends on |
|---|---|---|---|
| T1.1 | Scaffold: TS, `node:test`, lint, GitHub Actions on ubuntu + windows | 0.5 d | — |
| T1.2 | Platform DB + migrations | 0.25 d | T1.1 |
| T1.3 | Bundle validation, on-disk layout, atomic redeploy, source read-back | 0.5 d | T1.2 |
| T1.4 | App host: `ctx` (db/files/user/env/log/fetch), req/res marshaling, module cache | 0.5 d | T1.1 |
| T1.5 | Runtime manager: spawn with `--permission`, IPC, timeout → kill, idle → stop, restart on deploy | 0.5 d | T1.4 |
| T1.6 | HTTP: static serving with SPA fallback, `/api` routing, dev-token auth, error JSON | 0.5 d | T1.3, T1.5 |
| T1.7 | Tests: validation table, security (fs escape, `child_process`, env leak, timeout, memory), deploy→call e2e | 0.5 d | T1.6 |

**DoD:** `npm test` green on Windows + Linux · todo example deploys and works via `curl` with a dev token · all NF1 checks automated.

### M2 — People (days 3–4) · "share it with a friend"

| Ticket | Work | Est | Depends on |
|---|---|---|---|
| T2.1 | Magic links, sessions, cookies, email allowlist | 0.5 d | T1.2 |
| T2.2 | Mailers: Resend over fetch; console mailer for dev/tests | 0.25 d | T2.1 |
| T2.3 | Shares table, principals, `roleFor`, enforcement on every route | 0.25 d | T1.6 |
| T2.4 | Pages: landing, sign-in, check-your-email, dashboard, app manage (shares + tokens), 403/404. Design pass with the taste skill | 1 d | T2.3 |
| T2.5 | Rate limits; CSRF posture (SameSite + origin check on form posts) | 0.25 d | T2.4 |
| T2.6 | Tests: auth flows (expired, reused, allowlist), ACL matrix, page smoke | 0.5 d | T2.5 |

**DoD:** two real inboxes complete J3 on a phone · ACL matrix test is exhaustive.

### M3 — Agent surface (days 5–6) · "an agent can do all of it"

| Ticket | Work | Est | Depends on |
|---|---|---|---|
| T3.1 | JSON API v1 complete, uniform errors, bearer auth | 0.5 d | T2.3 |
| T3.2 | Device login (start / approve / poll) | 0.25 d | T2.1 |
| T3.3 | CLI with `~/.smallcloud/config.json` and per-folder `.smallcloud.json` | 0.5 d | T3.1, T3.2 |
| T3.4 | MCP server (SDK), tool schemas, `mcp-install` | 0.5 d | T3.3 |
| T3.5 | `AGENTS.md` contract; served at `/v1/contract`; embedded in tool descriptions | 0.25 d | T3.4 |
| T3.6 | Cold agent test harness: `claude -p` + MCP + scripted goal + smoke assertions | 0.5 d | T3.5 |

**DoD:** cold agent test passes 3/3 · CLI and MCP share one client module · every error message names the fix.

### M4 — Ops and hardening (days 7–8) · "runs on a real box"

| Ticket | Work | Est | Depends on |
|---|---|---|---|
| T4.1 | Secrets at rest + `rotate-secret` command | 0.25 d | T1.2 |
| T4.2 | Logs ring buffer, structured stdout, `/health`, `/v1/stats` | 0.25 d | T1.5 |
| T4.3 | Export zip; delete app; `.smallcloud.json` pin | 0.25 d | T1.3 |
| T4.4 | Dockerfile, compose, Caddy TLS example, `backup.sh` (`VACUUM INTO`), `RUNBOOK.md` | 0.5 d | T3.1 |
| T4.5 | Security test expansion (SSRF block, path traversal in files, oversized body, token revocation) + `SECURITY.md` | 0.5 d | T2.6 |
| T4.6 | Load sanity on the VPS: 50 rps static, 20 rps API, 10 min | 0.25 d | T4.4 |

**DoD:** live on a VPS with TLS · one backup restored successfully · load numbers recorded in RUNBOOK.

### M5 — Launch-ready (days 9–10)

| Ticket | Work | Est |
|---|---|---|
| T5.1 | Landing page + README + docs (contract, self-host guide); design pass | 1 d |
| T5.2 | Three examples: todo (multi-user), standup log (public), expense splitter (file upload) | 0.5 d |
| T5.3 | Name, license, repo visibility, domain | 0.25 d |
| T5.4 | Announcement draft | 0.25 d |

Total: **~10 working days**. Critical path: T1.4 → T1.5 → T1.6 → T2.3 → T3.1 → T3.4 → T3.6.

---

## 10. Testing strategy

| Layer | What | Tooling |
|---|---|---|
| Unit | bundle validation table, `roleFor` matrix, crypto round-trips, zip structure, path sanitizers | `node:test` |
| Integration | server on port 0 with a temp data dir and the console mailer: every journey J1–J6 as a test | `node:test` + `fetch` |
| Security | fs escape, `child_process`, env leak, timeout kill + recovery, heap cap, SSRF block, traversal in `ctx.files`, token revocation, expired/reused magic links | `node:test`, real child processes |
| Contract | the todo example deployed and exercised end to end; export unzips to the same source | `node:test` |
| Agent | cold agent test: fresh `claude -p` with the MCP server, goal "ship a multi-user todo app and share it with x@y", assertions hit the deployed URL | script in `eval/` |
| Manual | J3 on a phone with two real inboxes; magic link via Resend | checklist in `RUNBOOK.md` |
| CI | ubuntu + windows on every push; the agent eval runs on demand | GitHub Actions |

---

## 11. Operations

- **Deploy:** `docker compose up -d` with `SC_DATA_DIR=/data`, `SC_BASE_URL`, `SC_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, optional `SC_ALLOWED_EMAILS`. Caddy in front for TLS.
- **Backup:** nightly `backup.sh`: `VACUUM INTO` for `platform.db` and every `app.db`, then tar the data dir. Restore = untar, start.
- **Upgrade:** pull image, `compose up -d`; migrations run at boot; app hosts restart lazily.
- **Observe:** `/health`, stdout JSON logs, per-app logs in the UI and API.
- **Secrets rotation:** `smallcloud rotate-secret --old … --new …` re-encrypts and exits; then update the env.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `--permission` has gaps or changes between Node versions | medium | high | pin Node major; security tests assert each guarantee; `Runtime` interface swappable for isolates |
| Agents keep needing npm packages in `api/` | high | medium | contract steers to built-ins + `fetch` + CDN ESM on the frontend; measure in the cold agent test; v1.x install-at-deploy |
| Email deliverability | medium | medium | Resend with a verified domain; console fallback; allowlist for private instances |
| Same-origin apps leak cookies/XSS across apps | medium | medium | documented; `ctx.user` only; v1.x subdomains |
| Windows-dev vs Linux-prod path/permission differences | medium | low | CI on both from T1.1 |
| Scope creep toward "real cloud" | high | high | §4 non-goals; every new item must map to a journey |

---

## 13. Open questions for Mandar

1. **Instance target:** which VPS/provider and domain for the first real deploy (M4)? Affects the Caddy config and the cookie `Secure` flag testing.
2. **Repo & license:** public or private repo, and license (this decides how §1 "what it is not" is worded publicly).
3. **Realtime in v1?** Default is no (SSE arrives in v1.x). Say if a first app needs it.
4. **npm in `api/`:** hold the line (D5) or plan install-at-deploy into M4?
5. **Name:** pick before M5; the slug shows up in the CLI, config file, MCP tool names and cookies.

---

## 14. Definition of done for v1

All of S1–S6 in §1 pass · CI green on both OSes · SECURITY.md and RUNBOOK.md exist · a second person has used a shared app from their phone · export/restore verified once · this document updated to "shipped".


---

## Build log (2026-09-09)

v1 was built against this plan in one session. What changed from the plan as written:

| Change | Why |
|---|---|
| `normalizePath` character class rewritten | the original `[ -<>:"|?*]` was a **range** from space to `<`, so it rejected every filename containing a dot. Caught in review before any bundle was deployed. |
| First isolation spike was a false positive | it tested `require('node:child_process')` inside an ES module, which throws `ReferenceError` regardless of the permission model. Re-run with a real `spawnSync`: genuinely blocked with `ERR_ACCESS_DENIED`. |
| Child env is an explicit allowlist, not `process.env` minus keys | under `tsx` the child would otherwise inherit `NODE_OPTIONS` and try to load the dev loader from a path it cannot read. |
| `--allow-fs-read` covers the app root, `--allow-fs-write` only `data/` | SQLite in WAL mode must read the database it writes and create `-wal`/`-shm` siblings. |
| `ctx.files` rejects names containing a directory instead of silently taking the basename | a silent rewrite means an app believes it wrote somewhere it did not. |
| D11, D12 added | surfaced by review; see the table above. |
| `/v1/apps/:id/db` moved out of the control plane into the app's sandboxed process | it opened the app database with the platform's filesystem access, so `VACUUM INTO '<any path>'` written by an editor escaped the data directory. Reproduced, then fixed. |
| `--allow-fs-*` grants now carry a trailing separator | Node matches grants by path prefix, so a grant on `.../apps/aa` could otherwise cover `.../apps/aaa`. Latent (ids are fixed-length) but now closed. |
| **`node:sqlite` bypasses the Node permission model** | found while fixing the above: `fs.readFileSync(platformDb)` is denied, `new DatabaseSync(platformDb)` succeeds. Any app could read every session and token hash. Mitigated with a deploy-time guardrail, a load-time module block (Node >= 22.15) and optional `SC_APP_UID`; documented in SECURITY.md. **The load-time block is unverified on this machine** (Node 22.14 has no `module.registerHooks`) and the corresponding test reports a skip naming the gap rather than passing. |

**Verified end to end on a live server**: device login -> `smallcloud deploy ./examples/todo` -> app answers -> shared with a second person -> that person signed in via an emailed link, used the app, was credited by email, and was refused management access -> redeploy kept the URL and the data -> export produced a zip with source and database.

**Test coverage**: 52 tests. `test/security.test.ts` (12) asserts every guarantee in SECURITY.md; `test/shares.test.ts` (5) covers the full ACL truth table; `test/apps.test.ts` (14) covers validation, deploy/redeploy, secrets, logs, crypto and zip; `test/e2e.test.ts` (21) walks journeys J1-J6 against a real server.

**Not yet done from this plan**: M3's cold-agent eval harness (T3.6), M4's VPS load run (T4.6), and all of M5 (landing page, further examples, name/license/domain). The open questions in section 13 are still open.

**Linux verification (done, 2026-09-09).** `docker build -f Dockerfile.test` on node:22-slim (Node 22.23):
**54/54 pass, nothing skipped** -- the `node:sqlite` test passes there rather than skipping, confirming the
load-time block works. `scripts/verify-uid-isolation.mjs` proves the OS layer separately: a plain `node`
running as the app user, with no Node-level protection, is refused `platform.db` by the kernel. The
production image was built, booted, and driven end to end through the CLI.

Four further bugs were found and fixed during that verification, none of which Windows could have shown:

| Bug | Consequence |
|---|---|
| `docker-entrypoint.sh` chmodded `platform.db` before the server created it | it stayed world-readable (0644) on a fresh instance. The server now sets 0600 on the database and its WAL siblings itself, so it cannot depend on script ordering. |
| `useradd --uid 10001` created the group at gid 999 | `SC_APP_GID=10001` named a group that did not exist. Now `groupadd --gid 10001` first. |
| App directories were created by the root control plane | under `SC_APP_UID` the app could not write its own database ("unable to open database file"). The runtime now hands `data/` to the app user on start; `bundle/` deliberately stays root-owned and read-only. |
| `deploy` failed hard when the folder's pinned app no longer existed | a deleted app, or pointing a folder at a different server, left the CLI and the MCP tool stuck on `not_found`. A stale pin now creates a new app; an explicit `--app` still errors. |

Four security tests also had to be rewritten: they asserted `ERR_ACCESS_DENIED` specifically, but on
Node >= 22.15 the load-time block fires first and returns `ERR_MODULE_BLOCKED`. They now assert the
guarantee (the app did not reach the resource) rather than which layer delivered it, and pass on both.

**Cold agent test (S1 / T3.6, 2026-09-09).** `eval/cold-agent.mjs` stands up a real server, gives a
*fresh* headless Claude Code session nothing but the smallcloud MCP server and an empty directory,
and asks for a shared multi-user todo app. The harness never reads the app's source: it grades over
HTTP the way a recipient would (frontend loads, both API routes behave, sharing works, the second
person is attributed correctly, a stranger gets 403, tables exist in the app's own database).

The first run passed all ten checks in 207s / 36 turns -- and reported a real platform bug, which is
what the test is for:

> smallcloud serves the app root at `/a/<slug>` with no trailing-slash redirect. The contract's
> suggested `fetch('api/todos')` therefore resolves to `/a/api/todos` -> 404, so the page would have
> looked broken at exactly the URL bob receives.

Reproduced immediately: the share link the platform hands out has no trailing slash, so a relative
URL in the app's own HTML -- which the contract tells agents to write -- resolves one directory too
high. Every app built to the contract was broken at the URL recipients are given, including
`examples/todo`; it only passed earlier tests because those requested `/a/todo/` with the slash.
Fixed by redirecting the no-slash form to the directory form, query string preserved, with a
regression test in `test/e2e.test.ts`.

**Load sanity (T4.6, 2026-09-09).** `scripts/loadtest.mjs` against the production image, server
pinned to 1 vCPU / 1 GB, client in a separate container. All NF2 targets met: static p50 3.6 ms at
50 rps, API read 4.1 ms at 20 rps, API write 13.1 ms, cold start 57 ms, zero errors, no process leak.
Numbers and how to reproduce are in RUNBOOK.md. It found two things:

| Finding | Fix |
|---|---|
| **The app rate limit contradicted the plan's own capacity target.** NF2 asks for 50 rps static and 20 rps API, but the limiter allowed 300/min (5 rps), so the first run 429'd about 90% of the load. | Split into separate static and API limiters set to exactly the NF2 numbers (3000 and 1200 per minute, per app per IP), configurable with `SC_STATIC_RPM` / `SC_API_RPM`. |
| **Every bearer-authenticated request did a database write**, updating `api_tokens.last_used` -- on the hot path for every static asset too. | Update it at most once a minute per token. Static p50 went 7.0 ms -> 3.6 ms and API read 8.2 ms -> 4.1 ms, so this was roughly a 2x throughput win for free. |

**Examples (T5.2, done).** Three now: `todo` (multi-user), `standup` (a public log, shows the
`ctx.user === null` path and day grouping), and `expenses` (the only example that uses `ctx.files`:
receipt upload, retrieval, per-person authorization, and cleanup on delete, plus a settlement
algorithm in an `api/_split.js` helper to show non-route files). All three were deployed to a live
server and driven end to end; both new frontends were opened in a real browser.

**CI (T1.1, done late).** `.github/workflows/ci.yml` runs typecheck and the suite on
ubuntu-latest and windows-latest at Node 22.15, and fails the build if the Node in CI is too old
for the `node:sqlite` isolation test to actually pass rather than skip. A second job builds both
images, runs the full suite plus the `SC_APP_UID` boundary check in a container, boots the
production image, and asserts the app user is refused `platform.db` and that the file is 0600.
Every step was dry-run locally first.

**A footgun found while adding the grant-prefix test.** `src/sandbox-host.mjs` installs its loader
hooks at module scope, so a test that imported it merely to read a flag installed those hooks *in
the test runner*, blocking every later `import('node:...')` in that file. It only showed up on
Linux, because Node 22.14 on the dev box has no `registerHooks` to install. The tests now detect
the capability directly and never load the sandbox host into the runner.

**Still not done**: the rest of M5 -- a public landing/docs site, and the name, license and domain
decisions, which are Mandar's calls (section 13).
