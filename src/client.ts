import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppFile } from './types.js';

export interface ClientConfig {
  url: string;
  token: string;
}

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner: string;
  version: number;
  url: string;
  updatedAt: number;
  relation?: 'owner' | 'shared';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const CONFIG_PATH = join(homedir(), '.smallcloud', 'config.json');

export function loadConfig(): ClientConfig | null {
  if (process.env.SMALLCLOUD_URL && process.env.SMALLCLOUD_TOKEN) {
    return { url: process.env.SMALLCLOUD_URL.replace(/\/$/, ''), token: process.env.SMALLCLOUD_TOKEN };
  }
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as ClientConfig;
    return c.url && c.token ? { url: c.url.replace(/\/$/, ''), token: c.token } : null;
  } catch {
    return null;
  }
}

export function saveConfig(c: ClientConfig): string {
  // This file holds a bearer token that authorizes everything the account can do and never
  // expires, so it must not be readable by other accounts on a shared box. writeFileSync keeps
  // an existing file's mode, hence the explicit chmod: it repairs configs written before this.
  mkdirSync(join(homedir(), '.smallcloud'), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(CONFIG_PATH, 0o600);
    } catch {
      // A filesystem without POSIX modes is not a reason to fail the login.
    }
  }
  return CONFIG_PATH;
}

export function requireConfig(): ClientConfig {
  const c = loadConfig();
  if (!c) throw new ApiError(401, 'not_logged_in', 'Not signed in. Run: smallcloud login <server-url>');
  return c;
}

export class Client {
  constructor(private cfg: ClientConfig) {}

  get baseUrl(): string {
    return this.cfg.url;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'unreachable', `could not reach ${this.cfg.url} (${(err as Error).message}). Is the server running? Check SMALLCLOUD_URL, or run: smallcloud login <url>`);
    }
    const text = await res.text();
    const json = text ? safeParse(text) : {};
    if (!res.ok) {
      const e = json as { error?: string; message?: string };
      throw new ApiError(res.status, e.error ?? 'http_error', e.message ?? `${res.status} ${res.statusText}`);
    }
    return json as T;
  }

  deploy(files: AppFile[], appId?: string): Promise<AppSummary> {
    return this.request<AppSummary>('POST', '/v1/apps', { files, appId });
  }

  list(): Promise<{ apps: AppSummary[] }> {
    return this.request('GET', '/v1/apps');
  }

  get(id: string): Promise<AppSummary & { shares: Array<{ principal: string; role: string }>; secretKeys: string[] }> {
    return this.request('GET', `/v1/apps/${encodeURIComponent(id)}`);
  }

  source(id: string): Promise<{ files: AppFile[]; version: number }> {
    return this.request('GET', `/v1/apps/${encodeURIComponent(id)}/source`);
  }

  logs(id: string, limit = 100): Promise<{ logs: Array<{ at: number; level: string; msg: string }> }> {
    return this.request('GET', `/v1/apps/${encodeURIComponent(id)}/logs?limit=${limit}`);
  }

  share(id: string, principal: string, role = 'user'): Promise<{ share: unknown; url: string }> {
    return this.request('PUT', `/v1/apps/${encodeURIComponent(id)}/shares`, { principal, role });
  }

  unshare(id: string, principal: string): Promise<unknown> {
    return this.request('DELETE', `/v1/apps/${encodeURIComponent(id)}/shares`, { principal });
  }

  setSecret(id: string, key: string, value: string): Promise<{ keys: string[] }> {
    return this.request('PUT', `/v1/apps/${encodeURIComponent(id)}/secrets`, { key, value });
  }

  deleteSecret(id: string, key: string): Promise<{ keys: string[] }> {
    return this.request('DELETE', `/v1/apps/${encodeURIComponent(id)}/secrets`, { key });
  }

  sql(id: string, sql: string, params: unknown[] = []): Promise<{ rows?: unknown[]; changes?: number }> {
    return this.request('POST', `/v1/apps/${encodeURIComponent(id)}/db`, { sql, params });
  }

  remove(id: string): Promise<unknown> {
    return this.request('DELETE', `/v1/apps/${encodeURIComponent(id)}`);
  }

  contract(): Promise<string> {
    return fetch(`${this.cfg.url}/v1/contract`).then((r) => r.text());
  }

  async exportZip(id: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/v1/apps/${encodeURIComponent(id)}/export`, {
        headers: { authorization: `Bearer ${this.cfg.token}` },
      });
    } catch (err) {
      throw new ApiError(0, 'unreachable', `could not reach ${this.cfg.url} (${(err as Error).message}). Is the server running?`);
    }
    if (!res.ok) throw new ApiError(res.status, 'export_failed', await res.text());
    return Buffer.from(await res.arrayBuffer());
  }
}

function safeParse(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return { message: t.slice(0, 500) };
  }
}

/** Device flow: ask the server for a code, have a browser approve it, poll for the token. */
export async function deviceLogin(url: string, opts: { open?: (u: string) => void; pollMs?: number; timeoutMs?: number } = {}): Promise<string> {
  const base = url.replace(/\/$/, '');
  const start = await fetch(`${base}/v1/cli-login`, { method: 'POST' });
  if (!start.ok) throw new ApiError(start.status, 'login_failed', `could not reach ${base}`);
  const { code, url: approveUrl } = (await start.json()) as { code: string; url: string };
  opts.open?.(approveUrl);
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
    const res = await fetch(`${base}/v1/cli-login/${code}`);
    if (!res.ok) throw new ApiError(res.status, 'login_expired', 'the login code expired; run login again');
    const body = (await res.json()) as { status: string; token?: string };
    if (body.status === 'approved' && body.token) return body.token;
  }
  throw new ApiError(408, 'login_timeout', 'nobody approved the login in time');
}

/**
 * Deploy a folder, honouring the per-folder pin.
 *
 * If the pinned app is gone -- deleted, or the pin points at a different server -- this makes
 * a new app rather than failing. An explicit --app id is treated as deliberate and still errors,
 * because silently creating a second app under a name the caller chose would be worse.
 */
export async function deployFiles(
  client: Client,
  dir: string,
  files: AppFile[],
  explicitAppId?: string,
): Promise<{ app: AppSummary; recreated: boolean }> {
  const pinned = explicitAppId ?? readAppPin(dir) ?? undefined;
  try {
    const app = await client.deploy(files, pinned);
    writeAppPin(dir, app.id, app.url);
    return { app, recreated: false };
  } catch (err) {
    const stalePin = err instanceof ApiError && err.code === 'not_found' && pinned && !explicitAppId;
    if (!stalePin) throw err;
    const app = await client.deploy(files);
    writeAppPin(dir, app.id, app.url);
    return { app, recreated: true };
  }
}

/** Per-folder pin so a second deploy updates the same app instead of creating a new one. */
export function readAppPin(dir: string): string | null {
  const p = join(dir, '.smallcloud.json');
  if (!existsSync(p)) return null;
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as { appId?: string }).appId ?? null;
  } catch {
    return null;
  }
}

export function writeAppPin(dir: string, appId: string, url: string): void {
  writeFileSync(join(dir, '.smallcloud.json'), JSON.stringify({ appId, url }, null, 2) + '\n');
}
