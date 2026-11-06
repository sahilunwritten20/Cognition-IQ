import { Router } from 'express';

export interface HealthChecks {
  mongo: () => Promise<boolean>;
  redis: () => Promise<boolean>;
}

/** Infrastructure endpoints: unversioned, no secrets, no internals. */
export function healthRouter(checks: HealthChecks): Router {
  const router = Router();

  // Liveness: the process is up.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: MongoDB is required. Redis down = "degraded" but still ready (T-05).
  router.get('/ready', async (_req, res) => {
    const [mongo, redis] = await Promise.all([checks.mongo(), checks.redis()]);
    res.status(mongo ? 200 : 503).json({
      status: mongo ? (redis ? 'ready' : 'degraded') : 'not_ready',
      checks: { mongo: mongo ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    });
  });

  return router;
}
