import { Router, type Request } from 'express';
import type { Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import { createQuestionBody, listQuery } from './question.schemas';
import type { QuestionService } from './question.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

/**
 * Teacher-facing question bank (responses contain the answer key). Students have NO access here:
 * what a student receives is built elsewhere, from toStudentQuestionDto.
 */
export function questionRouter(svc: QuestionService, guards: Guards): Router {
  const r = Router();
  const read = [guards.requireAuth(), guards.requireRole('TEACHER', 'SUPER_ADMIN')]; // SUPER_ADMIN: audited support read
  const teacher = [guards.requireAuth(), guards.requireRole('TEACHER')];

  r.get('/my-subjects', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.mySubjects(actorOf(req)));
  }));
  r.get('/', read, asyncHandler(async (req, res) => {
    res.json(await svc.list(actorOf(req), parse(listQuery, req.query), metaOf(req)));
  }));
  r.post('/', teacher, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.create(actorOf(req), parse(createQuestionBody, req.body), metaOf(req)));
  }));
  r.get('/:id', read, asyncHandler(async (req, res) => {
    res.json(await svc.get(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.patch('/:id', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.update(actorOf(req), idOf(req), req.body ?? {}, metaOf(req)));
  }));
  r.post('/:id/archive', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.archive(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.post('/:id/restore', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.restore(actorOf(req), idOf(req), metaOf(req)));
  }));

  return r;
}
