import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Router } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { errorHandler, noStore, notFoundHandler, requestId } from './common/http';
import type { Logger } from './common/logger';
import { healthRouter, type HealthChecks } from './modules/health/health.routes';

export interface AppDeps {
  logger: Logger;
  clientOrigin: string;
  checks: HealthChecks;
  /** Mounts feature routers on /api/v1 (see modules/index.ts). Omitted in infrastructure-only tests. */
  mount?: (v1: Router) => void;
}

export function createApp({ logger, clientOrigin, checks, mount }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one load balancer; adjust to your hosting so req.ip is the client

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (r) => r.url === '/health' },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: new URL(clientOrigin).origin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(healthRouter(checks));

  const v1 = express.Router();
  v1.use(noStore);
  mount?.(v1);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
