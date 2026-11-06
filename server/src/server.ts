import 'dotenv/config';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './config/database';
import { parseEnv } from './config/env';
import { createRedis, isRedisReady } from './config/redis';
import { createLogger } from './common/logger';

async function main() {
  const env = parseEnv(process.env); // throws => process exits (fail fast)
  const logger = createLogger(env.LOG_LEVEL);

  await connectDatabase(env.MONGODB_URI);
  const redis = createRedis(env.REDIS_URL);
  redis.connect().catch((err) => logger.warn({ err }, 'redis unavailable at startup (degraded)'));

  const app = createApp({
    logger,
    clientOrigin: env.CLIENT_ORIGIN,
    checks: { mongo: isDatabaseReady, redis: () => isRedisReady(redis) },
  });

  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining in-flight requests');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close(async () => {
      await Promise.allSettled([disconnectDatabase(), redis.quit()]);
      logger.info('shutdown complete');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
