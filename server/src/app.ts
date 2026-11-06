import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { errorHandler, notFoundHandler, requestId } from './common/http';
import type { Logger } from './common/logger';
import { healthRouter, type HealthChecks } from './modules/health/health.routes';

export interface AppDeps {
  logger: Logger;
  clientOrigin: string;
  checks: HealthChecks;
}

export function createApp({ logger, clientOrigin, checks }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind a load balancer; adjust to your hosting

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => (req as express.Request).id, autoLogging: { ignore: (r) => r.url === '/health' } }));
  app.use(helmet());
  app.use(cors({ origin: clientOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter(checks));

  const v1 = express.Router();
  // Feature modules mount here from Step 2 onward: v1.use('/auth', authRouter) ...
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
