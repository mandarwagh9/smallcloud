import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
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

interface Pending {
  resolve: (r: RouteResponse) => void;
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

  constructor(private apps: Apps) {}

  /** Run one request inside the app's own process, starting it if needed. */
  async invoke(appId: string, request: RouteRequest, user: User | null, env: Record<string, string>): Promise<RouteResponse> {
    const host = this.hostFor(appId);
    const invokeId = this.nextInvokeId++;
    return new Promise<RouteResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(invokeId);
        this.apps.log(appId, 'error', `request timed out after ${REQUEST_TIMEOUT_MS}ms: ${request.method} ${request.path}`);
        // A runaway synchronous loop cannot be interrupted from outside, so the process goes.
        // Other in-flight requests for this app die with it (docs/PLAN.md D11).
        this.stop(appId);
        resolve({
          status: 504,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'timeout', message: `the app took longer than ${REQUEST_TIMEOUT_MS / 1000}s to respond` }),
        });
      }, REQUEST_TIMEOUT_MS);
      host.pending.set(invokeId, { resolve, reject, timer });
      this.touch(appId, host);
      try {
        host.child.send({ t: 'invoke', invokeId, request, user, env });
      } catch (err) {
        clearTimeout(timer);
        host.pending.delete(invokeId);
        reject(err as Error);
      }
    });
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
    const script = hostScriptPath();

    const child = fork(script, [], {
      execArgv: [
        '--permission',
        `--allow-fs-read=${paths.root}`,
        `--allow-fs-read=${script}`,
        `--allow-fs-write=${paths.data}`,
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
    });

    const host: Host = { child, pending: new Map(), idleTimer: null, stopping: false };
    this.hosts.set(appId, host);

    child.stdout?.on('data', (b: Buffer) => this.apps.log(appId, 'info', b.toString('utf8').trimEnd()));
    child.stderr?.on('data', (b: Buffer) => this.apps.log(appId, 'error', b.toString('utf8').trimEnd()));

    child.on('message', (m: unknown) => {
      const msg = m as { t: string; invokeId?: number; response?: RouteResponse; logs?: Array<{ level: 'info' | 'error'; msg: string }>; msg?: string };
      if (msg.t === 'result' && typeof msg.invokeId === 'number') {
        for (const l of msg.logs ?? []) this.apps.log(appId, l.level, l.msg);
        const p = host.pending.get(msg.invokeId);
        if (!p) return;
        clearTimeout(p.timer);
        host.pending.delete(msg.invokeId);
        p.resolve(msg.response!);
      } else if (msg.t === 'crash') {
        this.apps.log(appId, 'error', msg.msg ?? 'app crashed');
      }
    });

    child.on('exit', (code, signal) => {
      if (host.stopping) return;
      this.apps.log(appId, 'error', `app process exited (code ${code}, signal ${signal})`);
      const failure: RouteResponse = {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'app_crashed', message: 'the app process exited while handling this request; check logs' }),
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
