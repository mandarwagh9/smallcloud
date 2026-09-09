import { createHmac, createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

export function randomId(bytes = 9): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** value.signature, verified with a constant-time compare. */
export function sign(secret: string, value: string): string {
  const sig = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${sig}`;
}

export function verify(secret: string, signed: string | null | undefined): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const expected = sign(secret, value);
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(`smallcloud:secrets:${secret}`).digest();
}

/** AES-256-GCM, iv.tag.ciphertext (base64url). Used for app secrets at rest. */
export function encrypt(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(secret: string, blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
