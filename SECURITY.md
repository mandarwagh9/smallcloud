# Security

smallcloud runs code your agents write, on your server, for a handful of people you name.
This document says exactly what that boundary does and does not cover. Every claim in
"What is enforced" has a test in `test/security.test.ts`; run `npm test` to check them.

## Trust model

| Party | Trusted? |
|---|---|
| The person running the instance | fully; they own the box |
| Builders who deploy (owner + editors) | trusted to run code on the instance |
| App code | **not** trusted; treated as hostile and confined |
| Recipients (people opening links) | not trusted; ordinary web visitors |
| Strangers | cannot deploy at all unless you give them an account |

The instance is **not** designed for letting the public deploy code to it. If you need
that, replace the sandbox (see "Swapping the boundary") before opening the door.

## What is enforced

Each app runs in its own Node process started with `--permission` and grants limited to
that app's directory:

| Guarantee | Test |
|---|---|
| An app cannot read files outside its own directory **via `fs`** | `an app cannot read a file outside its own directory` |
| An app cannot read another app's database | `an app cannot read another app's database` |
| An app cannot write outside its own data directory | `an app cannot write outside its data directory` |
| An app cannot spawn a process | `an app cannot spawn a process` |
| An app cannot start a worker thread | `an app cannot start a worker thread` |
| An app receives no platform environment variables (no `SC_SECRET`, no `NODE_OPTIONS`) | `an app does not inherit platform environment variables` |
| `ctx.fetch` refuses localhost, link-local and RFC1918 addresses | `ctx.fetch refuses private network addresses` |
| A request over 10s is killed; the app restarts on the next request | `a runaway request is killed and the app recovers` |
| An app crash never takes the control plane down | `an app that crashes does not take the platform down` |
| Bundle paths cannot escape the app directory | `bundle paths cannot escape the app directory` |
| Static serving cannot escape `public/` | `static serving cannot escape the public directory` |
| `ctx.files` names cannot traverse | `ctx.files rejects names that traverse` |
| A route importing `node:sqlite` (or another denied builtin) is rejected at deploy time | `deploying a route that imports a denied builtin is rejected` |
| An app cannot open the platform database through `node:sqlite` **(Node >= 22.15 only)** | `an app cannot read the platform database through node:sqlite` |
| An app cannot set cookies or platform-wide security headers on the shared origin | `an app cannot set the platform session cookie or other unsafe headers` |
| A file vanishing mid-stream cannot kill the control plane | `a file vanishing mid-stream does not take the control plane down` |
| A filesystem grant does not reach a sibling directory with a longer name | `a filesystem grant does not leak into a sibling directory with a longer name` |
| The device-login token is never stored in a usable form | `the device-login token is not sitting in the database in cleartext` |

Other controls:

- **Memory**: each app process gets a 128 MB heap (`--max-old-space-size`).
- **Authentication**: single-use magic links (15 min), 30-day HttpOnly SameSite=Lax
  session cookies, `Secure` when `SC_BASE_URL` is https. API tokens are stored only as a
  SHA-256 hash and are revocable.
- **Authorization**: one function, `roleFor()`, decides every access. Its full truth table
  is tested in `test/shares.test.ts`. Administration detail (who else an app is shared with,
  which secret keys exist) is returned only to an owner or editor, never to a plain `user`.
- **App response headers**: an app may set content/caching headers and its own `x-*` headers.
  Anything else -- `set-cookie` above all, since apps share an origin with the control plane --
  is dropped and logged to the app.
- **Secrets**: AES-256-GCM at rest, keyed from `SC_SECRET`; decrypted only when handed to
  an app; never returned by the API.
- **Rate limits**: sign-in 5/email and 20/IP per 15 min; deploys 30/hour per account; app
  requests per app per client IP, 3000/min static and 1200/min API (`SC_STATIC_RPM`,
  `SC_API_RPM`). Those match the measured capacity in RUNBOOK.md deliberately -- a limit
  below what the box can serve rejects legitimate traffic, which is what the first load run
  did.
- **CSRF**: form posts are same-origin checked and cookies are SameSite=Lax.

## The `node:sqlite` gap (read this before opening an instance)

**Node's permission model does not cover the native file access inside `node:sqlite`.**
Verified on Node 22.14: with `--permission` active, `fs.readFileSync(platformDb)` fails with
`ERR_ACCESS_DENIED`, while `new DatabaseSync(platformDb)` opens the file and reads it. An app
that does this reads every session id and API token hash on the instance, which is full
account takeover.

Three layers address it. Know which ones you have:

| Layer | Stops | Active when |
|---|---|---|
| Deploy-time guardrail | any route whose source references a denied builtin | always |
| Load-time block (`module.registerHooks`) | the same imports built at runtime, e.g. `import('node:'+'sqlite')` | **Node >= 22.15** |
| OS user separation (`SC_APP_UID`) | all of it, at the kernel, whatever Node does | POSIX, when configured; **on by default in the Docker image** |

The deploy-time guardrail is a guardrail, not a boundary: it is string matching and can be
evaded by an author who wants to. On Node < 22.15 with no `SC_APP_UID`, treat anyone who can
deploy as having read access to the platform database. `npm test` reports this as a skipped
test naming the gap rather than passing.

**Verified on Linux / Node 22.23 (`docker build -f Dockerfile.test`)**: all 54 tests pass with
nothing skipped, and `scripts/verify-uid-isolation.mjs` confirms both layers independently --
the app is stopped with `ERR_MODULE_BLOCKED`, and a plain `node` process running as the app
user with no Node-level protections at all is refused by the kernel. In the production image
`platform.db` and its WAL siblings are `0600` root-owned, each app's `data/` belongs to
uid 10001, and `bundle/` stays root-owned and read-only to the app.

**Recommended production configuration**: Node >= 22.15 (the bundled Docker image) **and**
`SC_APP_UID`/`SC_APP_GID` pointing at a user that cannot read `platform.db` (chmod it 0600
and own it as the platform user). That combination does not depend on the permission model
covering any particular builtin.

## What is not defended in v1

Be honest with yourself about these before you open an instance up.

1. **Hostile deployers.** `--permission` is a useful boundary but it is not a VM, and as the
   section above shows it does not cover every builtin. Someone determined to break out, who
   is allowed to deploy arbitrary code, may manage it. Only let people you trust deploy, and
   configure `SC_APP_UID` if that assumption ever weakens.
2. **Cross-app browser isolation.** All apps share one origin (`/a/<slug>`), so an XSS in
   one app can reach another app's DOM and same-origin requests within that browser. Per-app
   subdomains are the fix and are planned for v1.x. Until then, treat apps deployed to one
   instance as mutually trusting in the browser.
3. **DNS rebinding.** `ctx.fetch` blocks private addresses by hostname and literal IP, not
   by re-resolving after the DNS lookup. A hostile app author could still reach the local
   network with a rebinding trick.
4. **Raw sockets.** `node:net` is denied at deploy time and blocked at load time on Node
   >= 22.15, but on older Node a runtime-built specifier still reaches it, so an app can open
   TCP connections. Every control-plane endpoint requires authentication, so this does not
   by itself grant access to platform data.
5. **Side channels.** No mitigation for timing or resource-contention side channels
   between apps on the same box.
6. **Denial of service by a co-tenant.** An app that burns CPU is killed after 10s, but it
   can slow down the box in the meantime. There is no per-app CPU quota.
7. **Email deliverability as an auth control.** Anyone who can read a recipient's inbox can
   sign in as them. Use `SC_ALLOWED_EMAILS` on private instances.

## Swapping the boundary

`src/runtime.ts` owns process creation and `src/sandbox-host.mjs` owns the `ctx` API.
Replacing the boundary with V8 isolates, gVisor, Firecracker or Workers-for-Platforms means
reimplementing those two files; nothing else in the codebase assumes how isolation works.

## Operational advice

- Set `SC_SECRET` to 32 random bytes and back it up: losing it makes stored secrets
  unreadable. Rotating it requires re-entering every app secret.
- Set `SC_ALLOWED_EMAILS` unless you actually want anyone with an email address to be able
  to sign in (they still see only what is shared with them).
- Put a TLS terminator in front (the bundled Caddy config does this) and set
  `SC_TRUST_PROXY=1` so rate limits see real client IPs.
- Back up the data directory; `scripts/backup.sh` does it consistently.

## Reporting a problem

Open an issue describing the class of problem, or contact the instance owner directly for
anything exploitable. Please do not post working exploits publicly.
