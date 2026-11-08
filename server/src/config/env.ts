import { z } from 'zod';

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    CLIENT_ORIGIN: z.string().url(),
    MONGODB_URI: z.string().min(1),
    REDIS_URL: z.string().min(1),
    COLLEGE_ID: z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex ObjectId'),
    ACCESS_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),
    REFRESH_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    TWO_FACTOR_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'must be 64 hex characters (32 bytes)'),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
    // Where the import worker runs: 'inline' inside this API process (dev), or 'off' when a dedicated
    // worker process (npm run start:worker) does the work. Large imports hash passwords: CPU heavy.
    IMPORT_WORKER: z.enum(['inline', 'off']).default('inline'),
    // Import rows hold names and login IDs. They are deleted automatically this many days after completion (D-06).
    IMPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    COOKIE_SECURE: boolString.default('false'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((e, ctx) => {
    if (e.ACCESS_TOKEN_SECRET === e.REFRESH_TOKEN_SECRET) {
      ctx.addIssue({ code: 'custom', message: 'token secrets must differ', path: ['REFRESH_TOKEN_SECRET'] });
    }
    if ((e.NODE_ENV === 'production' || e.NODE_ENV === 'staging') && !e.CLIENT_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', message: 'must use https outside development', path: ['CLIENT_ORIGIN'] });
    }
    if ((e.NODE_ENV === 'production' || e.NODE_ENV === 'staging') && !e.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', message: 'must be true outside development', path: ['COOKIE_SECURE'] });
    }
  });

export type Env = z.infer<typeof schema>;

/** Fail fast: throws with a readable list of problems (never prints secret values). */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
