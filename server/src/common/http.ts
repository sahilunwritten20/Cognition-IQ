import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, Errors } from './errors';
import type { Logger } from './logger';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
};

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(Errors.notFound());

/** Stable envelope: { error: { code, message, requestId, details? } }. Never leaks stacks. */
export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, requestId: req.id, details: err.details },
      });
      return;
    }
    if (err?.type === 'entity.too.large' || err?.type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', requestId: req.id },
      });
      return;
    }
    logger.error({ err, requestId: req.id }, 'unhandled error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId: req.id },
    });
  };
