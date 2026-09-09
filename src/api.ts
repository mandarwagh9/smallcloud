import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqlError } from './runtime.js';
import type { Services, RequestCtx } from './server.js';
import { DeployError } from './apps.js';
import { ShareError, listShares, parsePrincipal, parseRole, roleFor, canUse, canManage, setShare, removeShare } from './shares.js';
import { HttpError, readJson, sendJson, sendText } from './httputil.js';
import { zip } from './zip.js';
import { CONTRACT } from './contract.js';
import type { AppFile, AppRecord } from './types.js';

/** Everything under /v1. Bearer token or session cookie; identical behaviour either way. */
export async function handleApi(s: Services, ctx: RequestCtx): Promise<void> {
  const { res, method } = ctx;
  const seg = ctx.url.pathname.split('/').filter(Boolean); // ["v1", ...]
  const path = seg.slice(1);

  // --- open endpoints ---
  if (path[0] === 'contract' && method === 'GET') return sendText(res, 200, CONTRACT, { 'content-type': 'text/markdown; charset=utf-8' });
  if (path[0] === 'stats' && method === 'GET') {
    const count = (t: string) => (s.db.prepare(`select count(*) c from ${t}`).get() as { c: number }).c;
    return sendJson(res, 200, { apps: count('apps'), users: count('users'), shares: count('shares'), running: s.runtime.running().length });
  }
  if (path[0] === 'cli-login') {
    if (method === 'POST' && path.length === 1) {
      const { code, url } = s.auth.startCliLogin();
      return sendJson(res, 200, { code, url, message: `open ${url} in a browser signed in to smallcloud, then approve` });
    }
    if (method === 'GET' && path.length === 2) {
      const r = s.auth.pollCliLogin(path[1]);
      if (r.status === 'unknown') throw new HttpError(404, 'unknown_code', 'this login code has expired; start again');
      return sendJson(res, 200, r);
    }
  }

  // --- everything below needs a caller ---
  const user = ctx.user;
  if (!user) throw new HttpError(401, 'unauthorized', 'provide an API token (Authorization: Bearer sc_...) or sign in');

  if (path[0] === 'me' && method === 'GET') {
    return sendJson(res, 200, { email: user.email, tokens: s.auth.listApiTokens(user.email).length });
  }

  if (path[0] === 'tokens') {
    if (method === 'POST') {
      const body = await readJson<{ name?: string }>(ctx.req);
      const token = s.auth.createApiToken(user.email, (body.name ?? 'agent').slice(0, 40));
      return sendJson(res, 201, { token, message: 'store this now; it is not shown again' });
    }
    if (method === 'GET') return sendJson(res, 200, { tokens: s.auth.listApiTokens(user.email) });
  }

  if (path[0] !== 'apps') throw new HttpError(404, 'no_such_endpoint', `${ctx.url.pathname} is not an endpoint; see GET /v1/contract`);

  // --- /v1/apps ---
  if (path.length === 1) {
    if (method === 'POST') {
      if (!s.limiters.deploy.take(user.email)) throw new HttpError(429, 'rate_limited', 'too many deploys in the last hour');
      const body = await readJson<{ files?: AppFile[]; appId?: string }>(ctx.req);
      if (!Array.isArray(body.files)) throw new HttpError(400, 'bad_request', 'send {"files": [{"path": "app.json", "content": "..."}, ...]}');
      if (body.appId) {
        const existing = s.apps.get(body.appId);
        if (!existing) throw new HttpError(404, 'not_found', `no app with id ${body.appId}`);
        requireManage(s, ctx, existing);
      }
      let app: AppRecord;
      try {
        app = s.apps.deploy(user, body.files, body.appId);
      } catch (err) {
        if (err instanceof DeployError) throw new HttpError(400, err.code, err.message);
        throw err;
      }
      s.runtime.stop(app.id); // pick up the new bundle on the next request
      s.apps.log(app.id, 'info', `deployed version ${app.version} by ${user.email}`);
      return sendJson(res, body.appId ? 200 : 201, describe(s, app));
    }
    if (method === 'GET') {
      const list = s.apps.listFor(user).map((a) => ({ ...describe(s, a), relation: a.relation }));
      return sendJson(res, 200, { apps: list });
    }
  }

  // --- /v1/apps/:id/... ---
  const app = s.apps.get(path[1] ?? '');
  if (!app) throw new HttpError(404, 'not_found', `no app with id or slug "${path[1]}"`);
  const sub = path[2];

  if (path.length === 2) {
    if (method === 'GET') {
      requireUse(s, ctx, app);
      // Who else it is shared with, and which secrets exist, are the owner's business.
      // Someone with only `user` gets the app itself and nothing about its administration.
      const manages = canManage(roleFor(s.db, app, ctx.user));
      return sendJson(res, 200, {
        ...describe(s, app),
        ...(manages ? { shares: listShares(s.db, app.id), secretKeys: s.apps.secretKeys(app.id) } : {}),
      });
    }
    if (method === 'DELETE') {
      requireOwner(ctx, app);
      s.runtime.stop(app.id);
      s.apps.delete(app.id);
      return sendJson(res, 200, { deleted: app.id });
    }
  }

  if (sub === 'source' && method === 'GET') {
    requireManage(s, ctx, app);
    return sendJson(res, 200, { appId: app.id, version: app.version, files: s.apps.source(app.id) });
  }

  if (sub === 'logs' && method === 'GET') {
    requireManage(s, ctx, app);
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 100) || 100, 500);
    return sendJson(res, 200, { appId: app.id, logs: s.apps.logs(app.id, limit) });
  }

  if (sub === 'shares') {
    requireManage(s, ctx, app);
    try {
      if (method === 'GET') return sendJson(res, 200, { shares: listShares(s.db, app.id) });
      if (method === 'PUT') {
        const body = await readJson<{ principal?: string; role?: string }>(ctx.req);
        if (!body.principal) throw new HttpError(400, 'bad_request', 'send {"principal": "bob@example.com" | "domain:example.com" | "public", "role": "user"|"editor"}');
        const share = setShare(s.db, app.id, parsePrincipal(body.principal), parseRole(body.role));
        return sendJson(res, 200, { share, url: appUrl(s, app) });
      }
      if (method === 'DELETE') {
        const principal = path[3] ? decodeURIComponent(path[3]) : (await readJson<{ principal?: string }>(ctx.req)).principal;
        if (!principal) throw new HttpError(400, 'bad_request', 'name the principal to remove');
        const ok = removeShare(s.db, app.id, parsePrincipal(principal));
        return sendJson(res, ok ? 200 : 404, ok ? { removed: principal } : { error: 'not_found', message: `${principal} was not shared` });
      }
    } catch (err) {
      if (err instanceof ShareError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
  }

  if (sub === 'secrets') {
    requireManage(s, ctx, app);
    if (method === 'GET') return sendJson(res, 200, { keys: s.apps.secretKeys(app.id) });
    if (method === 'PUT') {
      const body = await readJson<{ key?: string; value?: string }>(ctx.req);
      if (!body.key || typeof body.value !== 'string') throw new HttpError(400, 'bad_request', 'send {"key": "API_KEY", "value": "..."}');
      try {
        s.apps.setSecret(app.id, body.key, body.value);
      } catch (err) {
        if (err instanceof DeployError) throw new HttpError(400, err.code, err.message);
        throw err;
      }
      s.runtime.stop(app.id);
      return sendJson(res, 200, { keys: s.apps.secretKeys(app.id) });
    }
    if (method === 'DELETE') {
      const key = path[3] ? decodeURIComponent(path[3]) : (await readJson<{ key?: string }>(ctx.req)).key;
      if (!key) throw new HttpError(400, 'bad_request', 'name the secret key to remove');
      const ok = s.apps.deleteSecret(app.id, key);
      s.runtime.stop(app.id);
      return sendJson(res, ok ? 200 : 404, { keys: s.apps.secretKeys(app.id) });
    }
  }

  if (sub === 'db' && method === 'POST') {
    requireManage(s, ctx, app);
    const body = await readJson<{ sql?: string; params?: unknown[] }>(ctx.req);
    if (!body.sql) throw new HttpError(400, 'bad_request', 'send {"sql": "select * from todos", "params": []}');
    try {
      return sendJson(res, 200, await s.runtime.sql(app.id, body.sql, body.params ?? []));
    } catch (err) {
      if (err instanceof SqlError) throw new HttpError(400, 'sql_error', err.message);
      throw err;
    }
  }

  if (sub === 'export' && method === 'GET') {
    requireManage(s, ctx, app);
    const raw = await exportEntries(s, app);
    const entries = raw.map((e) => ({ path: `${app.slug}${e.path.startsWith('/') ? '' : '/'}${e.path}`, data: e.data }));
    const buf = zip(entries);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': buf.length,
      'content-disposition': `attachment; filename="${app.slug}.zip"`,
    });
    return void res.end(buf);
  }

  throw new HttpError(404, 'no_such_endpoint', `${ctx.method} ${ctx.url.pathname} is not an endpoint; see GET /v1/contract`);
}

/**
 * Everything needed to leave, with a database that actually contains the data.
 *
 * Reading app.db off disk is not enough: in WAL mode the newest commits (and, on a young app,
 * the schema itself) live in app.db-wal, so a raw copy can restore to an empty database. The
 * snapshot is taken with VACUUM INTO -- the same technique scripts/backup.sh uses -- and it
 * runs inside the app's own process, because that is the only thing allowed to write into the
 * app's data directory.
 */
async function exportEntries(s: Services, app: AppRecord): Promise<Array<{ path: string; data: Buffer }>> {
  const entries = s.apps.exportEntries(app.id);
  const paths = s.apps.paths(app.id);
  const snapshot = join(paths.data, 'export-snapshot.db');
  rmSync(snapshot, { force: true }); // VACUUM INTO refuses to overwrite

  let data: Buffer | null = null;
  try {
    await s.runtime.sql(app.id, `vacuum into '${snapshot.split("'").join("''")}'`);
    data = readFileSync(snapshot);
  } catch (err) {
    // An app with no bundle cannot be started, so fall back to whatever is on disk rather
    // than failing the export outright. Say so in the log; a stale copy is worth flagging.
    s.apps.log(app.id, 'error', `export could not snapshot the database (${(err as Error).message}); falling back to the raw file`);
    if (existsSync(paths.db)) data = readFileSync(paths.db);
  } finally {
    rmSync(snapshot, { force: true });
  }
  if (data) entries.push({ path: 'app.db', data });
  return entries;
}

function describe(s: Services, app: AppRecord) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    owner: app.ownerEmail,
    version: app.version,
    url: appUrl(s, app),
    updatedAt: app.updatedAt,
  };
}

function appUrl(s: Services, app: AppRecord): string {
  return `${s.cfg.baseUrl}/a/${app.slug}`;
}

function requireUse(s: Services, ctx: RequestCtx, app: AppRecord): void {
  if (!canUse(roleFor(s.db, app, ctx.user))) throw new HttpError(403, 'forbidden', `${app.name} is not shared with ${ctx.user?.email}`);
}

function requireManage(s: Services, ctx: RequestCtx, app: AppRecord): void {
  if (!canManage(roleFor(s.db, app, ctx.user))) {
    throw new HttpError(403, 'forbidden', `you need to be the owner or an editor of ${app.name} to do that`);
  }
}

function requireOwner(ctx: RequestCtx, app: AppRecord): void {
  if (ctx.user?.email !== app.ownerEmail) throw new HttpError(403, 'forbidden', `only ${app.ownerEmail} can delete ${app.name}`);
}
