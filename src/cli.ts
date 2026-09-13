import { resolve, basename } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readDirAsFiles } from './apps.js';
import { ApiError, Client, deployFiles, deviceLogin, loadConfig, requireConfig, saveConfig } from './client.js';
import { configFromEnv } from './config.js';
import { createHttpServer, createServices } from './server.js';
import { CONTRACT } from './contract.js';

const USAGE = `smallcloud - a cloud for small software

  smallcloud serve                        run the server (reads .env / environment)
  smallcloud login [url]                  connect this machine to a server
  smallcloud deploy <dir> [--app <id>]    deploy or update an app
  smallcloud list                         apps you own or that are shared with you
  smallcloud open <app>                   print an app's URL
  smallcloud share <app> <who> [role]     who = email | domain:example.com | public; role = user | editor
  smallcloud unshare <app> <who>
  smallcloud logs <app> [--limit N]
  smallcloud db <app> "<sql>"             run SQL against the app's database
  smallcloud secrets set <app> KEY=value
  smallcloud secrets rm <app> KEY
  smallcloud export <app> [file.zip]
  smallcloud delete <app>
  smallcloud tokens                       list your agent tokens
  smallcloud tokens rm <id>               revoke one agent token
  smallcloud contract                     print the app contract
  smallcloud mcp                          run the MCP server on stdio
  smallcloud mcp-install                  register this server with Claude Code
`;

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice();
  const cmd = args.shift();
  const flags = takeFlags(args);

  try {
    switch (cmd) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return 0;

      case 'serve':
        return await serve();

      case 'contract':
        process.stdout.write(CONTRACT);
        return 0;

      case 'login': {
        const url = (args[0] ?? loadConfig()?.url ?? 'http://localhost:8787').replace(/\/$/, '');
        process.stdout.write(`Connecting to ${url}\n`);
        const token = await deviceLogin(url, {
          open: (u) => {
            process.stdout.write(`\nApprove this login in your browser:\n  ${u}\n\nWaiting...\n`);
            tryOpenBrowser(u);
          },
        });
        const path = saveConfig({ url, token });
        const me = await new Client({ url, token }).request<{ email: string }>('GET', '/v1/me');
        process.stdout.write(`\nSigned in as ${me.email}. Token saved to ${path}\n`);
        return 0;
      }

      case 'deploy': {
        const dir = resolve(args[0] ?? '.');
        if (!existsSync(dir)) return fail(`no such folder: ${dir}`);
        const client = new Client(requireConfig());
        const { app, recreated } = await deployFiles(client, dir, readDirAsFiles(dir), flags.get('app'));
        const verb = recreated
          ? 'Redeployed as a new app (the one this folder pointed at is gone)'
          : app.version > 1
            ? 'Updated'
            : 'Deployed';
        process.stdout.write(`${verb} ${app.name} (v${app.version})\n  ${app.url}\n  id ${app.id}\n`);
        return 0;
      }

      case 'list': {
        const { apps } = await new Client(requireConfig()).list();
        if (!apps.length) {
          process.stdout.write('No apps yet. Deploy one: smallcloud deploy ./my-app\n');
          return 0;
        }
        for (const a of apps) {
          process.stdout.write(`${a.slug.padEnd(24)} v${String(a.version).padEnd(3)} ${a.relation === 'shared' ? 'shared ' : 'owner  '} ${a.url}\n`);
        }
        return 0;
      }

      case 'open': {
        const app = await new Client(requireConfig()).get(need(args[0], 'name an app'));
        process.stdout.write(app.url + '\n');
        tryOpenBrowser(app.url);
        return 0;
      }

      case 'share': {
        const client = new Client(requireConfig());
        const out = await client.share(need(args[0], 'name an app'), need(args[1], 'name who to share with'), args[2] ?? 'user');
        process.stdout.write(`Shared. Send them this link:\n  ${out.url}\n`);
        return 0;
      }

      case 'unshare': {
        await new Client(requireConfig()).unshare(need(args[0], 'name an app'), need(args[1], 'name who to remove'));
        process.stdout.write('Removed.\n');
        return 0;
      }

      case 'logs': {
        const { logs } = await new Client(requireConfig()).logs(need(args[0], 'name an app'), Number(flags.get('limit') ?? 100));
        for (const l of logs) process.stdout.write(`${new Date(l.at).toISOString()} ${l.level.padEnd(5)} ${l.msg}\n`);
        if (!logs.length) process.stdout.write('No log lines yet.\n');
        return 0;
      }

      case 'db': {
        const out = await new Client(requireConfig()).sql(need(args[0], 'name an app'), need(args[1], 'give some SQL'));
        process.stdout.write(JSON.stringify(out.rows ?? out, null, 2) + '\n');
        return 0;
      }

      case 'secrets': {
        const client = new Client(requireConfig());
        const sub = args.shift();
        if (sub === 'set') {
          const app = need(args[0], 'name an app');
          const pair = need(args[1], 'give KEY=value');
          const i = pair.indexOf('=');
          if (i < 1) return fail('secrets set expects KEY=value');
          const out = await client.setSecret(app, pair.slice(0, i), pair.slice(i + 1));
          process.stdout.write(`Secrets: ${out.keys.join(', ') || 'none'}\n`);
          return 0;
        }
        if (sub === 'rm') {
          const out = await client.deleteSecret(need(args[0], 'name an app'), need(args[1], 'name the key'));
          process.stdout.write(`Secrets: ${out.keys.join(', ') || 'none'}\n`);
          return 0;
        }
        return fail('use: smallcloud secrets set <app> KEY=value | smallcloud secrets rm <app> KEY');
      }

      case 'export': {
        const client = new Client(requireConfig());
        const app = need(args[0], 'name an app');
        const buf = await client.exportZip(app);
        const out = resolve(args[1] ?? `${basename(app)}.zip`);
        writeFileSync(out, buf);
        process.stdout.write(`Wrote ${out} (${buf.length} bytes)\n`);
        return 0;
      }

      case 'delete': {
        await new Client(requireConfig()).remove(need(args[0], 'name an app'));
        process.stdout.write('Deleted.\n');
        return 0;
      }

      case 'tokens': {
        const client = new Client(requireConfig());
        const sub = args.shift();
        if (sub === 'rm') {
          await client.revokeToken(need(args[0], 'give a token id'));
          process.stdout.write('Revoked.\n');
          return 0;
        }
        const { tokens } = await client.listTokens();
        if (!tokens.length) {
          process.stdout.write('No tokens.\n');
          return 0;
        }
        for (const t of tokens) {
          process.stdout.write(`${(t.id ?? '(legacy)').padEnd(10)} ${t.name.padEnd(20)} ${t.lastUsed ? 'used ' + new Date(t.lastUsed).toISOString() : 'never used'}\n`);
        }
        return 0;
      }

      case 'mcp': {
        const { runMcpServer } = await import('./mcp.js');
        await runMcpServer();
        return 0;
      }

      case 'mcp-install': {
        const { installMcp } = await import('./mcp.js');
        process.stdout.write(installMcp() + '\n');
        return 0;
      }

      default:
        return fail(`unknown command "${cmd}"\n\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof ApiError) return fail(`${err.code}: ${err.message}`);
    throw err;
  }
}

async function serve(): Promise<number> {
  const cfg = configFromEnv();
  if (process.env.NODE_ENV === 'production' && !process.env.RESEND_API_KEY) {
    throw new Error(
      'RESEND_API_KEY is required in production: without it, sign-in links cannot be emailed and nobody could sign in. Set it, or run a local dev instance.',
    );
  }
  const services = createServices(cfg);
  const server = createHttpServer(services);
  await new Promise<void>((r) => server.listen(cfg.port, r));
  process.stdout.write(`smallcloud listening on ${cfg.baseUrl}\n  data: ${cfg.dataDir}\n`);
  if (!process.env.RESEND_API_KEY) process.stdout.write('  mail: no RESEND_API_KEY, sign-in links are printed here and shown in the browser\n');
  if (cfg.allowedEmails.length) process.stdout.write(`  allowed: ${cfg.allowedEmails.join(', ')}\n`);
  const shutdown = () => {
    services.runtime.stopAll();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => 0); // run until signalled
}

function takeFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; ) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        args.splice(i, 1);
      } else {
        flags.set(a.slice(2), args[i + 1] ?? '');
        args.splice(i, 2);
      }
    } else i++;
  }
  return flags;
}

function need(v: string | undefined, message: string): string {
  if (!v) throw new ApiError(400, 'usage', message);
  return v;
}

function fail(message: string): number {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  return 1;
}

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
