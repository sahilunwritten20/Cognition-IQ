import type { Request } from 'express';
import type { AuthContext } from './auth';
import { Errors } from './errors';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip,
  userAgent: req.header('user-agent'),
  requestId: req.id,
});

export const actorOf = (req: Request): AuthContext => {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth;
};
