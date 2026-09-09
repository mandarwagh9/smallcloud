# Runbook

Operating a smallcloud instance. It is one Node process, one SQLite database per app, and
one directory. There is nothing else to keep alive.

## Install

```bash
export SC_BASE_URL=https://cloud.example.com     # what people will open
export SC_SECRET=$(openssl rand -hex 32)         # signs sessions, encrypts app secrets
export RESEND_API_KEY=re_...                     # magic-link delivery
export EMAIL_FROM='smallcloud <login@example.com>'
export SC_ALLOWED_EMAILS=you@example.com         # optional, but recommended

# edit Caddyfile to your domain first
docker compose up -d
```

Then open `https://cloud.example.com`, sign in, and connect an agent:

```bash
npx smallcloud login https://cloud.example.com
npx smallcloud mcp-install
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `SC_BASE_URL` | yes in prod | Public URL. Decides link contents and the cookie `Secure` flag. |
| `SC_SECRET` | yes in prod | 32 random bytes. Signs sessions, encrypts app secrets. **Back this up.** |
| `SC_DATA_DIR` | no | Where everything lives. Default `./data`. |
| `PORT` | no | Default 8787. |
| `RESEND_API_KEY` | no | Without it, sign-in links are printed instead of emailed. |
| `EMAIL_FROM` | no | Sender for magic links. |
| `SC_ALLOWED_EMAILS` | no | Comma-separated allowlist. Empty means anyone may sign in. |
| `SC_TRUST_PROXY` | no | Set to `1` behind a reverse proxy so rate limits see real IPs. |

## Backups

Everything is in `SC_DATA_DIR`:

```
platform.db              accounts, sessions, tokens, apps, shares, secrets, logs
apps/<id>/bundle/        the deployed code
apps/<id>/data/app.db    that app's database
apps/<id>/data/files/    that app's uploaded files
```

```bash
./scripts/backup.sh /data /backups          # nightly via cron
```

It uses `VACUUM INTO` per database, so a running server cannot leave a torn page in the
archive. Restore by stopping the server, extracting over the data directory, and starting.

**Test a restore before you need one.** Extract into an empty directory, point a local
server at it, and check that an app still answers.

## Upgrades

```bash
git pull
docker compose build && docker compose up -d
```

Schema migrations run at boot (`create table if not exists`). App processes are lazy, so
they pick up the new runtime on the next request. Zero-downtime is not a goal; a restart
drops in-flight requests to running apps.

## Day-to-day

| Task | How |
|---|---|
| Is it up? | `curl -s https://.../health` |
| How much is on it? | `curl -s https://.../v1/stats` |
| Which apps are running? | `/health` reports the count; app processes stop after 60s idle |
| Read an app's logs | the app's manage page, or `npx smallcloud logs <app>` |
| Inspect an app's data | `npx smallcloud db <app> "select * from todos"` |
| Remove someone's access | manage page, or `npx smallcloud unshare <app> <email>` |
| Revoke an agent's token | `/me/tokens`, or delete rows from `api_tokens` |

## Troubleshooting

**Sign-in emails do not arrive.** Check `RESEND_API_KEY` and that `EMAIL_FROM` uses a
domain verified with the provider. Without a key the server logs the link instead: read it
from `docker compose logs smallcloud`.

**An app returns 504.** It ran longer than 10 seconds. The process was killed and the next
request starts a fresh one. Look for an infinite loop or a slow external call; there is no
way to raise the limit without editing `REQUEST_TIMEOUT_MS` in `src/runtime.ts`.

**An app returns 500 `app_crashed`.** The process exited mid-request, usually an OOM
against the 128 MB heap. Check the app's logs.

**An app returns 503 `restarted`.** Expected briefly after a deploy or a secret change:
the old process is stopped so the next request picks up the new code. Retry.

**`ERR_ACCESS_DENIED` in an app's logs.** The app tried to read or write outside its own
directory. That is the sandbox working as intended; fix the app to use `ctx.files` or
`ctx.db`.

**Deploy fails with `bad_path`.** The bundle has files outside `app.json`, `public/` or
`api/`, or an `api/` file in a subdirectory. The error message names the file.

**Everything is slow.** One box, one CPU. Check whether an app is spinning:
`docker compose exec smallcloud ps aux`. Each app process is one `node` with
`--permission` in its arguments.

## Rotating `SC_SECRET`

There is no automatic re-encryption yet. Rotating invalidates every session and every
stored app secret. Set the new value, restart, and re-enter each app's secrets from its
manage page. Everything else (apps, data, shares) is unaffected.

## Capacity

A 1 vCPU / 1 GB VPS comfortably runs a few dozen small apps for a few dozen people. Each
*active* app holds a process with up to 128 MB of heap; idle apps hold nothing. If you
expect more than about ten apps busy at once, give the box more memory.
