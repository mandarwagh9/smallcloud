import { SESSION_COOKIE, type RequestCtx, type Services } from './server.js';
import { AuthError } from './auth.js';
import { ShareError, listShares, parsePrincipal, parseRole, roleFor, canManage, setShare, removeShare } from './shares.js';
import { DeployError } from './apps.js';
import { HttpError, cookieHeader, parseCookies, readBody, redirect, sendHtml } from './httputil.js';
import { consoleMailer } from './email.js';
import { renderCheckEmail, renderCliApprove, renderDashboard, renderError, renderLanding, renderLogin, renderManage, renderTokens } from './views.js';

/** Browser pages. Everything here is HTML; the JSON surface lives in api.ts. */
export async function handlePage(s: Services, ctx: RequestCtx): Promise<void> {
  const { res, method, url } = ctx;
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean);

  if (path === '/') return sendHtml(res, 200, renderLanding(s.cfg.baseUrl, ctx.user !== null));

  if (path === '/login') {
    if (method === 'GET') return sendHtml(res, 200, renderLogin(safeNext(url.searchParams.get('next'))));
    if (method === 'POST') return login(s, ctx);
  }

  if (seg[0] === 'auth' && seg.length === 2 && method === 'GET') {
    const out = s.auth.consumeMagicLink(seg[1]);
    if (!out) return sendHtml(res, 400, renderError('That link did not work', 'Sign-in links work once and expire after 15 minutes. Ask for a new one.'));
    return redirect(res, safeNext(out.next), {
      'set-cookie': cookieHeader(SESSION_COOKIE, out.sessionId, { maxAge: 30 * 24 * 3600, secure: s.secure }),
    });
  }

  if (path === '/logout') {
    const sid = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    if (sid) s.auth.destroySession(sid);
    return redirect(res, '/', { 'set-cookie': cookieHeader(SESSION_COOKIE, '', { maxAge: 0, secure: s.secure }) });
  }

  // --- everything below needs a signed-in browser ---
  const user = ctx.user;
  if (!user) return redirect(res, `/login?next=${encodeURIComponent(path + url.search)}`);

  if (path === '/me' && method === 'GET') {
    const apps = s.apps.listFor(user).map((a) => ({
      ...a,
      url: `${s.cfg.baseUrl}/a/${a.slug}`,
      shares: listShares(s.db, a.id).length,
    }));
    return sendHtml(res, 200, renderDashboard(user, apps));
  }

  if (path === '/me/tokens') {
    if (method === 'GET') return sendHtml(res, 200, renderTokens(user, s.auth.listApiTokens(user.email)));
    if (method === 'POST') {
      const form = await formData(ctx);
      const token = s.auth.createApiToken(user.email, (form.get('name') || 'token').slice(0, 40));
      return sendHtml(res, 200, renderTokens(user, s.auth.listApiTokens(user.email), token));
    }
  }

  if (seg[0] === 'cli' && seg.length === 2) {
    if (method === 'GET') return sendHtml(res, 200, renderCliApprove(user, seg[1], false));
    if (method === 'POST') {
      const ok = s.auth.approveCliLogin(seg[1], user.email);
      if (!ok) return sendHtml(res, 400, renderError('That code expired', 'Run the login command again to get a fresh one.'));
      return sendHtml(res, 200, renderCliApprove(user, seg[1], true));
    }
  }

  if (seg[0] === 'apps' && seg.length >= 2) {
    const app = s.apps.get(seg[1]);
    if (!app) return sendHtml(res, 404, renderError('No such app', `There is no app with id ${seg[1]}.`));
    if (!canManage(roleFor(s.db, app, user))) {
      return sendHtml(res, 403, renderError('Not yours to manage', `You need to be the owner or an editor of ${app.name}.`));
    }
    const action = seg[2];
    const back = `/apps/${app.id}`;

    if (!action && method === 'GET') {
      return sendHtml(
        res,
        200,
        renderManage(
          user,
          app,
          `${s.cfg.baseUrl}/a/${app.slug}`,
          listShares(s.db, app.id),
          s.apps.secretKeys(app.id),
          s.apps.logs(app.id, 120),
          app.ownerEmail === user.email,
        ),
      );
    }

    if (method === 'POST') {
      const form = await formData(ctx);
      try {
        if (action === 'share') {
          setShare(s.db, app.id, parsePrincipal(form.get('principal') ?? ''), parseRole(form.get('role')));
          return redirect(res, back);
        }
        if (action === 'unshare') {
          removeShare(s.db, app.id, parsePrincipal(form.get('principal') ?? ''));
          return redirect(res, back);
        }
        if (action === 'secret') {
          s.apps.setSecret(app.id, form.get('key') ?? '', form.get('value') ?? '');
          s.runtime.stop(app.id);
          return redirect(res, back);
        }
        if (action === 'delete') {
          if (app.ownerEmail !== user.email) return sendHtml(res, 403, renderError('Not yours to delete', `Only ${app.ownerEmail} can delete this app.`));
          s.runtime.stop(app.id);
          s.apps.delete(app.id);
          return redirect(res, '/me');
        }
      } catch (err) {
        if (err instanceof ShareError || err instanceof DeployError) return sendHtml(res, 400, renderError('That did not work', err.message));
        throw err;
      }
    }
  }

  return sendHtml(res, 404, renderError('Not found', `There is nothing at ${path}.`));
}

async function login(s: Services, ctx: RequestCtx): Promise<void> {
  const form = await formData(ctx);
  const email = (form.get('email') ?? '').trim();
  const next = safeNext(form.get('next'));
  if (!s.limiters.loginIp.take(ctx.ip) || !s.limiters.login.take(email.toLowerCase())) {
    return sendHtml(ctx.res, 429, renderLogin(next, 'Too many sign-in attempts. Wait a few minutes and try again.'));
  }
  try {
    const link = await s.auth.requestMagicLink(email, next);
    // With no email provider configured the link cannot be delivered, so show it on the page.
    const isDevMailer = !process.env.RESEND_API_KEY;
    return sendHtml(ctx.res, 200, renderCheckEmail(email, isDevMailer ? link : undefined));
  } catch (err) {
    if (err instanceof AuthError) return sendHtml(ctx.res, 400, renderLogin(next, err.message));
    throw err;
  }
}

/** Reads an application/x-www-form-urlencoded body. Rejects cross-origin form posts. */
async function formData(ctx: RequestCtx): Promise<Map<string, string>> {
  const origin = ctx.req.headers.origin;
  if (origin) {
    const expected = new URL(ctx.url.origin).host;
    if (new URL(origin).host !== expected) throw new HttpError(403, 'bad_origin', 'cross-site form posts are not allowed');
  }
  const buf = await readBody(ctx.req, 1024 * 512);
  const params = new URLSearchParams(buf.toString('utf8'));
  return new Map(params.entries());
}

/** Only same-site paths are acceptable redirect targets. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/me';
  return next;
}

export { consoleMailer };
