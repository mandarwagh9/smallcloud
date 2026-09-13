import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer, createServices, type Services } from '../src/server.js';
import { consoleMailer } from '../src/email.js';
import type { AppFile } from '../src/types.js';

export interface Harness {
  base: string;
  services: Services;
  server: Server;
  mail: ReturnType<typeof consoleMailer>;
  tokenFor(email: string): string;
  close(): Promise<void>;
  fetch(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  json<T = any>(path: string, init?: RequestInit & { token?: string }): Promise<{ status: number; body: T }>;
}

/** A real server on a random port with its own temp data dir. */
export async function startHarness(env: Partial<Record<string, string>> = {}, mailer?: import('../src/email.js').Mailer): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'smallcloud-test-'));
  const mail = (mailer as ReturnType<typeof consoleMailer>) ?? consoleMailer(() => {});
  const cfg = {
    dataDir,
    baseUrl: 'http://127.0.0.1:0',
    port: 0,
    secret: 'test-secret-0123456789',
    allowedEmails: env.SC_ALLOWED_EMAILS ? env.SC_ALLOWED_EMAILS.split(',') : [],
    trustProxy: false,
    staticRpm: 100000,
    apiRpm: 100000,
    deployPerHour: 100000,
    appQuotaBytes: 100 * 1024 * 1024,
    appMaxFiles: 10000,
  };
  const services = createServices(cfg, mail);
  const server = createHttpServer(services);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  // the base url is used to build links and to resolve request URLs, so fix it now that we have a port
  services.cfg.baseUrl = base;
  (services.auth as unknown as { baseUrl: string }).baseUrl = base;

  const h: Harness = {
    base,
    services,
    server,
    mail,
    tokenFor: (email: string) => services.auth.createApiToken(email, 'test'),
    async close() {
      services.runtime.stopAll();
      await new Promise<void>((r) => server.close(() => r()));
      services.db.close();
      // On Windows a just-SIGKILLed app child can still hold app.db open for a few ms, so a
      // plain rmSync races it with EBUSY. maxRetries/retryDelay is Node's built-in answer, and
      // force:true swallows a file that is genuinely gone. This is teardown only.
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } catch {
        // A temp dir we could not remove is the OS's problem to clean up, not a test failure.
      }
    },
    fetch(path, init = {}) {
      const { token, headers, ...rest } = init as RequestInit & { token?: string };
      return fetch(`${base}${path}`, {
        ...rest,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers as Record<string, string>) },
        redirect: 'manual',
      });
    },
    async json(path, init = {}) {
      const res = await h.fetch(path, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
  return h;
}

export function todoBundle(name = 'Todo'): AppFile[] {
  return [
    { path: 'app.json', content: JSON.stringify({ name, description: 'test app' }) },
    { path: 'public/index.html', content: '<!doctype html><h1>todo</h1>' },
    {
      path: 'api/todos.js',
      content: `export default async function (req, ctx) {
        ctx.db.exec('create table if not exists todos (id integer primary key, text text, who text)');
        if (req.method === 'POST') {
          const { text } = req.json();
          ctx.db.run('insert into todos (text, who) values (?, ?)', text, ctx.user ? ctx.user.email : 'anon');
        }
        return { json: { you: ctx.user ? ctx.user.email : null, todos: ctx.db.all('select * from todos order by id') } };
      }`,
    },
  ];
}

export function bundle(files: Record<string, string>): AppFile[] {
  return Object.entries(files).map(([path, content]) => ({ path, content }));
}

/** Post a bundle and return the created app. */
export async function deploy(h: Harness, token: string, files: AppFile[], appId?: string) {
  const { status, body } = await h.json('/v1/apps', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files, appId }),
  });
  if (status >= 400) throw new Error(`deploy failed ${status}: ${JSON.stringify(body)}`);
  return body as { id: string; slug: string; url: string; version: number; name: string };
}
