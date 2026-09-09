import { resolve } from 'node:path';

export interface Config {
  dataDir: string;
  baseUrl: string;
  port: number;
  secret: string;
  allowedEmails: string[];
  trustProxy: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.SC_BASE_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/$/, '');
  const secret = env.SC_SECRET || '';
  if (!secret && env.NODE_ENV === 'production') {
    throw new Error('SC_SECRET is required in production. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return {
    dataDir: resolve(env.SC_DATA_DIR || './data'),
    baseUrl,
    port: Number(env.PORT || 8787),
    secret: secret || 'dev-insecure-secret-do-not-use-in-production',
    allowedEmails: (env.SC_ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: env.SC_TRUST_PROXY === '1' || env.SC_TRUST_PROXY === 'true',
  };
}
