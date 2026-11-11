import { Router, type Request } from 'express';
import type { Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import { saveBody, startBody, submitBody } from './attempt.schemas';
import type { AttemptService } from './attempt.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

/**
 * Student exam endpoints, mounted at /student. Students only; every response is an explicit allow-list and contains no
 * answer key, no score and no grading data.
 */
export function studentExamRouter(svc: AttemptService, guards: Guards): Router {
  const r = Router();
  const student = [guards.requireAuth(), guards.requireRole('STUDENT')];

  // Creates the attempt (201) or returns the running one (200): starting twice is harmless.
  r.post('/quizzes/:id/start', student, asyncHandler(async (req, res) => {
    const out = await svc.start(actorOf(req), idOf(req), parse(startBody, req.body ?? {}), metaOf(req));
    res.status(out.resumed ? 200 : 201).json(out);
  }));

  // Resume after a refresh or reconnect: the questions and the latest acknowledged answers, plus the server clock.
  r.get('/attempts/:id', student, asyncHandler(async (req, res) => {
    res.json(await svc.get(actorOf(req), idOf(req)));
  }));

  // Cumulative, sequence-guarded autosave (PUT: sending the same request again changes nothing).
  r.put('/attempts/:id/answers', student, asyncHandler(async (req, res) => {
    res.json(await svc.saveAnswers(actorOf(req), idOf(req), parse(saveBody, req.body)));
  }));

  // Idempotent: repeating it returns the same final state.
  r.post('/attempts/:id/submit', student, asyncHandler(async (req, res) => {
    res.json(await svc.submit(actorOf(req), idOf(req), parse(submitBody, req.body ?? {})));
  }));

  return r;
}
