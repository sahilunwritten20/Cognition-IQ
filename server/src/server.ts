import 'dotenv/config';
import { Types } from 'mongoose';
import { createApp } from './app';
import { createLogger } from './common/logger';
import { RedisCounterStore } from './common/rateLimit';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './config/database';
import { parseEnv } from './config/env';
import { createRedis, isRedisReady } from './config/redis';
import { apiConfigFromEnv, createApiModules } from './modules';
import { User } from './modules/users/user.model';

async function main() {
  const env = parseEnv(process.env); // throws => process exits (fail fast)
  const logger = createLogger(env.LOG_LEVEL);

  await connectDatabase(env.MONGODB_URI);
  const activeAdmins = await User.countDocuments({
    collegeId: new Types.ObjectId(env.COLLEGE_ID),
    role: 'SUPER_ADMIN',
    status: 'active',
    deletedAt: null,
  });
  if (activeAdmins < 2) {
    logger.warn(
      { activeSuperAdmins: activeAdmins },
      'fewer than 2 active SUPER_ADMIN accounts: create a second one (docs/operations/RUNBOOK-admin-recovery.md)',
    );
  }

  const redis = createRedis(env.REDIS_URL);
  redis.connect().catch((err) => logger.warn({ err }, 'redis unavailable at startup (degraded)'));

  const modules = createApiModules(apiConfigFromEnv(env), { logger, store: new RedisCounterStore(redis) });
  const app = createApp({
    logger,
    clientOrigin: env.CLIENT_ORIGIN,
    checks: { mongo: isDatabaseReady, redis: () => isRedisReady(redis) },
    mount: modules.mount,
  });

  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));
  if (env.IMPORT_WORKER === 'inline') modules.importWorker.start();
  else logger.info('import worker not started in this process (IMPORT_WORKER=off); run `npm run start:worker`');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining in-flight requests');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close(async () => {
      await modules.importWorker.stop(); // finish the current batch; unfinished jobs resume after restart
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
