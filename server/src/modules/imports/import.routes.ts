import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { Guards } from '../../common/auth';
import { Errors } from '../../common/errors';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import { ROW_STATUSES } from './import.models';
import { MAX_BYTES, MAX_ROWS, type ImportService } from './import.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const uploadQuery = z.object({ academicYearId: objectIdSchema.optional(), fileName: z.string().trim().max(200).optional() }).strict();
const listQuery = z.object(paging).strict();
const rowsQuery = z.object({ ...paging, status: z.enum(ROW_STATUSES).optional() }).strict();
const confirmBody = z.object({ skipInvalid: z.boolean().default(false) }).strict();
const reissueBody = z
  .object({
    importJobId: objectIdSchema.optional(),
    classId: objectIdSchema.optional(),
    divisionId: objectIdSchema.optional(),
    loginIds: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_ROWS).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => [v.importJobId, v.classId, v.divisionId, v.loginIds].filter((x) => x !== undefined).length === 1, {
    message: 'provide exactly one of importJobId, classId, divisionId, loginIds',
  });

/** Imports are SUPER_ADMIN-only. Upload the CSV as the raw body with Content-Type: text/csv. */
export function importRouter(svc: ImportService, guards: Guards): Router {
  const r = Router();
  r.use(guards.requireAuth(), guards.requireRole('SUPER_ADMIN'));

  r.get('/students/template', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.csv"');
    res.send(svc.template());
  });

  r.post(
    '/students',
    express.text({ type: ['text/csv', 'text/plain'], limit: MAX_BYTES }),
    asyncHandler(async (req, res) => {
      if (typeof req.body !== 'string') {
        throw Errors.validation([{ path: 'body', message: 'Send the CSV as the request body with Content-Type: text/csv' }]);
      }
      res.status(201).json(await svc.createStudentJob(actorOf(req), req.body, parse(uploadQuery, req.query), metaOf(req)));
    }),
  );

  // Fresh temporary passwords for a set of students (preview -> confirm -> one-time download, like an import).
  r.post('/credentials/reissue', asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createReissueJob(actorOf(req), parse(reissueBody, req.body), metaOf(req)));
  }));

  r.get('/', asyncHandler(async (req, res) => {
    res.json(await svc.list(actorOf(req), parse(listQuery, req.query)));
  }));
  r.get('/:id', asyncHandler(async (req, res) => {
    res.json(await svc.get(actorOf(req), idOf(req)));
  }));
  r.get('/:id/rows', asyncHandler(async (req, res) => {
    res.json(await svc.rows(actorOf(req), idOf(req), parse(rowsQuery, req.query)));
  }));
  r.post('/:id/confirm', asyncHandler(async (req, res) => {
    const { skipInvalid } = parse(confirmBody, req.body ?? {});
    res.json(await svc.confirm(actorOf(req), idOf(req), skipInvalid, metaOf(req)));
  }));
  r.post('/:id/retry', asyncHandler(async (req, res) => {
    res.json(await svc.retry(actorOf(req), idOf(req), metaOf(req)));
  }));
  r.post('/:id/cancel', asyncHandler(async (req, res) => {
    res.json(await svc.cancel(actorOf(req), idOf(req), metaOf(req)));
  }));

  // One-time download of temporary passwords. POST (not GET) so browsers, proxies and link
  // prefetchers can never trigger the single download by accident.
  r.post('/:id/credentials/export', asyncHandler(async (req, res) => {
    const { csv, fileName } = await svc.exportCredentials(actorOf(req), idOf(req), metaOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }));

  return r;
}
