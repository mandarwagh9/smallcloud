// The app host. One of these runs per app, as a child process started with
// --permission and grants covering only that app's directory. It receives requests
// over IPC, runs api/<route>.js, and sends the response back.
//
// Nothing in here is trusted with platform state: it never sees the platform database,
// the platform secret, or any other app's files. See docs/PLAN.md 6.5.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, statSync } from 'node:fs';
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

// ---- SQL boundary guard ---------------------------------------------------

/**
 * ATTACH/DETACH reach another database file and VACUUM INTO writes one, so any of them lets a
 * statement escape the app's own database -- e.g. `ATTACH '<dataDir>/platform.db'` reads every
 * session and token on the instance. Node's permission model does not gate SQLite's own file
 * access (the same root cause as the node:sqlite import block), and node:sqlite exposes no
 * authorizer, so the only in-process control is to refuse these statements before they run.
 * SC_APP_UID remains the OS-level backstop; this closes the hole on installs without it.
 *
 * The text is stripped of comments, string literals and quoted identifiers first, so a keyword
 * that is really data or a column name does not trip it, and a real statement keyword -- which
 * SQLite cannot see obfuscated either -- always does.
 */
function crossesDatabaseBoundary(sql) {
  // Scan character by character rather than with a regex: skip string literals, quoted and
  // bracketed identifiers, and comments so a keyword that is really data or a name is ignored,
  // then flag ATTACH / DETACH / VACUUM appearing as bare keywords. A real statement keyword is
  // never inside quotes, and SQLite keywords cannot be split, so this sees what SQLite would run.
  const NL = String.fromCharCode(10);
  const text = String(sql);
  let code = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "'" || c === "\"" || c === "`") {
      const q = c;
      i++;
      while (i < text.length) {
        if (text[i] === q) {
          if (text[i + 1] === q) { i++; } else { break; }
        }
        i++;
      }
      code += " ";
      continue;
    }
    if (c === "[") {
      while (i < text.length && text[i] !== "]") i++;
      code += " ";
      continue;
    }
    if (c === "-" && d === "-") {
      while (i < text.length && text[i] !== NL) i++;
      code += " ";
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      code += " ";
      continue;
    }
    code += c;
  }
  const words = code.toLowerCase().split(/[^a-z]+/);
  return words.includes("attach") || words.includes("detach") || words.includes("vacuum");
}

function assertOwnDatabase(sql) {
  if (crossesDatabaseBoundary(sql)) {
    throw new Error("ctx.db can only touch this app database; ATTACH, DETACH and VACUUM are not allowed");
  }
}

// ---- ctx.db ---------------------------------------------------------------

const appDb = {
  run(sql, ...params) {
    assertOwnDatabase(sql);
    const r = getDb().prepare(sql).run(...params);
    return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
  },
  get(sql, ...params) {
    assertOwnDatabase(sql);
    return getDb().prepare(sql).get(...params);
  },
  all(sql, ...params) {
    assertOwnDatabase(sql);
    return getDb().prepare(sql).all(...params);
  },
  exec(sql) {
    assertOwnDatabase(sql);
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

// Per-app storage caps so one tenant cannot fill the shared volume and break platform.db and
// every co-tenant. Usage is summed once (lazily) then kept incrementally, so put() stays O(1).
const QUOTA_BYTES = Number(process.env.SC_APP_QUOTA_BYTES || 100 * 1024 * 1024);
const MAX_FILES = Number(process.env.SC_APP_MAX_FILES || 10000);
let filesBytes = null;
let filesCount = null;
function ensureUsage() {
  if (filesBytes !== null) return;
  filesBytes = 0;
  filesCount = 0;
  if (existsSync(FILES_DIR)) {
    for (const n of readdirSync(FILES_DIR)) {
      try {
        filesBytes += statSync(join(FILES_DIR, n)).size;
        filesCount += 1;
      } catch {
        // a file that vanished mid-scan does not count
      }
    }
  }
}

const appFiles = {
  put(name, data) {
    ensureUsage();
    const nm = safeName(name);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const dest = join(FILES_DIR, nm);
    const exists = existsSync(dest);
    const prev = exists ? statSync(dest).size : 0;
    const isNew = !exists;
    if (isNew && filesCount >= MAX_FILES) {
      throw new Error(`ctx.files: this app already has the maximum ${MAX_FILES} files`);
    }
    if (filesBytes - prev + buf.length > QUOTA_BYTES) {
      throw new Error(`ctx.files: this app is over its ${Math.round(QUOTA_BYTES / 1024 / 1024)} MB storage quota`);
    }
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(dest, buf);
    filesBytes += buf.length - prev;
    if (isNew) filesCount += 1;
    return { name: nm, size: buf.length };
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
    if (filesBytes !== null) {
      try {
        filesBytes -= statSync(p).size;
        filesCount -= 1;
      } catch {
        // best effort
      }
    }
    unlinkSync(p);
    return true;
  },
};

// ---- ctx.fetch ------------------------------------------------------------

// Classify a hostname as private/internal so ctx.fetch cannot reach the control plane or the
// local network. WHATWG URL already normalises numeric IPv4 forms (2130706433, 0x7f000001,
// 127.1, 0177.0.0.1) to dotted quads, so the danger the old regex missed was IPv6 -- especially
// IPv4-mapped forms like ::ffff:127.0.0.1, which URL renders as [::ffff:7f00:1]. This parses the
// address numerically rather than pattern-matching text.
function ipv4IsPrivate(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> refuse
  if (a === 0 || a === 127 || a === 10) return true; // this-network, loopback, RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function expandIpv6(host) {
  // Split off an embedded IPv4 tail (::ffff:127.0.0.1) if present.
  let v4tail = null;
  const dot = host.lastIndexOf('.');
  if (dot >= 0) {
    const colon = host.lastIndexOf(':');
    const tail = host.slice(colon + 1);
    const m = tail.split('.');
    if (m.length === 4) {
      v4tail = m.map((x) => Number(x));
      host = host.slice(0, colon + 1) + ((v4tail[0] << 8) | v4tail[1]).toString(16) + ':' + ((v4tail[2] << 8) | v4tail[3]).toString(16);
    }
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return { groups, v4tail };
}

function isPrivateHost(rawHost) {
  const host = String(rawHost).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;
  // Named internal forms.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  // Dotted IPv4 (URL has already normalised the exotic encodings to this form).
  const v4 = host.split('.');
  if (v4.length === 4 && v4.every((p) => /^\d+$/.test(p))) {
    const [a, b, c, d] = v4.map((n) => Number(n));
    return ipv4IsPrivate(a, b, c, d);
  }
  // IPv6.
  if (host.includes(':')) {
    const parsed = expandIpv6(host);
    if (!parsed) return true; // cannot classify -> refuse
    const g = parsed.groups;
    if (parsed.v4tail) return ipv4IsPrivate(...parsed.v4tail); // IPv4-mapped/compatible
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return ipv4IsPrivate((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff);
    return false;
  }
  return false; // an ordinary public hostname (DNS rebinding remains the documented gap)
}

const MAX_REDIRECTS = 5;

async function appFetch(input, init) {
  let current = new URL(typeof input === 'string' ? input : input.url);
  const opts = { ...(init || {}) };
  // Re-check every hop. fetch would otherwise follow a 3xx from an allowed host to a private
  // Location without re-validating it (SSRF via redirect). We follow manually and classify each.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error(`ctx.fetch: only http and https are allowed, got ${current.protocol}`);
    if (isPrivateHost(current.hostname)) throw new Error(`ctx.fetch: ${current.hostname} is a private address and is not reachable from an app`);
    const res = await fetch(current, { ...opts, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    current = new URL(loc, current);
    // Match the redirect semantics fetch itself uses: 303 (and, by long-standing convention,
    // 301/302) turn the request into a bodyless GET; 307/308 preserve the method AND the body.
    // The old code dropped the body on every hop while keeping the method, so a POST across a
    // 307/308 was sent method-but-no-body -- broken.
    const method = (opts.method || 'GET').toUpperCase();
    if (res.status === 307 || res.status === 308) {
      // preserve method and body as-is
    } else if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      opts.method = 'GET';
      delete opts.body;
    }
  }
  throw new Error('ctx.fetch: too many redirects');
}

// ---- routing --------------------------------------------------------------

/** A route selects a file, so it must be a single plain filename -- never a path. */
const SAFE_ROUTE = /^[A-Za-z0-9._-]*$/;

async function loadRoute(route) {
  if (moduleCache.has(route)) return moduleCache.get(route);
  // Defence in depth: the control plane already rejects separators and traversal in a path
  // segment, and this is the sink that turns a route into a filename. A route that is not a
  // plain safe name is never used to build a filename -- but it must still fall through to the
  // api/index.js catch-all rather than 404 early, so a catch-all router sees every request.
  const named = route && SAFE_ROUTE.test(route) && route !== '.' && route !== '..' && !route.startsWith('_');
  let file = null;
  if (named) {
    for (const ext of ['.js', '.mjs']) {
      const candidate = join(BUNDLE, 'api', route + ext);
      if (existsSync(candidate)) {
        file = candidate;
        break;
      }
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
  // A single request's logs cross IPC and become one SQLite insert each on the control plane,
  // so an uncapped ctx.log() loop could freeze the whole box. Bound the count and total bytes;
  // after the cap one marker is added and further calls are dropped.
  const LOG_MAX_LINES = 200;
  const LOG_MAX_BYTES = 64 * 1024;
  const logs = [];
  let logBytes = 0;
  let logCapped = false;
  const addLog = (level, msg) => {
    if (logCapped) return;
    if (logs.length >= LOG_MAX_LINES || logBytes >= LOG_MAX_BYTES) {
      logs.push({ level: 'error', msg: 'ctx.log output truncated for this request (limit reached)' });
      logCapped = true;
      return;
    }
    const line = String(msg).slice(0, 4000);
    logBytes += line.length;
    logs.push({ level, msg: line });
  };
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
        addLog('info', args.map((a) => (typeof a === 'string' ? a : inspectish(a))).join(' '));
      },
      fetch: appFetch,
    };
    const out = await handler(buildRequest(m.request), ctx);
    return { t: 'result', invokeId: m.invokeId, response: normalizeResponse(out), logs };
  } catch (err) {
    const msg = err && err.stack ? String(err.stack) : String(err);
    addLog('error', msg);
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
    // Always guarded. There is deliberately no caller-supplied bypass flag here: app code shares
    // this process and can forge an IPC message with process.emit("message", ...), so any
    // "internal" flag on the message would be attacker-controlled. The export snapshot has its
    // own message type (runSnapshot) whose SQL the host constructs itself.
    assertOwnDatabase(m.sql);
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

/**
 * Snapshot the app's own database to a plain filename in its data directory. The SQL is built
 * here from a validated filename, never taken from the message, so even a forged snapshot
 * message can only vacuum this app's db into its own data dir -- which app code can already
 * write. This is how the platform's export takes a WAL-consistent copy.
 */
function runSnapshot(m) {
  try {
    const name = safeName(m.dest);
    const full = join(FILES_DIR, '..', name); // FILES_DIR is data/files, so this is data/<name>
    getDb().exec("vacuum into '" + full.split("'").join("''") + "'");
    return { t: 'sql-result', invokeId: m.invokeId, ok: true, result: { snapshot: name } };
  } catch (err) {
    return { t: 'sql-result', invokeId: m.invokeId, ok: false, message: err && err.message ? err.message : String(err) };
  }
}

process.on('message', (m) => {
  if (!m) return;
  if (m.t === 'sql') return send(runSql(m));
  if (m.t === 'snapshot') return send(runSnapshot(m));
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
