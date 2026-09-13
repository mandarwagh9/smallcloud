import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync, fstatSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import type { Db } from './db.js';
import { openPlatformDb } from './db.js';
import { Apps } from './apps.js';
import { Auth } from './auth.js';
import { Runtime } from './runtime.js';
import type { Config } from './config.js';
import { type Mailer, mailerFromEnv } from './email.js';
import { roleFor, canUse, canManage } from './shares.js';
import type { AppRecord, EffectiveRole, RouteRequest, User } from './types.js';
import { handleApi } from './api.js';
import { handlePage } from './ui.js';
import {
  HttpError,
  RateLimiter,
  bearer,
  clientIp,
  mimeFor,
  parseCookies,
  readBody,
  sendJson,
  sendHtml,
  redirect,
  wantsHtml,
} from './httputil.js';
import { renderError } from './views.js';

export const SESSION_COOKIE = 'sc_session';

export interface Services {
  cfg: Config;
  db: Db;
  apps: Apps;
  auth: Auth;
  runtime: Runtime;
  mailer: Mailer;
  secure: boolean;
  /** Only true on a local dev instance with no mail provider: the sign-in link may be shown on the page. */
  revealMagicLink: boolean;
  limiters: { login: RateLimiter; loginIp: RateLimiter; deploy: RateLimiter; appStatic: RateLimiter; appApi: RateLimiter };
}

export interface RequestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  user: User | null;
  /** true when the caller authenticated with an API token rather than a browser session */
  viaToken: boolean;
  ip: string;
}

export function createServices(cfg: Config, mailer?: Mailer): Services {
  const db = openPlatformDb(join(cfg.dataDir, 'platform.db'));
  const apps = new Apps(db, cfg.dataDir, cfg.secret);
  const m = mailer ?? mailerFromEnv(process.env);
  const auth = new Auth({ db, mailer: m, baseUrl: cfg.baseUrl, allowedEmails: cfg.allowedEmails, secret: cfg.secret });
  const runtime = new Runtime(apps, { appUid: cfg.appUid, appGid: cfg.appGid, quotaBytes: cfg.appQuotaBytes, maxFiles: cfg.appMaxFiles });
  return {
    cfg,
    db,
    apps,
    auth,
    runtime,
    mailer: m,
    secure: cfg.baseUrl.startsWith('https://'),
    // Showing the sign-in link on the page is a dev convenience. It is a full account bypass in
    // production (anyone who types your email sees your link), so it is allowed only when there
    // is no mail provider AND the instance is plainly local. A remote instance without mail
    // shows nothing rather than leaking.
    revealMagicLink: !process.env.RESEND_API_KEY && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(cfg.baseUrl),
    limiters: {
      login: new RateLimiter(5, 15 * 60_000),
      loginIp: new RateLimiter(20, 15 * 60_000),
      deploy: new RateLimiter(cfg.deployPerHour, 60 * 60_000),
      // Per app, per client IP. These match the capacity targets in docs/PLAN.md NF2 on
      // purpose: a limit below the throughput the platform claims to support would reject
      // traffic the box can serve. A page view is several requests, and a whole office can
      // share one IP, so the static budget is the larger of the two.
      appStatic: new RateLimiter(cfg.staticRpm, 60_000),
      appApi: new RateLimiter(cfg.apiRpm, 60_000),
    },
  };
}

export function createHttpServer(s: Services): NodeServer {
  return createServer((req, res) => {
    handle(s, req, res).catch((err) => {
      if (!res.headersSent) {
        const status = err instanceof HttpError ? err.status : 500;
        const code = err instanceof HttpError ? err.code : 'internal';
        sendJson(res, status, { error: code, message: err?.message ?? 'internal error' });
      } else {
        res.end();
      }
      if (!(err instanceof HttpError)) console.error('[smallcloud]', err);
    });
  });
}

async function handle(s: Services, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', s.cfg.baseUrl);
  const method = (req.method ?? 'GET').toUpperCase();
  const ip = clientIp(req, s.cfg.trustProxy);

  // identify: bearer token first (agents), then session cookie (browsers)
  const token = bearer(req);
  let user: User | null = null;
  let viaToken = false;
  if (token) {
    user = s.auth.userFromApiToken(token);
    viaToken = user !== null;
  }
  if (!user) user = s.auth.userFromSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  const ctx: RequestCtx = { req, res, url, method, user, viaToken, ip };
  const path = url.pathname;

  if (path === '/health') return sendJson(res, 200, { ok: true, apps: s.runtime.running().length });
  if (path.startsWith('/v1/')) return handleApi(s, ctx);
  if (path === '/a' || path.startsWith('/a/')) return serveApp(s, ctx);
  return handlePage(s, ctx);
}

// ---- app serving -----------------------------------------------------------

async function serveApp(s: Services, ctx: RequestCtx): Promise<void> {
  const { res, url } = ctx;
  const rest = url.pathname.slice('/a/'.length);
  const slash = rest.indexOf('/');
  let slug: string;
  try {
    slug = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
  } catch {
    return notFound(ctx, 'the app name in the URL is not valid percent-encoding');
  }
  const tail = slash < 0 ? '' : rest.slice(slash + 1);

  if (!slug) return notFound(ctx, 'no app named in the URL');
  const app = s.apps.get(slug);
  if (!app) return notFound(ctx, `no app at /a/${slug}`);

  const role = roleFor(s.db, app, ctx.user);
  if (!canUse(role)) return denied(s, ctx, app);

  // The share link is /a/<slug>, with no trailing slash. A relative URL in the app's own HTML
  // -- which the contract tells agents to use -- resolves against /a/ from there rather than
  // /a/<slug>/, so the app would 404 on its own API at exactly the URL recipients are sent.
  // Redirect to the directory form first, the way a web server does for any directory URL.
  if (slash < 0 && !url.pathname.endsWith('/')) {
    return redirect(res, `${url.pathname}/${url.search}`);
  }

  const isApi = tail === 'api' || tail.startsWith('api/');
  const limiter = isApi ? s.limiters.appApi : s.limiters.appStatic;
  if (!limiter.take(`${app.id}:${ctx.ip}`)) {
    return sendJson(res, 429, {
      error: 'rate_limited',
      message: `too many requests to this app from your address (limit ${isApi ? s.cfg.apiRpm : s.cfg.staticRpm} per minute); slow down`,
    });
  }

  if (isApi) return runRoute(s, ctx, app, tail.slice(3).replace(/^\//, ''));
  return serveStatic(s, ctx, app, tail);
}

async function runRoute(s: Services, ctx: RequestCtx, app: AppRecord, apiPath: string): Promise<void> {
  const { req, res, url } = ctx;
  // Decode per segment, after splitting: decoding first would turn an encoded %2F into a real
  // separator and invent a path segment. The slug, static paths and query are already decoded,
  // so an undecoded api path was the odd one out -- ids with spaces or unicode arrived mangled.
  let seg: string[];
  try {
    seg = apiPath
      .split('/')
      .filter(Boolean)
      .map((x) => decodeURIComponent(x));
  } catch {
    return sendJson(res, 400, { error: 'bad_path', message: 'the request path is not valid percent-encoding' });
  }
  // Decoding happens after the split so %2F cannot invent a segment boundary -- but it can
  // still put a separator or a dot-dot INSIDE a segment, and the first segment is used as a
  // filename by the app host. Without this, "..%2f..%2fdata%2ffiles%2fevil" selected a file
  // the app itself had uploaded and ran it. Segments are path components, so treat them so.
  if (seg.some((x) => x === '.' || x === '..' || x.includes('/') || x.includes('\\') || hasControlChar(x))) {
    return sendJson(res, 400, { error: 'bad_path', message: 'a path segment may not contain a separator or a path traversal' });
  }
  const route = seg[0] ?? '';
  const subpath = seg.length > 1 ? '/' + seg.slice(1).join('/') : '';
  const bodyBuf = ['GET', 'HEAD'].includes(ctx.method) ? null : await readBody(req);

  const request: RouteRequest = {
    method: ctx.method,
    path: '/' + seg.join('/'),
    route,
    subpath,
    query: Object.fromEntries(url.searchParams),
    headers: pickHeaders(req),
    body: null,
  };
  const wire = { ...request, bodyB64: bodyBuf && bodyBuf.length ? bodyBuf.toString('base64') : null };

  const out = await s.runtime.invoke(app.id, wire as RouteRequest, ctx.user, s.apps.env(app.id));
  const headers: Record<string, string> = { 'cache-control': 'no-store', ...safeAppHeaders(s, app, out.headers) };
  const body = out.bodyB64 ? Buffer.from(out.bodyB64, 'base64') : Buffer.from(out.body ?? '', 'utf8');
  res.writeHead(out.status ?? 200, { ...headers, 'content-length': body.length });
  res.end(ctx.method === 'HEAD' ? undefined : body);
}

/**
 * Response headers an app is allowed to set.
 *
 * App code is untrusted, and apps share an origin with the control plane, so a route that
 * returned `set-cookie: sc_session=...` could overwrite the visitor's platform session with
 * one the app chose. Everything outside this list is dropped and logged, so an agent can see
 * why its header did not arrive.
 */
export const APP_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-disposition',
  'content-language',
  'cache-control',
  'location',
  'etag',
  'last-modified',
  'vary',
  'refresh',
  'link',
]);

const MAX_APP_HEADERS = 50;

function safeAppHeaders(s: Services, app: AppRecord, headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, value] of Object.entries(headers ?? {})) {
    if (count++ >= MAX_APP_HEADERS) break;
    const key = rawKey.toLowerCase().trim();
    if (APP_HEADER_ALLOWLIST.has(key) || key.startsWith('x-')) {
      // A header value may not smuggle a second header or a body.
      out[key] = String(value).replace(/[\r\n]/g, ' ');
    } else {
      s.apps.log(app.id, 'error', `dropped response header "${rawKey}": apps may not set it`);
    }
  }
  return out;
}

function serveStatic(s: Services, ctx: RequestCtx, app: AppRecord, tail: string): void {
  const { res } = ctx;
  const publicDir = join(s.apps.paths(app.id).bundle, 'public');
  let decodedTail: string;
  try {
    decodedTail = decodeURIComponent(tail || 'index.html');
  } catch {
    return notFound(ctx, `this app has no file at /${tail}`);
  }
  const rel = safeJoin(publicDir, decodedTail);
  let file = rel;

  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file || !existsSync(file)) {
    // SPA fallback: a navigation to a path with no extension gets index.html
    const isNavigation = wantsHtml(ctx.req) && !extname(tail);
    const index = join(publicDir, 'index.html');
    if (isNavigation && existsSync(index)) file = index;
    else return notFound(ctx, `this app has no file at /${tail}`);
  }

  const stat = statSync(file);
  if (ctx.method === 'HEAD') {
    res.writeHead(200, {
      'content-type': mimeFor(extname(file)),
      'content-length': stat.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    return void res.end();
  }

  // The file can disappear between statSync and the stream's open -- a concurrent redeploy
  // swaps the bundle directory, and DELETE removes it outright. `pipe` only attaches an error
  // handler to the destination, so an unhandled 'error' here would take down the whole
  // control plane and every app on it. Open first, then write headers.
  const stream = createReadStream(file);
  stream.once('error', (err: NodeJS.ErrnoException) => {
    s.apps.log(app.id, 'error', `could not read ${tail || 'index.html'}: ${err.code ?? err.message}`);
    if (res.headersSent) return void res.destroy();
    notFound(ctx, `this app has no file at /${tail}`);
  });
  stream.once('open', (fd: number) => {
    // Size comes from the file we actually opened, not the earlier statSync. A redeploy
    // between the two can swap the file, and a content-length that disagrees with the body
    // makes the browser hang waiting for bytes that never come, or truncates the response.
    let size = stat.size;
    try {
      size = fstatSync(fd).size;
    } catch {
      // Fall back to the earlier stat; being slightly wrong beats failing the request.
    }
    res.writeHead(200, {
      'content-type': mimeFor(extname(file)),
      'content-length': size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    stream.pipe(res);
  });
  res.once('close', () => stream.destroy());
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
  return false;
}

/** Join that refuses to leave the base directory. */
function safeJoin(base: string, rel: string): string | null {
  const target = normalize(join(base, rel));
  const root = normalize(base.endsWith(sep) ? base : base + sep);
  return target === normalize(base) || target.startsWith(root) ? target : null;
}

function pickHeaders(req: IncomingMessage): Record<string, string> {
  const keep = ['content-type', 'accept', 'accept-language', 'user-agent', 'referer', 'x-requested-with'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = req.headers[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ---- responses -------------------------------------------------------------

function jsonish(ctx: RequestCtx): boolean {
  return ctx.viaToken || !wantsHtml(ctx.req);
}

function notFound(ctx: RequestCtx, message: string): void {
  if (jsonish(ctx)) return sendJson(ctx.res, 404, { error: 'not_found', message });
  sendHtml(ctx.res, 404, renderError('Not found', message));
}

function denied(s: Services, ctx: RequestCtx, app: AppRecord): void {
  if (!ctx.user) {
    if (jsonish(ctx)) return sendJson(ctx.res, 401, { error: 'sign_in_required', message: 'sign in to open this app' });
    return redirect(ctx.res, `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
  }
  const message = `${app.name} has not been shared with ${ctx.user.email}. Ask the owner to share it with you.`;
  if (jsonish(ctx)) return sendJson(ctx.res, 403, { error: 'forbidden', message });
  sendHtml(ctx.res, 403, renderError('Not shared with you', message));
}

export { roleFor, canUse, canManage };
export type { EffectiveRole };
