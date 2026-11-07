import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Department } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { ROLES, type Role } from '../src/modules/users/user.model';
import { bearer, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let adminToken: string;
let n = 0;
const uniq = (prefix: string) => `${prefix}${++n}`;
const oid = () => new Types.ObjectId().toString();

type Method = 'get' | 'post' | 'patch';
const call = (method: Method, path: string, token: string, body?: object) =>
  request(ctx.app)[method](`/api/v1/academics${path}`).set(bearer(token)).send(body);
const asAdmin = (method: Method, path: string, body?: object) => call(method, path, adminToken, body);

interface Rec { id: string; [k: string]: unknown }

async function mkDept(code = uniq('D')): Promise<Rec> {
  const r = await asAdmin('post', '/departments', { name: `Dept ${code}`, code });
  expect(r.status).toBe(201);
  return r.body as Rec;
}
async function mkYear(label = `Y${uniq('')}-26`): Promise<Rec> {
  const r = await asAdmin('post', '/years', { label, startDate: '2026-06-01', endDate: '2027-05-31' });
  expect(r.status).toBe(201);
  return r.body as Rec;
}
async function mkClass(departmentId: string, academicYearId: string, code = uniq('C')): Promise<Rec> {
  const r = await asAdmin('post', '/classes', { departmentId, academicYearId, name: `Class ${code}`, code });
  expect(r.status).toBe(201);
  return r.body as Rec;
}
async function mkDivision(classId: string, name = 'A'): Promise<Rec> {
  const r = await asAdmin('post', '/divisions', { classId, name });
  expect(r.status).toBe(201);
  return r.body as Rec;
}
async function mkSubject(departmentId: string, code = uniq('S')): Promise<Rec> {
  const r = await asAdmin('post', '/subjects', { departmentId, name: `Subject ${code}`, code });
  expect(r.status).toBe(201);
  return r.body as Rec;
}
async function structure() {
  const dept = await mkDept();
  const year = await mkYear();
  const cls = await mkClass(dept.id, year.id);
  const div = await mkDivision(cls.id);
  const subject = await mkSubject(dept.id);
  return { dept, year, cls, div, subject };
}
const enroll = (studentId: string, classId: string, divisionId: string, rollNo: string) =>
  asAdmin('post', '/enrollments', { studentId, classId, divisionId, rollNo });

beforeAll(async () => {
  ctx = await startTestApp();
  const { user } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true, loginId: 'academicsadmin' });
  adminToken = tokenFor(ctx, user);
});
afterAll(async () => {
  await ctx.stop();
});

describe('structure', () => {
  it('builds the hierarchy, upper-cases codes, derives scope fields and audits', async () => {
    const dept = await asAdmin('post', '/departments', { name: 'Computer Science', code: 'cs-main' });
    expect(dept.status).toBe(201);
    expect(dept.body.code).toBe('CS-MAIN');
    expect(await AuditLog.findOne({ action: 'academics.department_created', targetId: dept.body.id })).not.toBeNull();

    const s = await structure();
    expect(s.cls.departmentId).toBe(s.dept.id);
    expect(s.cls.academicYearId).toBe(s.year.id);
    expect(s.div.departmentId).toBe(s.dept.id); // derived from the class, not sent by the client
    expect(s.div.academicYearId).toBe(s.year.id);

    const renamed = await asAdmin('patch', `/departments/${dept.body.id}`, { name: 'Computer Science & IT' });
    expect(renamed.body.name).toBe('Computer Science & IT');
  });

  it('rejects duplicates, bad codes and client-supplied scope fields', async () => {
    const d = await mkDept();
    expect((await asAdmin('post', '/departments', { name: 'Dup', code: d.code })).status).toBe(409);
    expect((await asAdmin('post', '/departments', { name: 'Bad', code: 'bad code!' })).status).toBe(400);
    expect((await asAdmin('post', '/departments', { name: 'Extra', code: uniq('X'), collegeId: oid() })).status).toBe(400);
    const y = await mkYear();
    const c = await mkClass(d.id, y.id);
    expect((await asAdmin('post', '/classes', { departmentId: d.id, academicYearId: y.id, name: 'Dup', code: c.code })).status).toBe(409);
    await mkDivision(c.id, 'A');
    expect((await asAdmin('post', '/divisions', { classId: c.id, name: 'A' })).status).toBe(409);
    expect((await asAdmin('post', '/divisions', { classId: c.id, name: 'B', departmentId: oid() })).status).toBe(400);
  });

  it('rejects a year that ends before it starts, and keeps exactly one current year', async () => {
    expect((await asAdmin('post', '/years', { label: uniq('Bad') + '-26', startDate: '2027-01-01', endDate: '2026-01-01' })).status).toBe(400);
    const y1 = await mkYear();
    const y2 = await mkYear();
    expect((await asAdmin('post', `/years/${y1.id}/set-current`)).body.isCurrent).toBe(true);
    expect((await asAdmin('post', `/years/${y2.id}/set-current`)).body.isCurrent).toBe(true);
    const list = await asAdmin('get', '/years?pageSize=100');
    const current = (list.body.items as Rec[]).filter((y) => y.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(y2.id);
  });

  it('enforces parent/child consistency and tenant isolation', async () => {
    const foreign = await Department.create({ collegeId: new Types.ObjectId(), name: 'Foreign', code: uniq('FRN') });
    const y = await mkYear();
    const d = await mkDept();
    expect((await asAdmin('post', '/classes', { departmentId: foreign.id, academicYearId: y.id, name: 'X1', code: uniq('K') })).status).toBe(400);
    expect((await asAdmin('post', '/classes', { departmentId: d.id, academicYearId: oid(), name: 'X2', code: uniq('K') })).status).toBe(400);
    expect((await asAdmin('post', '/divisions', { classId: oid(), name: 'A' })).status).toBe(400);

    const archivedDept = await mkDept();
    expect((await asAdmin('post', `/departments/${archivedDept.id}/archive`)).status).toBe(200);
    expect((await asAdmin('post', '/classes', { departmentId: archivedDept.id, academicYearId: y.id, name: 'X3', code: uniq('K') })).status).toBe(400);

    const list = await asAdmin('get', '/departments?pageSize=100&includeArchived=true');
    expect((list.body.items as Rec[]).some((x) => x.id === foreign.id)).toBe(false);
    expect((await asAdmin('post', `/departments/${foreign.id}/archive`)).status).toBe(404);
  });

  it('archives instead of deleting, blocks archiving while children are active, and hides archived by default', async () => {
    const s = await structure();
    expect((await asAdmin('post', `/departments/${s.dept.id}/archive`)).status).toBe(409);
    expect((await asAdmin('post', `/classes/${s.cls.id}/archive`)).status).toBe(409);
    expect((await asAdmin('post', `/divisions/${s.div.id}/archive`)).status).toBe(200);
    expect((await asAdmin('post', `/classes/${s.cls.id}/archive`)).status).toBe(200);
    expect((await asAdmin('post', `/subjects/${s.subject.id}/archive`)).status).toBe(200);
    expect((await asAdmin('post', `/departments/${s.dept.id}/archive`)).status).toBe(200);
    expect((await asAdmin('post', `/departments/${s.dept.id}/archive`)).status).toBe(404); // already archived

    const hidden = await asAdmin('get', '/departments?pageSize=100');
    expect((hidden.body.items as Rec[]).some((x) => x.id === s.dept.id)).toBe(false);
    const shown = await asAdmin('get', '/departments?pageSize=100&includeArchived=true');
    expect((shown.body.items as Rec[]).find((x) => x.id === s.dept.id)?.archived).toBe(true);
  });

  it('will not archive the current year, and bounds page size', async () => {
    const y = await mkYear();
    await asAdmin('post', `/years/${y.id}/set-current`);
    expect((await asAdmin('post', `/years/${y.id}/archive`)).status).toBe(409);
    expect((await asAdmin('get', '/classes?pageSize=101')).status).toBe(400);
    expect((await asAdmin('get', '/classes?departmentId[$ne]=x')).status).toBe(400);
  });
});

describe('enrollments', () => {
  it('derives department and year from the class and enforces D-14 and roll-number uniqueness', async () => {
    const s = await structure();
    const { user: student } = await makeUser(ctx, { role: 'STUDENT' });
    const res = await enroll(student.id, s.cls.id, s.div.id, '101');
    expect(res.status).toBe(201);
    expect(res.body.departmentId).toBe(s.dept.id);
    expect(res.body.academicYearId).toBe(s.year.id);
    expect(res.body.student.loginId).toBe(student.loginId);

    const withScope = await asAdmin('post', '/enrollments', { studentId: student.id, classId: s.cls.id, divisionId: s.div.id, rollNo: '9', departmentId: oid() });
    expect(withScope.status).toBe(400);

    const divB = await mkDivision(s.cls.id, 'B');
    expect((await enroll(student.id, s.cls.id, divB.id, '102')).status).toBe(409); // one per student per year

    const { user: other } = await makeUser(ctx, { role: 'STUDENT' });
    expect((await enroll(other.id, s.cls.id, s.div.id, '101')).status).toBe(409); // roll no. taken in division
    expect((await enroll(other.id, s.cls.id, s.div.id, '102')).status).toBe(201);
  });

  it('rejects non-students, pending students and divisions from another class', async () => {
    const s = await structure();
    const t = await structure();
    const { user: teacher } = await makeUser(ctx, { role: 'TEACHER' });
    const { user: pending } = await makeUser(ctx, { role: 'STUDENT', status: 'pending' });
    const { user: student } = await makeUser(ctx, { role: 'STUDENT' });
    expect((await enroll(teacher.id, s.cls.id, s.div.id, '1')).status).toBe(400);
    expect((await enroll(pending.id, s.cls.id, s.div.id, '1')).status).toBe(400);
    expect((await enroll(student.id, s.cls.id, t.div.id, '1')).status).toBe(400);
  });

  it('keeps history: a new year is a new enrollment and the old one is untouched', async () => {
    const s = await structure();
    const { user: student } = await makeUser(ctx, { role: 'STUDENT' });
    expect((await enroll(student.id, s.cls.id, s.div.id, '7')).status).toBe(201);

    const year2 = await mkYear();
    const cls2 = await mkClass(s.dept.id, year2.id);
    const div2 = await mkDivision(cls2.id);
    expect((await enroll(student.id, cls2.id, div2.id, '3')).status).toBe(201);

    const list = await asAdmin('get', `/enrollments?studentId=${student.id}`);
    expect(list.body.total).toBe(2);
    const years = (list.body.items as Rec[]).map((e) => e.academicYearId).sort();
    expect(years).toEqual([s.year.id, year2.id].sort());
  });

  it('corrects roll number or division within the class, with before/after in the audit log', async () => {
    const s = await structure();
    const divB = await mkDivision(s.cls.id, 'B');
    const other = await structure();
    const { user: student } = await makeUser(ctx, { role: 'STUDENT' });
    const created = await enroll(student.id, s.cls.id, s.div.id, '50');

    const patched = await asAdmin('patch', `/enrollments/${created.body.id}`, { rollNo: '51', divisionId: divB.id });
    expect(patched.status).toBe(200);
    expect(patched.body.rollNo).toBe('51');
    expect(patched.body.divisionId).toBe(divB.id);
    expect((await asAdmin('patch', `/enrollments/${created.body.id}`, { divisionId: other.div.id })).status).toBe(400);
    expect((await asAdmin('patch', `/enrollments/${created.body.id}`, {})).status).toBe(400);

    const audit = await AuditLog.findOne({ action: 'academics.enrollment_updated', targetId: created.body.id });
    expect((audit?.summary?.before as { rollNo: string }).rollNo).toBe('50');
    expect((audit?.summary?.after as { rollNo: string }).rollNo).toBe('51');
  });
});

describe('teaching assignments and staff departments', () => {
  it('links staff to a department, audits it, and rejects students and archived departments', async () => {
    const d = await mkDept();
    const { user: teacher } = await makeUser(ctx, { role: 'TEACHER' });
    const { user: student } = await makeUser(ctx, { role: 'STUDENT' });
    const set = await asAdmin('patch', `/staff/${teacher.id}/department`, { departmentId: d.id });
    expect(set.status).toBe(200);
    expect(set.body.user.departmentId).toBe(d.id);
    expect(await AuditLog.findOne({ action: 'academics.staff_department_set', targetId: teacher.id })).not.toBeNull();
    expect((await asAdmin('patch', `/staff/${student.id}/department`, { departmentId: d.id })).status).toBe(404);
    expect((await asAdmin('patch', `/staff/${teacher.id}/department`, { departmentId: null })).body.user.departmentId).toBeNull();
    const gone = await mkDept();
    await asAdmin('post', `/departments/${gone.id}/archive`);
    expect((await asAdmin('patch', `/staff/${teacher.id}/department`, { departmentId: gone.id })).status).toBe(400);
  });

  it('validates teacher, subject and class consistency; revoke allows re-assignment; teachers see only their own', async () => {
    const s = await structure();
    const other = await structure();
    const { user: teacher } = await makeUser(ctx, { role: 'TEACHER', departmentId: new Types.ObjectId(s.dept.id) });
    const { user: noDept } = await makeUser(ctx, { role: 'TEACHER' });
    const { user: wrongDept } = await makeUser(ctx, { role: 'TEACHER', departmentId: new Types.ObjectId(other.dept.id) });
    const body = { teacherId: teacher.id, subjectId: s.subject.id, classId: s.cls.id, divisionId: s.div.id };
    const post = (b: object) => asAdmin('post', '/teaching-assignments', b);

    expect((await post({ ...body, teacherId: noDept.id })).status).toBe(400);
    expect((await post({ ...body, teacherId: wrongDept.id })).status).toBe(400);
    expect((await post({ ...body, subjectId: other.subject.id })).status).toBe(400);
    expect((await post({ ...body, divisionId: other.div.id })).status).toBe(400);

    const created = await post(body);
    expect(created.status).toBe(201);
    expect(created.body.subject.code).toBe(s.subject.code);
    expect(created.body.teacher.loginId).toBe(teacher.loginId);
    expect((await post(body)).status).toBe(409);

    // Cannot archive a subject or division that has an active assignment.
    expect((await asAdmin('post', `/subjects/${s.subject.id}/archive`)).status).toBe(409);
    expect((await asAdmin('post', `/divisions/${s.div.id}/archive`)).status).toBe(409);

    const mine = await call('get', '/teaching-assignments/mine', tokenFor(ctx, teacher));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    const others = await call('get', '/teaching-assignments/mine', tokenFor(ctx, noDept));
    expect(others.body.items).toHaveLength(0);

    expect((await asAdmin('post', `/teaching-assignments/${created.body.id}/revoke`)).status).toBe(200);
    expect((await asAdmin('post', `/teaching-assignments/${created.body.id}/revoke`)).status).toBe(404);
    expect((await call('get', '/teaching-assignments/mine', tokenFor(ctx, teacher))).body.items).toHaveLength(0);
    expect((await post(body)).status).toBe(201); // history kept, new active assignment allowed
  });
});

describe('HOD read scope', () => {
  it('sees only their own department everywhere and cannot write', async () => {
    const a = await structure();
    const b = await structure();
    const { user: sa } = await makeUser(ctx, { role: 'STUDENT' });
    const { user: sb } = await makeUser(ctx, { role: 'STUDENT' });
    await enroll(sa.id, a.cls.id, a.div.id, '1');
    await enroll(sb.id, b.cls.id, b.div.id, '1');
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: new Types.ObjectId(a.dept.id) });
    const t = tokenFor(ctx, hod);

    const depts = await call('get', '/departments?pageSize=100', t);
    expect((depts.body.items as Rec[]).map((d) => d.id)).toEqual([a.dept.id]);

    // Asking for another department is ignored: the HOD's own scope always wins.
    const classes = await call('get', `/classes?pageSize=100&departmentId=${b.dept.id}`, t);
    const classItems = classes.body.items as Rec[];
    expect(classItems.length).toBeGreaterThan(0);
    expect(classItems.every((c) => c.departmentId === a.dept.id)).toBe(true);

    for (const path of ['/divisions', '/subjects', '/enrollments', '/teaching-assignments']) {
      const r = await call('get', `${path}?pageSize=100`, t);
      expect(r.status).toBe(200);
      expect((r.body.items as Rec[]).every((x) => x.departmentId === a.dept.id), path).toBe(true);
    }
    const enr = await call('get', '/enrollments?pageSize=100', t);
    expect((enr.body.items as Rec[]).some((e) => e.classId === b.cls.id)).toBe(false);

    expect((await call('post', '/departments', t, { name: 'Nope', code: uniq('N') })).status).toBe(403);
    expect((await call('post', '/enrollments', t, {})).status).toBe(403);
  });

  it('a HOD with no department assigned gets 403, not everything', async () => {
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true });
    expect((await call('get', '/classes', tokenFor(ctx, hod))).status).toBe(403);
    expect((await call('get', '/departments', tokenFor(ctx, hod))).status).toBe(403);
  });
});

describe('permission matrix: academics', () => {
  const ZERO = '0'.repeat(24);
  interface Endpoint { method: Method; path: string; body?: object; allowed: Role[] }
  const readers: Role[] = ['SUPER_ADMIN', 'HOD'];
  const writers: Role[] = ['SUPER_ADMIN'];
  const archivable = ['departments', 'years', 'classes', 'divisions', 'subjects'];
  const ENDPOINTS: Endpoint[] = [
    ...['departments', 'years', 'classes', 'divisions', 'subjects', 'enrollments', 'teaching-assignments'].map(
      (p): Endpoint => ({ method: 'get', path: `/${p}`, allowed: readers }),
    ),
    { method: 'get', path: '/teaching-assignments/mine', allowed: ['TEACHER'] },
    { method: 'post', path: '/departments', body: { name: 'Matrix Dept', code: 'MATRIXD' }, allowed: writers },
    { method: 'post', path: '/years', body: { label: 'MX-2026', startDate: '2026-06-01', endDate: '2027-05-31' }, allowed: writers },
    { method: 'post', path: '/classes', body: { departmentId: ZERO, academicYearId: ZERO, name: 'Cl', code: 'CL' }, allowed: writers },
    { method: 'post', path: '/divisions', body: { classId: ZERO, name: 'A' }, allowed: writers },
    { method: 'post', path: '/subjects', body: { departmentId: ZERO, name: 'Su', code: 'SU' }, allowed: writers },
    { method: 'post', path: '/enrollments', body: { studentId: ZERO, classId: ZERO, divisionId: ZERO, rollNo: '1' }, allowed: writers },
    { method: 'post', path: '/teaching-assignments', body: { teacherId: ZERO, subjectId: ZERO, classId: ZERO, divisionId: ZERO }, allowed: writers },
    { method: 'post', path: `/teaching-assignments/${ZERO}/revoke`, allowed: writers },
    { method: 'post', path: `/years/${ZERO}/set-current`, allowed: writers },
    { method: 'patch', path: `/departments/${ZERO}`, body: { name: 'Renamed' }, allowed: writers },
    { method: 'patch', path: `/years/${ZERO}`, body: { startDate: '2026-06-01', endDate: '2027-05-31' }, allowed: writers },
    { method: 'patch', path: `/classes/${ZERO}`, body: { name: 'Renamed' }, allowed: writers },
    { method: 'patch', path: `/divisions/${ZERO}`, body: { name: 'B' }, allowed: writers },
    { method: 'patch', path: `/subjects/${ZERO}`, body: { name: 'Renamed' }, allowed: writers },
    { method: 'patch', path: `/enrollments/${ZERO}`, body: { rollNo: '2' }, allowed: writers },
    { method: 'patch', path: `/staff/${ZERO}/department`, body: { departmentId: null }, allowed: writers },
    ...archivable.map((p): Endpoint => ({ method: 'post', path: `/${p}/${ZERO}/archive`, allowed: writers })),
  ];

  let matrixDept: Rec;
  beforeAll(async () => {
    matrixDept = await mkDept();
  });

  for (const ep of ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} ${ep.path.replace(ZERO, ':id')}`, () => {
      it('401 without a token', async () => {
        const res = await request(ctx.app)[ep.method](`/api/v1/academics${ep.path}`).send(ep.body);
        expect(res.status).toBe(401);
      });
      for (const role of ROLES) {
        const allowed = ep.allowed.includes(role);
        it(`${role}: ${allowed ? 'allowed' : '403'}`, async () => {
          const { user } = await makeUser(ctx, {
            role,
            twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD',
            ...(role === 'HOD' ? { departmentId: new Types.ObjectId(matrixDept.id) } : {}),
          });
          const res = await call(ep.method, ep.path, tokenFor(ctx, user), ep.body);
          if (allowed) expect([401, 403]).not.toContain(res.status);
          else expect(res.status).toBe(403);
        });
      }
    });
  }
});
