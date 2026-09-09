import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, chownSync, statSync, readdirSync } from 'node:fs';
import type { Apps } from './apps.js';
import type { RouteRequest, RouteResponse, User } from './types.js';

export const REQUEST_TIMEOUT_MS = 10_000;
export const IDLE_SHUTDOWN_MS = 60_000;
export const MAX_HEAP_MB = 128;

/** sandbox-host.mjs sits next to this module: src/ under tsx, dist/ after a build. */
function hostScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'sandbox-host.mjs');
}

export class SqlError extends Error {}

interface Pending {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Host {
  child: ChildProcess;
  pending: Map<number, Pending>;
  idleTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

export class Runtime {
  private hosts = new Map<string, Host>();
  private nextInvokeId = 1;

  constructor(
    private apps: Apps,
    private isolation: { appUid?: number; appGid?: number } = {},
  ) {}

  /** Run one request inside the app's own process, starting it if needed. */
  async invoke(appId: string, request: RouteRequest, user: User | null, env: Record<string, string>): Promise<RouteResponse> {
    return this.send<RouteResponse>(
      appId,
      (invokeId) => ({ t: 'invoke', invokeId, request, user, env }),
      (invokeId) => {
        this.apps.log(appId, 'error', `request timed out after ${REQUEST_TIMEOUT_MS}ms: ${request.method} ${request.path}`);
        void invokeId;
        return {
          status: 504,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'timeout', message: `the app took longer than ${REQUEST_TIMEOUT_MS / 1000}s to respond` }),
        };
      },
    );
  }

  /**
   * Run SQL against an app's database for an owner or editor.
   * This deliberately goes through the app's own sandboxed process: statements such as
   * VACUUM INTO and ATTACH can write files, and only inside that process are they confined
   * to the app's own directory. Running them in the control plane would hand an editor the
   * platform's filesystem access.
   */
  async sql(appId: string, sql: string, params: unknown[] = []): Promise<{ rows?: unknown[]; changes?: number }> {
    const out = await this.send<{ ok: boolean; result?: { rows?: unknown[]; changes?: number }; message?: string; timedOut?: boolean }>(
      appId,
      (invokeId) => ({ t: 'sql', invokeId, sql, params }),
      () => ({ ok: false, message: `the query took longer than ${REQUEST_TIMEOUT_MS / 1000}s`, timedOut: true }),
    );
    if (!out.ok) throw new SqlError(out.message ?? 'query failed');
    return out.result ?? {};
  }

  /** Stop an app's process (called on redeploy, delete, timeout, and shutdown). */
  stop(appId: string): void {
    const host = this.hosts.get(appId);
    if (!host) return;
    host.stopping = true;
    this.hosts.delete(appId);
    if (host.idleTimer) clearTimeout(host.idleTimer);
    for (const [, p] of host.pending) {
      clearTimeout(p.timer);
      p.resolve({
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'restarted', message: 'the app was restarted while this request was running; try again' }),
        ok: false,
        message: 'the app was restarted while this query was running; try again',
      });
    }
    host.pending.clear();
    host.child.removeAllListeners();
    host.child.kill('SIGKILL');
  }

  stopAll(): void {
    for (const appId of [...this.hosts.keys()]) this.stop(appId);
  }

  running(): string[] {
    return [...this.hosts.keys()];
  }

  // ---- internals ----------------------------------------------------------

  /** Send one message to an app host and wait for the matching reply. */
  private send<T>(appId: string, build: (invokeId: number) => object, onTimeout: (invokeId: number) => T): Promise<T> {
    const host = this.hostFor(appId);
    const invokeId = this.nextInvokeId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(invokeId);
        // A runaway synchronous loop cannot be interrupted from outside, so the process goes.
        // Other in-flight work for this app dies with it (docs/PLAN.md D11).
        this.stop(appId);
        resolve(onTimeout(invokeId));
      }, REQUEST_TIMEOUT_MS);
      host.pending.set(invokeId, { resolve: resolve as (r: any) => void, reject, timer });
      this.touch(appId, host);
      try {
        host.child.send(build(invokeId));
      } catch (err) {
        clearTimeout(timer);
        host.pending.delete(invokeId);
        reject(err as Error);
      }
    });
  }

  private hostFor(appId: string): Host {
    const existing = this.hosts.get(appId);
    if (existing && existing.child.connected) return existing;
    if (existing) this.stop(appId);
    return this.start(appId);
  }

  private start(appId: string): Host {
    const paths = this.apps.paths(appId);
    mkdirSync(paths.files, { recursive: true });
    if (!existsSync(paths.bundle)) throw new Error(`app ${appId} has no deployed bundle`);
    // The control plane creates these directories, so under SC_APP_UID they would belong to
    // the platform user and the app could not write its own database. Only data/ changes
    // hands: bundle/ stays owned by the platform and is read-only to the app.
    this.handOverDataDir(paths.data);
    const script = hostScriptPath();

    const child = fork(script, [], {
      execArgv: [
        '--permission',
        `--allow-fs-read=${withSep(paths.root)}`,
        `--allow-fs-read=${script}`,
        `--allow-fs-write=${withSep(paths.data)}`,
        `--max-old-space-size=${MAX_HEAP_MB}`,
        '--no-warnings',
      ],
      // Explicit allowlist. The child must not inherit NODE_OPTIONS (it would try to load
      // the parent's dev loader from a path it cannot read) or any platform secret.
      env: {
        SC_APP_ID: appId,
        SC_BUNDLE_DIR: paths.bundle,
        SC_DB_PATH: paths.db,
        SC_FILES_DIR: paths.files,
        PATH: process.env.PATH ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      // When set, the OS refuses cross-app and platform file access regardless of what
      // Node's permission model does or does not cover. This is the real boundary.
      ...(this.isolation.appUid !== undefined ? { uid: this.isolation.appUid } : {}),
      ...(this.isolation.appGid !== undefined ? { gid: this.isolation.appGid } : {}),
    });

    const host: Host = { child, pending: new Map(), idleTimer: null, stopping: false };
    this.hosts.set(appId, host);

    child.stdout?.on('data', (b: Buffer) => this.apps.log(appId, 'info', b.toString('utf8').trimEnd()));
    child.stderr?.on('data', (b: Buffer) => this.apps.log(appId, 'error', b.toString('utf8').trimEnd()));

    child.on('message', (m: unknown) => {
      const msg = m as {
        t: string;
        invokeId?: number;
        response?: RouteResponse;
        logs?: Array<{ level: 'info' | 'error'; msg: string }>;
        msg?: string;
      };
      if ((msg.t === 'result' || msg.t === 'sql-result') && typeof msg.invokeId === 'number') {
        for (const l of msg.logs ?? []) this.apps.log(appId, l.level, l.msg);
        const p = host.pending.get(msg.invokeId);
        if (!p) return;
        clearTimeout(p.timer);
        host.pending.delete(msg.invokeId);
        p.resolve(msg.t === 'result' ? msg.response : msg);
      } else if (msg.t === 'crash') {
        this.apps.log(appId, 'error', msg.msg ?? 'app crashed');
      }
    });

    child.on('exit', (code, signal) => {
      if (host.stopping) return;
      this.apps.log(appId, 'error', `app process exited (code ${code}, signal ${signal})`);
      const failure = {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'app_crashed', message: 'the app process exited while handling this request; check logs' }),
        ok: false,
        message: 'the app process exited while running this query; check logs',
      };
      for (const [, p] of host.pending) {
        clearTimeout(p.timer);
        p.resolve(failure);
      }
      host.pending.clear();
      if (this.hosts.get(appId) === host) this.hosts.delete(appId);
    });

    this.touch(appId, host);
    return host;
  }

  /** Give the app user ownership of its writable tree, when running with SC_APP_UID. */
  private handOverDataDir(dir: string): void {
    const { appUid, appGid } = this.isolation;
    if (appUid === undefined || process.platform === 'win32') return;
    const gid = appGid ?? appUid;
    const walk = (p: string) => {
      chownSync(p, appUid, gid);
      if (statSync(p).isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    };
    try {
      walk(dir);
    } catch (err) {
      // Not fatal on its own, but the app will fail to write, so make the reason findable.
      this.apps.log(dir, 'error', `could not hand ${dir} to uid ${appUid}: ${(err as Error).message}`);
    }
  }

  /** Reset the idle countdown; an app with no traffic for IDLE_SHUTDOWN_MS exits. */
  private touch(appId: string, host: Host): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => {
      if (host.pending.size === 0) this.stop(appId);
      else this.touch(appId, host);
    }, IDLE_SHUTDOWN_MS);
    host.idleTimer.unref?.();
  }
}

/**
 * Node matches --allow-fs-* grants by path prefix, so a grant on ".../apps/aa" could otherwise
 * also cover ".../apps/aaa". A trailing separator pins the grant to that directory's contents.
 */
function withSep(dir: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + '/';
}
