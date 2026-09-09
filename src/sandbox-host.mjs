// The app host. One of these runs per app, as a child process started with
// --permission and grants covering only that app's directory. It receives requests
// over IPC, runs api/<route>.js, and sends the response back.
//
// Nothing in here is trusted with platform state: it never sees the platform database,
// the platform secret, or any other app's files. See docs/PLAN.md 6.5.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

/**
 * Builtins an app may not load.
 *
 * This matters more than it looks. Node's permission model governs `fs`, but NOT the native
 * file access inside `node:sqlite` -- an app that opens the platform database directly with
 * `new DatabaseSync(...)` reads every session and API token hash, with `--permission` on.
 * Blocking the module is what closes that hole. `registerHooks` is synchronous and needs no
 * worker thread, so it works inside a permission-restricted process (Node >= 22.15).
 */
const DENIED_BUILTINS = new Set([
  'sqlite', 'fs', 'fs/promises', 'child_process', 'worker_threads', 'cluster', 'module',
  'net', 'tls', 'dgram', 'dns', 'dns/promises', 'http', 'https', 'http2', 'inspector',
  'os', 'v8', 'vm', 'repl', 'trace_events', 'perf_hooks', 'tty', 'readline', 'process',
]);

export const BUILTINS_BLOCKED = typeof nodeModule.registerHooks === 'function';

if (BUILTINS_BLOCKED) {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      if (DENIED_BUILTINS.has(bare)) {
        const err = new Error(`"${specifier}" is not available to apps on smallcloud. Use ctx.db, ctx.files or ctx.fetch instead.`);
        err.code = 'ERR_MODULE_BLOCKED';
        throw err;
      }
      return nextResolve(specifier, context);
    },
  });
} else {
  // Surfaces in the app's logs and in `smallcloud logs`, so this is never silent.
  process.stderr.write(
    `[smallcloud] WARNING: Node ${process.versions.node} has no module.registerHooks, so apps can still load node:sqlite ` +
      'and read the platform database. Upgrade to Node >= 22.15, or isolate app processes with SC_APP_UID. See SECURITY.md.\n',
  );
}

const APP_ID = process.env.SC_APP_ID;
const BUNDLE = process.env.SC_BUNDLE_DIR;
const DB_PATH = process.env.SC_DB_PATH;
const FILES_DIR = process.env.SC_FILES_DIR;

let db = null;
const moduleCache = new Map();

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('pragma journal_mode = wal; pragma busy_timeout = 3000; pragma foreign_keys = on;');
  }
  return db;
}

function num(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

// ---- ctx.db ---------------------------------------------------------------

const appDb = {
  run(sql, ...params) {
    const r = getDb().prepare(sql).run(...params);
    return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
  },
  get(sql, ...params) {
    return getDb().prepare(sql).get(...params);
  },
  all(sql, ...params) {
    return getDb().prepare(sql).all(...params);
  },
  exec(sql) {
    getDb().exec(sql);
  },
};

// ---- ctx.files ------------------------------------------------------------

/**
 * Storage names are flat. A name with a directory in it is rejected outright rather than
 * quietly rewritten, so an app never thinks it wrote somewhere it did not.
 */
function safeName(name) {
  const s = String(name ?? '');
  const bad = (why) => {
    throw new Error(`ctx.files: "${name}" is not a valid file name (${why}). Use a plain name like "report.csv".`);
  };
  if (!s) bad('empty');
  if (s.includes('/') || s.includes('\\')) bad('no directories, just a name');
  if (s === '.' || s === '..') bad('reserved');
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) bad('control character');
  if (/[<>:"|?*]/.test(s)) bad('illegal character');
  if (s !== basename(s)) bad('not a plain file name');
  return s;
}

const appFiles = {
  put(name, data) {
    mkdirSync(FILES_DIR, { recursive: true });
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    writeFileSync(join(FILES_DIR, safeName(name)), buf);
    return { name: safeName(name), size: buf.length };
  },
  get(name) {
    const p = join(FILES_DIR, safeName(name));
    return existsSync(p) ? readFileSync(p) : null;
  },
  getText(name) {
    const b = appFiles.get(name);
    return b === null ? null : b.toString('utf8');
  },
  list() {
    if (!existsSync(FILES_DIR)) return [];
    return readdirSync(FILES_DIR).sort();
  },
  delete(name) {
    const p = join(FILES_DIR, safeName(name));
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  },
};

// ---- ctx.fetch ------------------------------------------------------------

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?fd[0-9a-f]{2}:.*)$/i;

async function appFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`ctx.fetch: only http and https are allowed, got ${url.protocol}`);
  if (PRIVATE_HOST.test(url.hostname)) throw new Error(`ctx.fetch: ${url.hostname} is a private address and is not reachable from an app`);
  return fetch(url, init);
}

// ---- routing --------------------------------------------------------------

/** A route selects a file, so it must be a single plain filename -- never a path. */
const SAFE_ROUTE = /^[A-Za-z0-9._-]*$/;

async function loadRoute(route) {
  if (moduleCache.has(route)) return moduleCache.get(route);
  // Defence in depth: the control plane already rejects separators and traversal in a path
  // segment, but this is the sink that turns a route into a filename and then imports it, so
  // it refuses anything that is not a plain name and re-checks containment after resolving.
  if (!SAFE_ROUTE.test(route) || route === '.' || route === '..') {
    moduleCache.set(route, null);
    return null;
  }
  let file = null;
  for (const ext of ['.js', '.mjs']) {
    const candidate = join(BUNDLE, 'api', route + ext);
    if (route && !route.startsWith('_') && existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) {
    for (const ext of ['.js', '.mjs']) {
      const candidate = join(BUNDLE, 'api', 'index' + ext);
      if (existsSync(candidate)) {
        file = candidate;
        break;
      }
    }
  }
  if (!file) {
    moduleCache.set(route, null);
    return null;
  }
  const apiDir = join(BUNDLE, 'api');
  if (!resolve(file).startsWith(resolve(apiDir) + sep)) {
    moduleCache.set(route, null);
    return null;
  }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod.default;
  if (typeof handler !== 'function') throw new Error(`api/${basename(file)} must "export default" a function`);
  moduleCache.set(route, handler);
  return handler;
}

function buildRequest(r) {
  const bytes = r.bodyB64 ? Buffer.from(r.bodyB64, 'base64') : null;
  return {
    method: r.method,
    path: r.path,
    route: r.route,
    subpath: r.subpath,
    query: r.query,
    headers: r.headers,
    get body() {
      return bytes ? bytes.toString('utf8') : null;
    },
    bytes() {
      return bytes;
    },
    json() {
      if (!bytes) return null;
      return JSON.parse(bytes.toString('utf8'));
    },
  };
}

/** Normalize whatever the route returned into the wire shape. */
function normalizeResponse(out) {
  if (out === undefined || out === null) return { status: 204 };
  if (typeof out === 'string') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: out };
  if (out instanceof Uint8Array) {
    return { status: 200, headers: { 'content-type': 'application/octet-stream' }, bodyB64: Buffer.from(out).toString('base64') };
  }
  if (typeof out === 'object') {
    const res = { status: out.status ?? 200, headers: { ...(out.headers ?? {}) } };
    if ('json' in out) {
      res.headers['content-type'] = res.headers['content-type'] ?? 'application/json; charset=utf-8';
      res.body = JSON.stringify(out.json);
    } else if (out.body instanceof Uint8Array) {
      res.bodyB64 = Buffer.from(out.body).toString('base64');
    } else if (typeof out.body === 'string') {
      res.body = out.body;
    }
    return res;
  }
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(out) };
}

function send(msg) {
  if (process.send) process.send(msg);
}

async function invoke(m) {
  const logs = [];
  try {
    const handler = await loadRoute(m.request.route);
    if (!handler) {
      return {
        t: 'result',
        invokeId: m.invokeId,
        response: {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'no_route', message: `this app has no api/${m.request.route}.js` }),
        },
        logs,
      };
    }
    const ctx = {
      db: appDb,
      files: appFiles,
      user: m.user,
      env: Object.freeze({ ...m.env }),
      appId: APP_ID,
      log: (...args) => {
        const line = args.map((a) => (typeof a === 'string' ? a : inspectish(a))).join(' ');
        logs.push({ level: 'info', msg: line });
      },
      fetch: appFetch,
    };
    const out = await handler(buildRequest(m.request), ctx);
    return { t: 'result', invokeId: m.invokeId, response: normalizeResponse(out), logs };
  } catch (err) {
    const msg = err && err.stack ? String(err.stack) : String(err);
    logs.push({ level: 'error', msg });
    return {
      t: 'result',
      invokeId: m.invokeId,
      response: {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'app_error', message: err && err.message ? err.message : String(err) }),
      },
      logs,
    };
  }
}

function inspectish(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Run SQL against this app's own database, on behalf of an owner or editor debugging it.
 * It runs here rather than in the control plane on purpose: statements like VACUUM INTO and
 * ATTACH can write files, and inside this process they can only reach this app's directory.
 */
function runSql(m) {
  try {
    const isRead = /^\s*(select|pragma|with|explain)/i.test(m.sql);
    const stmt = getDb().prepare(m.sql);
    const params = m.params ?? [];
    if (isRead) return { t: 'sql-result', invokeId: m.invokeId, ok: true, result: { rows: stmt.all(...params) } };
    const r = stmt.run(...params);
    return { t: 'sql-result', invokeId: m.invokeId, ok: true, result: { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) } };
  } catch (err) {
    return { t: 'sql-result', invokeId: m.invokeId, ok: false, message: err && err.message ? err.message : String(err) };
  }
}

process.on('message', (m) => {
  if (!m) return;
  if (m.t === 'sql') return send(runSql(m));
  if (m.t !== 'invoke') return;
  invoke(m).then(send, (err) => {
    send({
      t: 'result',
      invokeId: m.invokeId,
      response: { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'host_error', message: String(err) }) },
      logs: [{ level: 'error', msg: String(err && err.stack ? err.stack : err) }],
    });
  });
});

process.on('uncaughtException', (err) => {
  send({ t: 'crash', msg: String(err && err.stack ? err.stack : err) });
  process.exit(1);
});

send({ t: 'ready' });
