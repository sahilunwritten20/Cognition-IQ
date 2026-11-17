import { Router, type Request } from 'express';
import type { Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import { emergencyCloseBody, extendBody, monitorQuery, reopenBody } from './monitor.schemas';
import type { MonitorService } from './monitor.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

/**
 * Mounted at /quizzes. Watching: the owning TEACHER, the department's HOD (read-only) and SUPER_ADMIN (read-only).
 * Acting: the owning TEACHER; SUPER_ADMIN only for the two emergency actions (extend time, emergency close). Every action
 * needs a reason and is audited.
 */
export function monitorRouter(svc: MonitorService, guards: Guards): Router {
  const r = Router();
  const read = [guards.requireAuth(), guards.requireRole('TEACHER', 'HOD', 'SUPER_ADMIN')];
  const teacher = [guards.requireAuth(), guards.requireRole('TEACHER')];
  const teacherOrAdmin = [guards.requireAuth(), guards.requireRole('TEACHER', 'SUPER_ADMIN')];

  r.get('/:id/monitor', read, asyncHandler(async (req, res) => {
    res.json(await svc.monitor(actorOf(req), idOf(req), parse(monitorQuery, req.query)));
  }));
  r.post('/:id/extend', teacherOrAdmin, asyncHandler(async (req, res) => {
    res.json(await svc.extend(actorOf(req), idOf(req), parse(extendBody, req.body), metaOf(req)));
  }));
  r.post('/:id/emergency-close', teacherOrAdmin, asyncHandler(async (req, res) => {
    res.json(await svc.emergencyClose(actorOf(req), idOf(req), parse(emergencyCloseBody, req.body ?? {}).reason, metaOf(req)));
  }));
  r.post('/:id/attempts/:attemptId/reopen', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.reopen(actorOf(req), idOf(req), parse(objectIdSchema, req.params.attemptId), parse(reopenBody, req.body), metaOf(req)));
  }));

  return r;
}
