import { Router } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';
import type { AuthContext, Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf } from '../../common/request';
import { objectIdSchema as id, parse } from '../../common/validate';
import { User } from '../users/user.model';
import { AuditLog, type IAuditLog } from './audit.model';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const date = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const auditQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().trim().min(1).max(100).optional(), // exact, e.g. results.published
    actionPrefix: z.string().trim().min(1).max(100).optional(), // e.g. "quizzes." or "results."
    actorId: id.optional(),
    targetType: z.string().trim().min(1).max(50).optional(),
    targetId: z.string().trim().min(1).max(64).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must not be after to', path: ['to'] });

/**
 * Read-only audit search for SUPER_ADMIN. The audit log is append-only by construction: the application has no API that
 * updates or deletes an entry. HOD and teacher views of their own area are PROPOSED (D-18) and not enabled.
 */
export class AuditQueryService {
  async search(actor: AuthContext, q: z.output<typeof auditQuery>) {
    const filter: FilterQuery<IAuditLog> = { collegeId: actor.collegeId };
    if (q.action) filter.action = q.action;
    else if (q.actionPrefix) filter.action = { $regex: `^${escapeRegex(q.actionPrefix)}` }; // anchored and escaped: user input is never a pattern
    if (q.actorId) filter.actorId = q.actorId;
    if (q.targetType) filter.targetType = q.targetType;
    if (q.targetId) filter.targetId = q.targetId;
    if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };

    const [docs, total] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      AuditLog.countDocuments(filter),
    ]);
    const actors = await User.find({ _id: { $in: docs.flatMap((d) => (d.actorId ? [d.actorId] : [])) }, collegeId: actor.collegeId }).select('name loginId role');
    const byId = new Map(actors.map((u): [string, typeof u] => [u.id as string, u]));
    return {
      items: docs.map((d) => {
        const u = d.actorId ? byId.get(d.actorId.toString()) : undefined;
        return {
          id: d.id as string,
          at: d.at.toISOString(),
          action: d.action,
          actor: u ? { id: u.id as string, name: u.name, loginId: u.loginId, role: u.role } : d.actorId ? { id: d.actorId.toString(), name: null, loginId: null, role: null } : null,
          targetType: d.targetType ?? null,
          targetId: d.targetId ?? null,
          summary: d.summary ?? null,
          requestId: d.requestId ?? null,
          ip: d.ip ?? null,
        };
      }),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }
}

export function auditRouter(svc: AuditQueryService, guards: Guards): Router {
  const r = Router();
  r.get('/', guards.requireAuth(), guards.requireRole('SUPER_ADMIN'), asyncHandler(async (req, res) => {
    res.json(await svc.search(actorOf(req), parse(auditQuery, req.query)));
  }));
  return r;
}
