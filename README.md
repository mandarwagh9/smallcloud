# smallcloud

[![CI](https://github.com/mandarwagh9/smallcloud/actions/workflows/ci.yml/badge.svg)](https://github.com/mandarwagh9/smallcloud/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-3c873a)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-83%20passing-0f6f5c)](docs/PLAN.md)
[![License](https://img.shields.io/badge/license-UNLICENSED-9a3412)](package.json)

A cloud for small software.

Your agent hands this server a folder. It hands back a link you can send to someone.
Hosting, a database, file storage, sign-in, sharing and secrets are already there.

Building a small tool takes minutes now. Deploying one still takes hours of glue across
five vendors, and that glue is the part an agent cannot finish on its own. smallcloud is
one self-hosted process that removes it.

```
npx smallcloud login https://cloud.example.com
npx smallcloud deploy ./my-app
# -> https://cloud.example.com/a/my-app
npx smallcloud share my-app bob@example.com
```

Bob gets a link, signs in with his email, and uses the tool. Your app sees him as
`ctx.user.email`.

## What an app is

```
my-app/
  app.json            {"name": "Todo"}
  public/index.html   the frontend: plain HTML/CSS/JS, no build step
  api/todos.js        one file per route
```

```js
// api/todos.js
export default async function (req, ctx) {
  ctx.db.exec('create table if not exists todos (id integer primary key, text text, who text)');
  if (req.method === 'POST') {
    ctx.db.run('insert into todos (text, who) values (?, ?)', req.json().text, ctx.user.email);
  }
  return { json: ctx.db.all('select * from todos order by id desc') };
}
```

That is the whole thing. No Dockerfile, no database to provision, no auth library, no
environment variables to wire up. `ctx.db` is this app's own SQLite database, `ctx.files`
is its own file storage, `ctx.user` is whoever is signed in, `ctx.env` is the secrets you
set. Read [the full contract](src/contract.ts) or `GET /v1/contract` on a running server.

## Run it

```bash
git clone <this repo> && cd smallcloud
npm install
cp .env.example .env      # then edit SC_SECRET at least
npm run dev               # http://localhost:8787
```

With no `RESEND_API_KEY` set, sign-in links are printed to the console and shown in the
browser, so you can use it locally without an email provider.

In production, one container and one volume:

```bash
export SC_BASE_URL=https://cloud.example.com
export SC_SECRET=$(openssl rand -hex 32)
export RESEND_API_KEY=...        # for magic links
docker compose up -d             # includes Caddy for TLS
```

See [RUNBOOK.md](RUNBOOK.md) for backups, upgrades and troubleshooting.

## Use it from an agent

smallcloud ships an MCP server, so a coding agent can deploy, share and debug without a
human in the loop:

```bash
npx smallcloud login https://cloud.example.com
npx smallcloud mcp-install        # registers with Claude Code
```

The agent then has `smallcloud_deploy`, `smallcloud_share`, `smallcloud_logs`,
`smallcloud_source`, `smallcloud_db`, `smallcloud_secret_set` and the rest. Point it at
[AGENTS.md](AGENTS.md) and ask for a tool.

## Sharing

| Share with | Who gets in |
|---|---|
| `bob@example.com` | just Bob, after he signs in |
| `domain:example.com` | anyone with an email at that domain |
| `public` | anyone with the link, no sign-in |

Roles are `user` (can open it) and `editor` (can also redeploy and manage sharing).
The owner can additionally delete the app.

## What it deliberately is not

Requires Node >= 22.15. Not a scale-out cloud. Not a place to let strangers deploy code. Not a code generator, and
not a no-code builder. It is the deploy-and-share layer for software that will only ever
have a few users. Read [SECURITY.md](SECURITY.md) for the isolation boundary and its
limits before you open an instance to anyone you would not hand a shell.

## Leaving

```bash
npx smallcloud export my-app
```

A zip with your source, your SQLite database and your uploaded files. Nothing in an app is
smallcloud-specific except the `ctx` object, which is about forty lines to reimplement.

## Development

```bash
npm test               # 83 tests: unit, ACL matrix, isolation, and the end-to-end journeys
npm run typecheck
npm run build

npm run eval:cold-agent -- --runs 3   # give a fresh agent only the MCP server and grade what it ships
```

The cold agent test is the real measure of whether the contract explains the platform: it hands a
brand-new headless Claude Code session nothing but the MCP server and an empty folder, then grades
the deployed app over HTTP. It already caught a bug no unit test would have (a missing
trailing-slash redirect that broke every app at the exact URL its recipients were given).

The plan this was built from, including architecture decisions and what is deferred, is in
[docs/PLAN.md](docs/PLAN.md).
