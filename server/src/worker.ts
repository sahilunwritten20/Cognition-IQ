import 'dotenv/config';
import { createLogger } from './common/logger';
import { MemoryCounterStore } from './common/rateLimit';
import { connectDatabase, disconnectDatabase } from './config/database';
import { parseEnv } from './config/env';
import { apiConfigFromEnv, createApiModules } from './modules';

/**
 * Dedicated background-worker process (no HTTP server). Production layout: API instances run with
 * IMPORT_WORKER=off and one of these processes does the CPU-heavy work (password hashing), so imports
 * can never slow down students taking an exam. Same environment variables as the API.
 * Several workers may run at once: jobs are claimed atomically with a lease.
 */
async function main() {
  const env = parseEnv(process.env); // fail fast
  const logger = createLogger(env.LOG_LEVEL);
  await connectDatabase(env.MONGODB_URI);

  // The worker needs no Redis: the (unused here) rate-limit store is a throwaway in-memory one.
  const modules = createApiModules(apiConfigFromEnv(env), { logger, store: new MemoryCounterStore() });
  modules.importWorker.start();
  modules.sweeper.start(); // finalizes attempts of students who left; a database lease keeps it to one run per round
  logger.info('import worker and deadline sweeper started (dedicated process)');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'stopping worker: finishing the current batch');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    await modules.sweeper.stop();
    await modules.importWorker.stop(); // an unfinished job resumes after its lease expires
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
