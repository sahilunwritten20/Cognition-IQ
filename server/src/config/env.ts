import { z } from 'zod';

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    CLIENT_ORIGIN: z.string().url(),
    MONGODB_URI: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ACCESS_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),
    REFRESH_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    COOKIE_SECURE: boolString.default('false'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((e, ctx) => {
    if (e.ACCESS_TOKEN_SECRET === e.REFRESH_TOKEN_SECRET) {
      ctx.addIssue({ code: 'custom', message: 'token secrets must differ', path: ['REFRESH_TOKEN_SECRET'] });
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
