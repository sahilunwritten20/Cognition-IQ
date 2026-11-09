import { Router, type Request } from 'express';
import type { Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import { createQuizBody, listQuery, pagingQuery, reasonBody } from './quiz.schemas';
import type { QuizService } from './quiz.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

/** Teacher-facing quiz management. HOD and SUPER_ADMIN are read-only; students use studentQuizRouter. */
export function quizRouter(svc: QuizService, guards: Guards): Router {
  const r = Router();
  const read = [guards.requireAuth(), guards.requireRole('TEACHER', 'HOD', 'SUPER_ADMIN')];
  const teacher = [guards.requireAuth(), guards.requireRole('TEACHER')];

  r.get('/', read, asyncHandler(async (req, res) => {
    res.json(await svc.list(actorOf(req), parse(listQuery, req.query)));
  }));
  r.post('/', teacher, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.create(actorOf(req), parse(createQuizBody, req.body), metaOf(req)));
  }));
  r.get('/:id', read, asyncHandler(async (req, res) => {
    res.json(await svc.get(actorOf(req), idOf(req)));
  }));
  r.patch('/:id', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.update(actorOf(req), idOf(req), req.body ?? {}, metaOf(req)));
  }));
  r.get('/:id/eligible-students', read, asyncHandler(async (req, res) => {
    res.json(await svc.eligibleStudents(actorOf(req), idOf(req), parse(pagingQuery, req.query)));
  }));

  r.post('/:id/publish', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.publish(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.post('/:id/unpublish', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.unpublish(actorOf(req), idOf(req), parse(reasonBody, req.body ?? {}).reason, metaOf(req)));
  }));
  r.post('/:id/pause', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.pause(actorOf(req), idOf(req), parse(reasonBody, req.body ?? {}).reason, metaOf(req)));
  }));
  r.post('/:id/resume', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.resume(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.post('/:id/close', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.close(actorOf(req), idOf(req), parse(reasonBody, req.body ?? {}).reason, metaOf(req)));
  }));
  r.post('/:id/code/regenerate', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.regenerateCode(actorOf(req), idOf(req), metaOf(req)));
  }));

  return r;
}

/** Mounted at /student/quizzes. Students see only quizzes for their own enrollment, via an allow-listed DTO. */
export function studentQuizRouter(svc: QuizService, guards: Guards): Router {
  const r = Router();
  r.get('/', guards.requireAuth(), guards.requireRole('STUDENT'), asyncHandler(async (req, res) => {
    res.json(await svc.studentQuizzes(actorOf(req), parse(pagingQuery, req.query)));
  }));
  return r;
}
