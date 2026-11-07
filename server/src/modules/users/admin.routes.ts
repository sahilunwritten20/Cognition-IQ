import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthContext, Guards } from '../../common/auth';
import { Errors } from '../../common/errors';
import { asyncHandler } from '../../common/http';
import { parse } from '../../common/validate';
import type { RequestMeta } from '../auth/auth.service';
import type { UserAdminService } from './admin.service';
import { ROLES, USER_STATUSES } from './user.model';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a valid id');
const loginId = z.string().trim().min(3).max(100).transform((s) => s.toLowerCase());

const listQuery = z
  .object({
    status: z.enum(USER_STATUSES).optional(),
    role: z.enum(ROLES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25), // bounded: never "return everything"
  })
  .strict();

const createBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    loginId,
    role: z.enum(ROLES), // a second SUPER_ADMIN is created here (never via public registration); audited
    departmentId: objectId.optional(),
  })
  .strict();

const reasonBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const requiredReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const meta = (req: Request): RequestMeta => ({ ip: req.ip, userAgent: req.header('user-agent'), requestId: req.id });
const actorOf = (req: Request): AuthContext => {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth;
};

export function adminRouter(svc: UserAdminService, guards: Guards): Router {
  const r = Router();
  // Deny by default: authenticated, fully set up (2FA done) AND SUPER_ADMIN.
  r.use(guards.requireAuth(), guards.requireRole('SUPER_ADMIN'));

  r.get('/users', asyncHandler(async (req, res) => {
    res.json(await svc.list(actorOf(req), parse(listQuery, req.query)));
  }));

  r.post('/users', asyncHandler(async (req, res) => {
    res.status(201).json(await svc.create(actorOf(req), parse(createBody, req.body), meta(req)));
  }));

  r.post('/users/:id/approve', asyncHandler(async (req, res) => {
    res.json({ user: await svc.approve(actorOf(req), parse(objectId, req.params.id), meta(req)) });
  }));

  r.post('/users/:id/reject', asyncHandler(async (req, res) => {
    const { reason } = parse(reasonBody, req.body ?? {});
    res.json({ user: await svc.reject(actorOf(req), parse(objectId, req.params.id), reason, meta(req)) });
  }));

  r.post('/users/:id/deactivate', asyncHandler(async (req, res) => {
    const { reason } = parse(reasonBody, req.body ?? {});
    res.json({ user: await svc.deactivate(actorOf(req), parse(objectId, req.params.id), reason, meta(req)) });
  }));

  r.post('/users/:id/activate', asyncHandler(async (req, res) => {
    res.json({ user: await svc.activate(actorOf(req), parse(objectId, req.params.id), meta(req)) });
  }));

  r.post('/users/:id/reset-2fa', asyncHandler(async (req, res) => {
    const { reason } = parse(requiredReasonBody, req.body ?? {});
    res.json({ user: await svc.resetTwoFactor(actorOf(req), parse(objectId, req.params.id), reason, meta(req)) });
  }));

  r.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
    res.json(await svc.resetPassword(actorOf(req), parse(objectId, req.params.id), meta(req)));
  }));

  return r;
}
