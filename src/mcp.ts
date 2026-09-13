import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readDirAsFiles } from './apps.js';
import { ApiError, Client, deployFiles, requireConfig } from './client.js';
import { CONTRACT } from './contract.js';

const RULES =
  'smallcloud hosts small apps: a folder with app.json, public/ (frontend) and api/*.js (routes) becomes a URL you can share. ' +
  'Call smallcloud_contract first if you have not read the contract in this session.';

function client(): Client {
  return new Client(requireConfig());
}

/** Uniform result shape: agents get either JSON they can act on, or an error naming the fix. */
async function run(fn: () => Promise<unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const out = await fn();
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
  } catch (err) {
    const message = err instanceof ApiError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'smallcloud', version: '0.1.0' });

  server.tool('smallcloud_contract', `Read the smallcloud app contract: folder layout, the req/ctx API, limits. ${RULES}`, {}, () =>
    run(async () => CONTRACT),
  );

  server.tool(
    'smallcloud_deploy',
    `Deploy a folder as an app and get back its URL. Redeploys keep the same URL, database and files. ${RULES}`,
    {
      dir: z.string().describe('absolute path to the app folder (must contain app.json)'),
      appId: z.string().optional().describe('update this existing app instead of creating a new one; omit to reuse the id pinned in the folder'),
    },
    ({ dir, appId }) =>
      run(async () => {
        const { app, recreated } = await deployFiles(client(), dir, readDirAsFiles(dir), appId);
        return {
          ...app,
          ...(recreated ? { note: 'the app this folder previously pointed at no longer exists, so a new one was created' } : {}),
          next: 'open the url to check it works, then share it with smallcloud_share',
        };
      }),
  );

  server.tool('smallcloud_list', 'List apps you own or that are shared with you.', {}, () => run(async () => (await client().list()).apps));

  server.tool(
    'smallcloud_get',
    'Details for one app: url, version, who it is shared with, which secret keys are set.',
    { app: z.string().describe('app id or slug') },
    ({ app }) => run(async () => client().get(app)),
  );

  server.tool(
    'smallcloud_source',
    'Read the deployed files back, so you can revise an app you did not write in this session.',
    { app: z.string().describe('app id or slug') },
    ({ app }) => run(async () => client().source(app)),
  );

  server.tool(
    'smallcloud_logs',
    'Recent log lines for an app: ctx.log output, uncaught errors, deploys. Read this first when an app misbehaves.',
    { app: z.string().describe('app id or slug'), limit: z.number().optional().describe('how many lines, default 100') },
    ({ app, limit }) => run(async () => (await client().logs(app, limit ?? 100)).logs),
  );

  server.tool(
    'smallcloud_share',
    'Give someone access. principal is an email, "domain:example.com", or "public" (anyone with the link).',
    {
      app: z.string().describe('app id or slug'),
      principal: z.string().describe('bob@example.com | domain:example.com | public'),
      role: z.enum(['user', 'editor']).optional().describe('user = can open it (default); editor = can also redeploy and manage sharing'),
    },
    ({ app, principal, role }) => run(async () => client().share(app, principal, role ?? 'user')),
  );

  server.tool(
    'smallcloud_unshare',
    'Remove someone’s access.',
    { app: z.string().describe('app id or slug'), principal: z.string().describe('who to remove') },
    ({ app, principal }) => run(async () => client().unshare(app, principal)),
  );

  server.tool(
    'smallcloud_secret_set',
    'Store a secret for an app. It reaches the app as ctx.env.KEY and never appears in the code.',
    { app: z.string().describe('app id or slug'), key: z.string().describe('UPPER_SNAKE_CASE'), value: z.string() },
    ({ app, key, value }) => run(async () => client().setSecret(app, key, value)),
  );

  server.tool(
    'smallcloud_db',
    'Run SQL against an app’s own database. Use it to inspect data or fix it while debugging.',
    { app: z.string().describe('app id or slug'), sql: z.string(), params: z.array(z.union([z.string(), z.number(), z.null()])).optional() },
    ({ app, sql, params }) => run(async () => client().sql(app, sql, params ?? [])),
  );

  server.tool(
    'smallcloud_delete',
    'Delete an app and all of its data. Only the owner can do this and it cannot be undone.',
    { app: z.string().describe('app id or slug') },
    ({ app }) => run(async () => client().remove(app)),
  );

  server.tool(
    'smallcloud_export',
    'Download an app as a zip (its source, database and uploaded files) to a local path -- the way to leave with everything.',
    { app: z.string().describe('app id or slug'), dest: z.string().describe('absolute path to write the .zip to, e.g. /tmp/todo.zip') },
    ({ app, dest }) =>
      run(async () => {
        const buf = await client().exportZip(app);
        writeFileSync(dest, buf);
        return { wrote: dest, bytes: buf.length };
      }),
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
}

/** Registers this server with Claude Code, using whatever `claude` is on PATH. */
export function installMcp(): string {
  const cfg = requireConfig();
  const bin = process.argv[1];
  // Resolve the real claude binary and run it WITHOUT a shell. Going through cmd.exe on Windows
  // re-parses the argv, and the space in "C:\Program Files\nodejs\node.exe" (process.execPath)
  // splits the command -- storing a broken, unlaunchable registration while reporting success.
  // No shell means we either register a correct command or fall through to printing the config.
  let claudeBin = null;
  try {
    const which = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    claudeBin = execSync(which, { encoding: 'utf8' }).split(String.fromCharCode(10)).map((l) => l.trim()).find(Boolean) || null;
  } catch {
    claudeBin = null;
  }
  try {
    if (!claudeBin) throw new Error('claude not found on PATH');
    execFileSync(
      claudeBin,
      ['mcp', 'add', 'smallcloud', '--scope', 'user', '--env', `SMALLCLOUD_URL=${cfg.url}`, '--env', `SMALLCLOUD_TOKEN=${cfg.token}`, '--', process.execPath, bin, 'mcp'],
      { stdio: 'inherit' },
    );
    return 'Registered the smallcloud MCP server with Claude Code. Restart Claude Code to pick it up.';
  } catch {
    return [
      'Could not run `claude mcp add`. Add this to your MCP config by hand:',
      JSON.stringify(
        { mcpServers: { smallcloud: { command: process.execPath, args: [bin, 'mcp'], env: { SMALLCLOUD_URL: cfg.url, SMALLCLOUD_TOKEN: cfg.token } } } },
        null,
        2,
      ),
    ].join('\n');
  }
}
