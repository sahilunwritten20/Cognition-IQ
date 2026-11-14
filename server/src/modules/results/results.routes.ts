import { Router, type Request } from 'express';
import type { Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import { pagingQuery, reasonBody, regradeBody, tableQuery, visibilityBody } from './results.schemas';
import type { ResultsService } from './results.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

/**
 * Teacher side, mounted at /quizzes. Results are readable by the owning TEACHER, the department's HOD (read-only) and
 * SUPER_ADMIN (read-only, audited). Everything that changes something is the owning teacher only.
 */
export function resultsRouter(svc: ResultsService, guards: Guards): Router {
  const r = Router();
  const read = [guards.requireAuth(), guards.requireRole('TEACHER', 'HOD', 'SUPER_ADMIN')];
  const teacher = [guards.requireAuth(), guards.requireRole('TEACHER')];

  r.get('/:id/results', read, asyncHandler(async (req, res) => {
    res.json(await svc.table(actorOf(req), idOf(req), parse(tableQuery, req.query), metaOf(req)));
  }));
  r.get('/:id/results/export', read, asyncHandler(async (req, res) => {
    const { csv, fileName } = await svc.exportCsv(actorOf(req), idOf(req), metaOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }));

  r.post('/:id/finalize-expired', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.finalizeExpired(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.post('/:id/results/publish', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.publish(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.post('/:id/results/unpublish', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.unpublish(actorOf(req), idOf(req), parse(reasonBody, req.body ?? {}).reason, metaOf(req)));
  }));
  r.post('/:id/results/visibility', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.setVisibility(actorOf(req), idOf(req), parse(visibilityBody, req.body ?? {}), metaOf(req)));
  }));
  r.post('/:id/regrade', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.regrade(actorOf(req), idOf(req), parse(regradeBody, req.body ?? {}), metaOf(req)));
  }));
  r.post('/:id/regrade/resume', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.resumeRegrade(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.get('/:id/attempts/:attemptId', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.attemptDetail(actorOf(req), idOf(req), parse(objectIdSchema, req.params.attemptId)));
  }));

  return r;
}

/** Student side, mounted at /student: only released results, only your own. */
export function studentResultsRouter(svc: ResultsService, guards: Guards): Router {
  const r = Router();
  const student = [guards.requireAuth(), guards.requireRole('STUDENT')];
  r.get('/results', student, asyncHandler(async (req, res) => {
    res.json(await svc.studentResults(actorOf(req), parse(pagingQuery, req.query)));
  }));
  r.get('/quizzes/:id/result', student, asyncHandler(async (req, res) => {
    res.json(await svc.studentResult(actorOf(req), idOf(req)));
  }));
  return r;
}
