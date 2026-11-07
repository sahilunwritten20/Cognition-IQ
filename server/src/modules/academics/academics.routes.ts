import { Router, type Request } from 'express';
import type { Guards } from '../../common/auth';
import { asyncHandler } from '../../common/http';
import { actorOf, metaOf } from '../../common/request';
import { objectIdSchema, parse } from '../../common/validate';
import * as S from './academics.schemas';
import type { AcademicsService } from './academics.service';

const idOf = (req: Request): string => parse(objectIdSchema, req.params.id);

/**
 * Deny by default. Reads: SUPER_ADMIN (everything) and HOD (own department only, enforced in the
 * service). Writes: SUPER_ADMIN only. Teachers see only their own assignments.
 */
export function academicsRouter(svc: AcademicsService, guards: Guards): Router {
  const r = Router();
  const read = [guards.requireAuth(), guards.requireRole('SUPER_ADMIN', 'HOD')];
  const write = [guards.requireAuth(), guards.requireRole('SUPER_ADMIN')];
  const teacher = [guards.requireAuth(), guards.requireRole('TEACHER')];

  // ---- departments
  r.get('/departments', read, asyncHandler(async (req, res) => {
    res.json(await svc.listDepartments(actorOf(req), parse(S.departmentList, req.query)));
  }));
  r.post('/departments', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createDepartment(actorOf(req), parse(S.createDepartmentBody, req.body), metaOf(req)));
  }));
  r.patch('/departments/:id', write, asyncHandler(async (req, res) => {
    res.json(await svc.renameDepartment(actorOf(req), idOf(req), parse(S.updateNameBody, req.body), metaOf(req)));
  }));

  // ---- academic years
  r.get('/years', read, asyncHandler(async (req, res) => {
    res.json(await svc.listYears(actorOf(req), parse(S.yearList, req.query)));
  }));
  r.post('/years', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createYear(actorOf(req), parse(S.createYearBody, req.body), metaOf(req)));
  }));
  r.patch('/years/:id', write, asyncHandler(async (req, res) => {
    res.json(await svc.updateYear(actorOf(req), idOf(req), parse(S.updateYearBody, req.body), metaOf(req)));
  }));
  r.post('/years/:id/set-current', write, asyncHandler(async (req, res) => {
    res.json(await svc.setCurrentYear(actorOf(req), idOf(req), metaOf(req)));
  }));

  // ---- classes
  r.get('/classes', read, asyncHandler(async (req, res) => {
    res.json(await svc.listClasses(actorOf(req), parse(S.classList, req.query)));
  }));
  r.post('/classes', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createClass(actorOf(req), parse(S.createClassBody, req.body), metaOf(req)));
  }));
  r.patch('/classes/:id', write, asyncHandler(async (req, res) => {
    res.json(await svc.renameClass(actorOf(req), idOf(req), parse(S.updateNameBody, req.body), metaOf(req)));
  }));

  // ---- divisions
  r.get('/divisions', read, asyncHandler(async (req, res) => {
    res.json(await svc.listDivisions(actorOf(req), parse(S.divisionList, req.query)));
  }));
  r.post('/divisions', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createDivision(actorOf(req), parse(S.createDivisionBody, req.body), metaOf(req)));
  }));
  r.patch('/divisions/:id', write, asyncHandler(async (req, res) => {
    res.json(await svc.renameDivision(actorOf(req), idOf(req), parse(S.updateDivisionBody, req.body).name, metaOf(req)));
  }));

  // ---- subjects
  r.get('/subjects', read, asyncHandler(async (req, res) => {
    res.json(await svc.listSubjects(actorOf(req), parse(S.subjectList, req.query)));
  }));
  r.post('/subjects', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createSubject(actorOf(req), parse(S.createSubjectBody, req.body), metaOf(req)));
  }));
  r.patch('/subjects/:id', write, asyncHandler(async (req, res) => {
    res.json(await svc.renameSubject(actorOf(req), idOf(req), parse(S.updateNameBody, req.body), metaOf(req)));
  }));

  // ---- archive (nothing is ever hard-deleted)
  const archivable = { departments: 'department', years: 'year', classes: 'class', divisions: 'division', subjects: 'subject' } as const;
  for (const [path, kind] of Object.entries(archivable)) {
    r.post(`/${path}/:id/archive`, write, asyncHandler(async (req, res) => {
      res.json(await svc.archive(actorOf(req), kind, idOf(req), metaOf(req)));
    }));
  }

  // ---- enrollments
  r.get('/enrollments', read, asyncHandler(async (req, res) => {
    res.json(await svc.listEnrollments(actorOf(req), parse(S.enrollmentList, req.query)));
  }));
  r.post('/enrollments', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createEnrollment(actorOf(req), parse(S.createEnrollmentBody, req.body), metaOf(req)));
  }));
  r.patch('/enrollments/:id', write, asyncHandler(async (req, res) => {
    res.json(await svc.updateEnrollment(actorOf(req), idOf(req), parse(S.updateEnrollmentBody, req.body), metaOf(req)));
  }));

  // ---- teaching assignments ("mine" is declared before any /:id route)
  r.get('/teaching-assignments/mine', teacher, asyncHandler(async (req, res) => {
    res.json(await svc.myAssignments(actorOf(req)));
  }));
  r.get('/teaching-assignments', read, asyncHandler(async (req, res) => {
    res.json(await svc.listAssignments(actorOf(req), parse(S.assignmentList, req.query)));
  }));
  r.post('/teaching-assignments', write, asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createAssignment(actorOf(req), parse(S.createAssignmentBody, req.body), metaOf(req)));
  }));
  r.post('/teaching-assignments/:id/revoke', write, asyncHandler(async (req, res) => {
    res.json(await svc.revokeAssignment(actorOf(req), idOf(req), metaOf(req)));
  }));

  // ---- staff department (HOD / teacher)
  r.patch('/staff/:id/department', write, asyncHandler(async (req, res) => {
    const { departmentId } = parse(S.staffDepartmentBody, req.body);
    res.json({ user: await svc.setStaffDepartment(actorOf(req), idOf(req), departmentId, metaOf(req)) });
  }));

  return r;
}
