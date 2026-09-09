import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 6 * 1024 * 1024; // a little over the bundle limit, for JSON overhead

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  if (!buf.length) return {} as T;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), ...headers });
  res.end(s);
}

export function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(html);
}

export function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookieHeader(name: string, value: string, opts: { maxAge?: number; secure: boolean; path?: string }): string {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) bits.push('Secure');
  return bits.join('; ');
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd;
    if (first) return first.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Fixed-window counter. Enough for sign-in and deploy abuse; not a distributed limiter.
 *
 * The map is hard-bounded. Sweeping only expired entries is not enough on its own: with more
 * live keys than the cap (many client IPs inside one window), every insert would rescan the
 * whole map, free nothing, and grow it anyway -- an O(n) tax per request that gets worse as it
 * goes. When a sweep cannot get under the cap, the oldest entries are evicted instead. Evicting
 * a counter is safe in the generous direction: the key simply starts a fresh window.
 */
const MAX_TRACKED_KEYS = 5000;

export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      if (this.hits.size >= MAX_TRACKED_KEYS) this.evict(t);
      this.hits.set(key, { n: 1, resetAt: t + this.windowMs });
      return true;
    }
    if (cur.n >= this.limit) return false;
    cur.n++;
    return true;
  }

  /** Visible for tests. */
  size(): number {
    return this.hits.size;
  }

  private evict(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    if (this.hits.size < MAX_TRACKED_KEYS) return;
    // Still full of live windows: drop the oldest tenth. Map preserves insertion order, so
    // the first keys are the ones whose windows started earliest.
    let drop = Math.ceil(MAX_TRACKED_KEYS / 10);
    for (const k of this.hits.keys()) {
      if (drop-- <= 0) break;
      this.hits.delete(k);
    }
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}
