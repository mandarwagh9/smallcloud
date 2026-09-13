import { resolve } from 'node:path';

export interface Config {
  dataDir: string;
  baseUrl: string;
  port: number;
  secret: string;
  allowedEmails: string[];
  trustProxy: boolean;
  /** POSIX only. Run app processes as this user so the OS, not Node, enforces isolation. */
  appUid?: number;
  appGid?: number;
  /** Per app, per IP, per minute. Defaults match the capacity targets in docs/PLAN.md NF2. */
  staticRpm: number;
  apiRpm: number;
  deployPerHour: number;
  appQuotaBytes: number;
  appMaxFiles: number;
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
    appUid: env.SC_APP_UID ? Number(env.SC_APP_UID) : undefined,
    appGid: env.SC_APP_GID ? Number(env.SC_APP_GID) : undefined,
    staticRpm: Number(env.SC_STATIC_RPM || 3000),
    apiRpm: Number(env.SC_API_RPM || 1200),
    deployPerHour: Number(env.SC_DEPLOY_PER_HOUR || 30),
    appQuotaBytes: Number(env.SC_APP_QUOTA_BYTES || 100 * 1024 * 1024),
    appMaxFiles: Number(env.SC_APP_MAX_FILES || 10000),
  };
}
