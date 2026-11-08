import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/common/csv';
import { createLogger } from '../src/common/logger';
import { deriveKey, encryptSecret } from '../src/common/crypto';
import { AcademicYear, Department, Division, Enrollment, SchoolClass } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { ImportWorker } from '../src/modules/imports/import.worker';
import { ROLES, User } from '../src/modules/users/user.model';
import { bearer, CSRF, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let adminToken: string;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;
const newLogin = () => `std${++n}`;

const BASE = '/api/v1/imports';
const HEADER = 'loginId,name,rollNo,departmentCode,classCode,divisionName';
const csvOf = (rows: string[][]) => [HEADER, ...rows.map((r) => r.join(','))].join('\n');

type S = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const collegeId = ctx.collegeId;
  const dept = await Department.create({ collegeId, name: 'Computer Science', code: uniq('CS') });
  const year = await AcademicYear.create({ collegeId, label: uniq('AY'), startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31'), isCurrent: false });
  const cls = await SchoolClass.create({ collegeId, departmentId: dept._id, academicYearId: year._id, name: 'First Year', code: uniq('FY') });
  const divA = await Division.create({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: 'A' });
  const divB = await Division.create({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: 'B' });
  return { dept, year, cls, divA, divB };
}
const row = (s: S, loginId: string, name: string, roll: string, div = 'A') => [loginId, name, roll, s.dept.code, s.cls.code, div];

const upload = (csv: string, query = '', token = adminToken) =>
  request(ctx.app).post(`${BASE}/students${query}`).set(bearer(token)).set('Content-Type', 'text/csv').send(csv);
const jobCall = (method: 'get' | 'post', id: string, suffix = '', body?: object) =>
  request(ctx.app)[method](`${BASE}/${id}${suffix}`).set(bearer(adminToken)).send(body);
const worker = () => ctx.modules.importWorker;

async function uploadOk(s: S, rows: string[][]): Promise<string> {
  const res = await upload(csvOf(rows), `?academicYearId=${s.year.id}`);
  expect(res.status).toBe(201);
  return res.body.job.id as string;
}
async function runImport(id: string) {
  expect((await jobCall('post', id, '/confirm', { skipInvalid: true })).status).toBe(200);
  await worker().drain();
  return (await jobCall('get', id)).body;
}
const exportCreds = (id: string) => request(ctx.app).post(`${BASE}/${id}/credentials/export`).set(bearer(adminToken));
const loginReq = (loginId: string, password: string) => request(ctx.app).post('/api/v1/auth/login').set(CSRF).send({ loginId, password });

beforeAll(async () => {
  ctx = await startTestApp();
  const { user } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true, loginId: 'importadmin' });
  adminToken = tokenFor(ctx, user);
});
afterAll(async () => {
  await ctx.stop();
});

describe('student import: happy path', () => {
  it('validates without touching data, imports in the background, and hands out passwords exactly once', async () => {
    const s = await setup();
    const [l1, l2, l3] = [newLogin(), newLogin(), newLogin()];
    const evilName = "=cmd|'/C calc'!A0";
    const res = await upload(csvOf([row(s, l1, 'Asha Patil', '101'), row(s, l2, evilName, '102'), row(s, l3, 'Ravi Kulkarni', '1', 'B')]), `?academicYearId=${s.year.id}&fileName=roster.csv`);
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('validated');
    expect(res.body.job.counts).toMatchObject({ total: 3, ready: 3, invalid: 0 });
    expect(res.body.problems).toEqual([]);
    const id: string = res.body.job.id;

    // Preview (validation) creates nothing.
    expect(await User.countDocuments({ loginId: { $in: [l1, l2, l3] } })).toBe(0);

    expect((await jobCall('post', id, '/confirm')).body.status).toBe('queued');
    await worker().drain();

    const job = (await jobCall('get', id)).body;
    expect(job.status).toBe('completed');
    expect(job.counts).toMatchObject({ total: 3, done: 3, failed: 0 });
    expect(job.credentialsAvailable).toBe(true);

    const users = await User.find({ loginId: { $in: [l1, l2, l3] } });
    expect(users).toHaveLength(3);
    expect(users.every((u) => u.role === 'STUDENT' && u.status === 'active' && u.mustChangePassword)).toBe(true);
    const enrollments = await Enrollment.find({ studentId: { $in: users.map((u) => u._id) } });
    expect(enrollments).toHaveLength(3);
    expect(enrollments.every((e) => e.departmentId.equals(s.dept._id) && e.academicYearId.equals(s.year._id) && e.classId.equals(s.cls._id))).toBe(true);

    // One-time credentials: formula-neutralized, usable, then gone.
    const exp = await exportCreds(id);
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.headers['cache-control']).toBe('no-store');
    const [header, ...rows] = parseCsv(exp.text, { maxRows: 100 });
    expect(header?.[6]).toBe('temporaryPassword');
    expect(rows).toHaveLength(3);
    const evilRow = rows.find((r) => r[0] === l2);
    expect(evilRow?.[1]).toBe(`'${evilName}`);
    const first = rows.find((r) => r[0] === l1);
    expect(first?.[6]).toHaveLength(12);
    const lg = await loginReq(l1, first?.[6] ?? '');
    expect(lg.status).toBe(200);
    expect(lg.body.pendingActions).toEqual(['change_password']);

    const again = await exportCreds(id);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('CREDENTIALS_ALREADY_EXPORTED');
    const stored = await ImportRow.find({ jobId: id }).select('+tempPasswordEnc');
    expect(stored.every((r) => r.tempPasswordEnc === undefined)).toBe(true);

    for (const action of ['import.validated', 'import.confirmed', 'import.completed', 'import.credentials_exported']) {
      expect(await AuditLog.findOne({ action, targetId: id }), action).not.toBeNull();
    }
    expect(JSON.stringify(await AuditLog.find({ targetId: id }).lean())).not.toContain(first?.[6] ?? 'x');
  });

  it('accepts friendly headers, a BOM, CRLF and quoted names with commas', async () => {
    const s = await setup();
    const l = newLogin();
    const csv = `\uFEFFLogin ID, Name ,Roll No,Department Code,Class Code,Division Name\r\n${l},"Patil, Asha",7,${s.dept.code.toLowerCase()},${s.cls.code.toLowerCase()},A\r\n`;
    const res = await upload(csv, `?academicYearId=${s.year.id}`);
    expect(res.status).toBe(201);
    expect(res.body.job.counts).toMatchObject({ total: 1, ready: 1, invalid: 0 });
    expect(res.body.sample[0].name).toBe('Patil, Asha');
  });

  it('imports 1,000 students in one run (guide Phase 5 gate)', async () => {
    const s = await setup();
    const rows = Array.from({ length: 1000 }, (_, i) => row(s, `bulk${String(i + 1).padStart(4, '0')}`, `Student ${i + 1}`, String(i + 1)));
    const id = await uploadOk(s, rows);
    const job = await runImport(id);
    expect(job.status).toBe('completed');
    expect(job.counts).toMatchObject({ total: 1000, done: 1000, failed: 0 });
    expect(await User.countDocuments({ loginId: /^bulk\d{4}$/ })).toBe(1000);
    expect(await Enrollment.countDocuments({ divisionId: s.divA._id })).toBe(1000);
    const exp = await exportCreds(id);
    const parsed = parseCsv(exp.text, { maxRows: 5000 });
    expect(parsed).toHaveLength(1001);
    expect(new Set(parsed.slice(1).map((r) => r[6])).size).toBe(1000);
  }, 180_000);
});

describe('student import: validation', () => {
  it('flags every kind of bad row individually and imports only the valid ones when told to', async () => {
    const s = await setup();
    const { user: teacher } = await makeUser(ctx, { role: 'TEACHER' });
    const { user: enrolled } = await makeUser(ctx, { role: 'STUDENT' });
    const { user: other } = await makeUser(ctx, { role: 'STUDENT' });
    const base = { collegeId: ctx.collegeId, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: s.divA._id };
    await Enrollment.create({ ...base, studentId: enrolled._id, rollNo: '900' });
    await Enrollment.create({ ...base, studentId: other._id, rollNo: '55' });

    const [ok1, ok2, ok3] = [newLogin(), newLogin(), newLogin()];
    const res = await upload(
      csvOf([
        row(s, ok1, 'Valid One', '1'), //                          line 2: valid
        row(s, ok1, 'Dup Login', '2'), //                          line 3
        row(s, 'Bad Id!', 'Bad Login', '3'), //                    line 4
        [newLogin(), 'No Dept', '4', 'ZZZ', s.cls.code, 'A'], //   line 5
        [newLogin(), 'No Class', '5', s.dept.code, 'NOPE', 'A'], //line 6
        row(s, newLogin(), 'No Division', '6', 'Z'), //            line 7
        row(s, ok2, 'Dup Roll', '1'), //                           line 8
        row(s, teacher.loginId, 'A Teacher', '7'), //              line 9
        row(s, enrolled.loginId, 'Already In', '8'), //            line 10
        row(s, ok3, 'Roll Taken', '55'), //                        line 11
      ]),
      `?academicYearId=${s.year.id}`,
    );
    expect(res.status).toBe(201);
    expect(res.body.job.counts).toMatchObject({ total: 10, ready: 1, invalid: 9 });
    const msg = (line: number) => (res.body.problems as Array<{ line: number; errors: string[] }>).find((p) => p.line === line)?.errors.join(' | ') ?? '';
    expect(msg(3)).toMatch(/duplicate of line 2/);
    expect(msg(4)).toMatch(/loginId/);
    expect(msg(5)).toMatch(/unknown department/);
    expect(msg(6)).toMatch(/unknown class/);
    expect(msg(7)).toMatch(/unknown division/);
    expect(msg(8)).toMatch(/duplicate of line 2 in the same division/);
    expect(msg(9)).toMatch(/non-student/);
    expect(msg(10)).toMatch(/already enrolled/);
    expect(msg(11)).toMatch(/already used/);

    const id: string = res.body.job.id;
    const refuse = await jobCall('post', id, '/confirm');
    expect(refuse.status).toBe(409);
    expect(refuse.body.error.message).toMatch(/9 row/);

    const job = await runImport(id); // confirms with skipInvalid: true
    expect(job.status).toBe('completed');
    expect(job.counts).toMatchObject({ total: 10, done: 1, invalid: 9 });
    expect(await User.countDocuments({ loginId: ok1 })).toBe(1);
    expect(await User.countDocuments({ loginId: { $in: [ok2, ok3] } })).toBe(0);

    const invalidRows = await jobCall('get', id, '/rows?status=invalid');
    expect(invalidRows.body.total).toBe(9);
  });

  it('rejects unknown columns (privacy minimisation), missing columns and malformed files', async () => {
    const s = await setup();
    const withDob = await upload(`${HEADER},dob\n${newLogin()},Name Here,1,${s.dept.code},${s.cls.code},A,2001-01-01`, `?academicYearId=${s.year.id}`);
    expect(withDob.status).toBe(400);
    expect(JSON.stringify(withDob.body.error.details)).toMatch(/Unknown column.*dob/);

    const missing = await upload('loginId,name\nabc,Name Here', `?academicYearId=${s.year.id}`);
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body.error.details)).toMatch(/Missing required column/);

    expect((await upload('', `?academicYearId=${s.year.id}`)).status).toBe(400);
    const headerOnly = await upload(HEADER, `?academicYearId=${s.year.id}`);
    expect(headerOnly.status).toBe(400);
    expect(JSON.stringify(headerOnly.body.error.details)).toMatch(/no data rows/);
    const quote = await upload(`${HEADER}\nabc,"Name,1,CS,FY,A`, `?academicYearId=${s.year.id}`);
    expect(quote.status).toBe(400);
    expect(JSON.stringify(quote.body.error.details)).toMatch(/Unterminated/);

    const json = await request(ctx.app).post(`${BASE}/students`).set(bearer(adminToken)).set('Content-Type', 'application/json').send({ a: 1 });
    expect(json.status).toBe(400);
  });

  it('uses the current academic year by default and fails clearly when there is none', async () => {
    const s = await setup();
    const csv = csvOf([row(s, newLogin(), 'Default Year', '1')]);
    await AcademicYear.updateMany({ collegeId: ctx.collegeId }, { $set: { isCurrent: false } });
    const none = await upload(csv);
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body.error.details)).toMatch(/no current academic year/);

    await AcademicYear.updateOne({ _id: s.year._id }, { $set: { isCurrent: true } });
    const ok = await upload(csv);
    expect(ok.status).toBe(201);
    expect(ok.body.job.academicYearId).toBe(s.year.id);
    await AcademicYear.updateOne({ _id: s.year._id }, { $set: { isCurrent: false } });
  });

  it('serves a template with exactly the accepted columns', async () => {
    const res = await request(ctx.app).get(`${BASE}/students/template`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.text.split('\r\n')[0]).toBe(HEADER);
  });
});

describe('student import: existing students and history', () => {
  it('enrolls an existing student in a new year without touching their account or password', async () => {
    const s1 = await setup();
    const s2 = await setup();
    const { user: student, password } = await makeUser(ctx, { role: 'STUDENT', loginId: `old${++n}` });
    await Enrollment.create({ collegeId: ctx.collegeId, studentId: student._id, academicYearId: s1.year._id, departmentId: s1.dept._id, classId: s1.cls._id, divisionId: s1.divA._id, rollNo: '5' });

    const rows = [row(s2, student.loginId, 'Old Student', '5')];
    const res = await upload(csvOf(rows), `?academicYearId=${s2.year.id}`);
    expect(res.body.job.counts).toMatchObject({ ready: 1, invalid: 0 });
    expect(res.body.sample[0].action).toBe('enroll_existing');

    const job = await runImport(res.body.job.id);
    expect(job.status).toBe('completed');
    expect(job.credentialsAvailable).toBe(false); // no new password was created
    const exp = await exportCreds(res.body.job.id);
    expect(exp.status).toBe(410);
    expect(exp.body.error.code).toBe('CREDENTIALS_UNAVAILABLE');

    expect((await loginReq(student.loginId, password)).body.pendingActions).toEqual([]); // password unchanged
    expect(await Enrollment.countDocuments({ studentId: student._id })).toBe(2); // history kept

    const repeat = await upload(csvOf(rows), `?academicYearId=${s2.year.id}`);
    expect(repeat.body.job.counts).toMatchObject({ ready: 0, invalid: 1 });
  });
});

describe('student import: reliability', () => {
  it('retries failed rows without creating duplicates, and the retried password is still downloadable', async () => {
    const s = await setup();
    const [l1, l2] = [newLogin(), newLogin()];
    const id = await uploadOk(s, [row(s, l1, 'First Student', '101'), row(s, l2, 'Second Student', '102')]);
    expect((await jobCall('post', id, '/confirm')).status).toBe(200);

    // After validation, someone else takes roll number 102.
    const { user: intruder } = await makeUser(ctx, { role: 'STUDENT' });
    const conflict = await Enrollment.create({ collegeId: ctx.collegeId, studentId: intruder._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: s.divA._id, rollNo: '102' });

    await worker().drain();
    let job = (await jobCall('get', id)).body;
    expect(job.status).toBe('completed_with_errors');
    expect(job.counts).toMatchObject({ done: 1, failed: 1 });
    const failed = await jobCall('get', id, '/rows?status=failed');
    expect(failed.body.items[0].message).toMatch(/enrollment conflict/);

    await Enrollment.deleteOne({ _id: conflict._id });
    expect((await jobCall('post', id, '/retry')).body.status).toBe('queued');
    await worker().drain();
    await worker().drain(); // running again must change nothing

    job = (await jobCall('get', id)).body;
    expect(job.status).toBe('completed');
    expect(job.counts).toMatchObject({ done: 2, failed: 0 });
    expect(await User.countDocuments({ loginId: { $in: [l1, l2] } })).toBe(2);
    const users = await User.find({ loginId: { $in: [l1, l2] } });
    expect(await Enrollment.countDocuments({ studentId: { $in: users.map((u) => u._id) } })).toBe(2);

    const exp = await exportCreds(id);
    expect(exp.status).toBe(200);
    expect(parseCsv(exp.text, { maxRows: 10 })).toHaveLength(3);
  });

  it('survives a crash after the user was created but before the row was marked done', async () => {
    const s = await setup();
    const l = newLogin();
    const id = await uploadOk(s, [row(s, l, 'Crash Test', '1')]);
    expect((await jobCall('post', id, '/confirm')).status).toBe(200);

    // Simulate the crash window: id + encrypted password persisted, user already created.
    const stored = await ImportRow.findOne({ jobId: id, line: 2 });
    if (!stored) throw new Error('row missing');
    const userId = new Types.ObjectId();
    const preset = 'Preset-Pass-77';
    const key = deriveKey(ctx.cfg.twoFactorEncryptionKey, 'import-credentials-v1');
    await ImportRow.updateOne({ _id: stored._id }, { $set: { userId, tempPasswordEnc: encryptSecret(preset, key) } });
    await User.create({ _id: userId, collegeId: ctx.collegeId, name: stored.name, loginId: l, passwordHash: await ctx.modules.passwords.hash(preset), role: 'STUDENT', status: 'active', mustChangePassword: true });

    await worker().drain();
    expect((await jobCall('get', id)).body.status).toBe('completed');
    expect(await User.countDocuments({ loginId: l })).toBe(1);
    const exp = await exportCreds(id);
    expect(parseCsv(exp.text, { maxRows: 10 })[1]?.[6]).toBe(preset);
    expect((await loginReq(l, preset)).status).toBe(200);
  });

  it('does not steal a live lease, resumes after it expires, and gives up after too many attempts', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Lease One', '1'), row(s, newLogin(), 'Lease Two', '2'), row(s, newLogin(), 'Lease Three', '3')]);
    expect((await jobCall('post', id, '/confirm')).status).toBe(200);

    await ImportJob.updateOne({ _id: id }, { $set: { status: 'running', leaseUntil: new Date(Date.now() + 60_000) } });
    await worker().drain();
    expect((await jobCall('get', id)).body).toMatchObject({ status: 'running', counts: { done: 0 } });

    await ImportJob.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
    await worker().drain();
    expect((await jobCall('get', id)).body).toMatchObject({ status: 'completed', counts: { done: 3 } });

    const s2 = await setup();
    const id2 = await uploadOk(s2, [row(s2, newLogin(), 'Stuck', '1')]);
    expect((await jobCall('post', id2, '/confirm')).status).toBe(200);
    await ImportJob.updateOne({ _id: id2 }, { $set: { attempts: 99 } });
    await worker().drain();
    expect((await jobCall('get', id2)).body.status).toBe('failed');
    expect((await jobCall('post', id2, '/retry')).body.status).toBe('queued'); // resets attempts
    await worker().drain();
    expect((await jobCall('get', id2)).body.status).toBe('completed');
  });
});

describe('student import: credentials and lifecycle', () => {
  it('purges passwords nobody downloaded in time', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Expiring', '1')]);
    expect((await runImport(id)).credentialsAvailable).toBe(true);

    await ImportJob.updateOne({ _id: id }, { $set: { credentialsExpiresAt: new Date(Date.now() - 1000) } });
    expect(await ctx.modules.imports.purgeExpiredCredentials()).toBe(1);
    const stored = await ImportRow.find({ jobId: id }).select('+tempPasswordEnc');
    expect(stored.every((r) => r.tempPasswordEnc === undefined)).toBe(true);
    expect((await jobCall('get', id)).body).toMatchObject({ credentialsPurged: true, credentialsAvailable: false });
    expect((await exportCreds(id)).status).toBe(410);
    expect(await AuditLog.findOne({ action: 'import.credentials_expired', targetId: id })).not.toBeNull();
  });

  it('lets exactly one of two simultaneous downloads succeed', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Race One', '1'), row(s, newLogin(), 'Race Two', '2')]);
    await runImport(id);
    const results = await Promise.all([exportCreds(id), exportCreds(id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it('cancels only validated or queued imports', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Cancel Me', '1')]);
    expect((await jobCall('post', id, '/cancel')).body.status).toBe('cancelled');
    expect((await jobCall('post', id, '/confirm')).status).toBe(409);
    expect((await jobCall('post', id, '/cancel')).status).toBe(409);
    await worker().drain();
    expect((await jobCall('get', id)).body.counts.done).toBe(0);
  });

  it("cannot see, confirm or export another college's imports", async () => {
    const foreign = await ImportJob.create({
      collegeId: new Types.ObjectId(),
      type: 'students',
      uploadedBy: new Types.ObjectId(),
      academicYearId: new Types.ObjectId(),
      status: 'completed',
      counts: { total: 0, ready: 0, invalid: 0, done: 0, failed: 0 },
    });
    for (const [method, suffix] of [['get', ''], ['get', '/rows'], ['post', '/confirm'], ['post', '/retry'], ['post', '/cancel'], ['post', '/credentials/export']] as const) {
      expect((await jobCall(method, foreign.id, suffix)).status, `${method} ${suffix}`).toBe(404);
    }
    const list = await request(ctx.app).get(BASE).set(bearer(adminToken));
    expect((list.body.items as Array<{ id: string }>).some((j) => j.id === foreign.id)).toBe(false);
  });
});

describe('permission matrix: imports', () => {
  const ZERO = '0'.repeat(24);
  const endpoints: Array<{ method: 'get' | 'post'; path: string }> = [
    { method: 'get', path: BASE },
    { method: 'get', path: `${BASE}/students/template` },
    { method: 'get', path: `${BASE}/${ZERO}` },
    { method: 'get', path: `${BASE}/${ZERO}/rows` },
    { method: 'post', path: `${BASE}/${ZERO}/confirm` },
    { method: 'post', path: `${BASE}/${ZERO}/retry` },
    { method: 'post', path: `${BASE}/${ZERO}/cancel` },
    { method: 'post', path: `${BASE}/${ZERO}/credentials/export` },
    { method: 'post', path: `${BASE}/credentials/reissue` },
  ];

  for (const ep of endpoints) {
    describe(`${ep.method.toUpperCase()} ${ep.path.replace(ZERO, ':id').replace('/api/v1', '')}`, () => {
      it('401 without a token', async () => {
        expect((await request(ctx.app)[ep.method](ep.path)).status).toBe(401);
      });
      for (const role of ROLES) {
        it(`${role}: ${role === 'SUPER_ADMIN' ? 'allowed' : '403'}`, async () => {
          const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD' });
          const res = await request(ctx.app)[ep.method](ep.path).set(bearer(tokenFor(ctx, user)));
          if (role === 'SUPER_ADMIN') expect([401, 403]).not.toContain(res.status);
          else expect(res.status).toBe(403);
        });
      }
    });
  }

  describe('POST /imports/students', () => {
    it('401 without a token', async () => {
      expect((await request(ctx.app).post(`${BASE}/students`).set('Content-Type', 'text/csv').send(HEADER)).status).toBe(401);
    });
    for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      it(`${role}: 403`, async () => {
        const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'HOD' });
        expect((await upload(HEADER, '', tokenFor(ctx, user))).status).toBe(403);
      });
    }
  });
});

const reissue = (body: object, token = adminToken) => request(ctx.app).post(`${BASE}/credentials/reissue`).set(bearer(token)).send(body);

describe('bulk password reissue', () => {
  it('replaces a lost credentials file: old passwords and sessions die, new ones download once', async () => {
    const s = await setup();
    const [l1, l2] = [newLogin(), newLogin()];
    const id = await uploadOk(s, [row(s, l1, 'Lost One', '1'), row(s, l2, 'Lost Two', '2')]);
    await runImport(id);
    const first = parseCsv((await exportCreds(id)).text, { maxRows: 10 });
    const oldPw = first.find((r) => r[0] === l1)?.[6] ?? '';
    const oldLogin = await loginReq(l1, oldPw);
    expect(oldLogin.status).toBe(200);
    const oldToken: string = oldLogin.body.accessToken;
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(oldToken))).status).toBe(200);
    expect((await exportCreds(id)).status).toBe(410); // the file is "lost": it cannot be downloaded again

    const res = await reissue({ importJobId: id, reason: 'Credentials file lost' });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ type: 'credential_reissue', status: 'validated', reason: 'Credentials file lost', selector: { kind: 'import', ref: id } });
    expect(res.body.job.counts).toMatchObject({ total: 2, ready: 2, invalid: 0 });
    expect((await loginReq(l1, oldPw)).status).toBe(200); // the preview changes nothing

    const rid: string = res.body.job.id;
    const done = await runImport(rid);
    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ done: 2, failed: 0 });

    expect((await loginReq(l1, oldPw)).status).toBe(401); // old password is dead
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(oldToken))).status).toBe(401); // old session too
    const fresh = parseCsv((await exportCreds(rid)).text, { maxRows: 10 });
    expect(fresh).toHaveLength(3);
    const newPw = fresh.find((r) => r[0] === l1)?.[6] ?? '';
    expect(newPw).not.toBe(oldPw);
    const lg = await loginReq(l1, newPw);
    expect(lg.status).toBe(200);
    expect(lg.body.pendingActions).toEqual(['change_password']);
    expect((await exportCreds(rid)).status).toBe(410); // one-time again

    const audit = await AuditLog.findOne({ action: 'credentials.reissue_validated', targetId: rid });
    expect(audit?.summary?.reason).toBe('Credentials file lost');
    expect(JSON.stringify(await AuditLog.find({ targetId: rid }).lean())).not.toContain(newPw);
  });

  it('reissues for a whole division or class and flags accounts that cannot be reset', async () => {
    const s = await setup();
    const enrollIn = async (div: typeof s.divA, roll: string, status?: 'inactive') => {
      const { user } = await makeUser(ctx, { role: 'STUDENT', status });
      await Enrollment.create({ collegeId: ctx.collegeId, studentId: user._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: div._id, rollNo: roll });
      return user;
    };
    await enrollIn(s.divA, '1');
    await enrollIn(s.divA, '2');
    await enrollIn(s.divA, '3', 'inactive');
    await enrollIn(s.divB, '1'); // other division: only picked up by a class-wide reissue

    const res = await reissue({ divisionId: s.divA.id, reason: 'Start of term' });
    expect(res.status).toBe(201);
    expect(res.body.job.selector).toMatchObject({ kind: 'division', ref: s.divA.id });
    expect(res.body.job.counts).toMatchObject({ total: 3, ready: 2, invalid: 1 });
    expect(res.body.problems[0].errors.join()).toMatch(/not active/);

    const rid: string = res.body.job.id;
    expect((await jobCall('post', rid, '/confirm')).status).toBe(409); // an invalid row needs skipInvalid
    expect((await runImport(rid)).counts).toMatchObject({ done: 2, invalid: 1 });
    const rows = parseCsv((await exportCreds(rid)).text, { maxRows: 10 });
    expect(rows).toHaveLength(3);
    expect(rows[1]?.slice(3, 6)).toEqual([s.dept.code, s.cls.code, 'A']); // the sheet says who each password is for

    const byClass = await reissue({ classId: s.cls.id, reason: 'Whole class' });
    expect(byClass.body.job.selector.kind).toBe('class');
    expect(byClass.body.job.counts.total).toBe(4);
  });

  it('accepts login IDs, de-duplicates them, and reports unknown or non-student accounts', async () => {
    const { user: stu } = await makeUser(ctx, { role: 'STUDENT' });
    const { user: teacher } = await makeUser(ctx, { role: 'TEACHER' });
    const res = await reissue({ loginIds: [stu.loginId.toUpperCase(), teacher.loginId, 'nobody-here', stu.loginId], reason: 'Specific students' });
    expect(res.status).toBe(201);
    expect(res.body.job.counts).toMatchObject({ total: 3, ready: 1, invalid: 2 });
    const msgs = (res.body.problems as Array<{ errors: string[] }>).map((p) => p.errors.join(' '));
    expect(msgs.some((m) => /not a student/.test(m))).toBe(true);
    expect(msgs.some((m) => /no such account/.test(m))).toBe(true);
  });

  it('validates the request: exactly one selector, a reason, real ids, no injection, own college only', async () => {
    const foreign = await ImportJob.create({
      collegeId: new Types.ObjectId(),
      type: 'students',
      uploadedBy: new Types.ObjectId(),
      academicYearId: new Types.ObjectId(),
      status: 'completed',
      counts: { total: 0, ready: 0, invalid: 0, done: 0, failed: 0 },
    });
    const oid = () => new Types.ObjectId().toString();
    for (const body of [
      { reason: 'no selector given' },
      { loginIds: ['abc'], classId: oid(), reason: 'two selectors' },
      { loginIds: ['abcdef'] },
      { loginIds: ['abcdef'], reason: 'ab' },
      { importJobId: oid(), reason: 'unknown import' },
      { importJobId: foreign.id, reason: 'another college' },
      { divisionId: oid(), reason: 'unknown division' },
      { classId: oid(), reason: 'unknown class' },
      { loginIds: [{ $ne: 'x' }], reason: 'operator injection' },
      { loginIds: [], reason: 'empty list' },
      { loginIds: ['abcdef'], reason: 'extra field', role: 'SUPER_ADMIN' },
    ]) {
      expect((await reissue(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('background worker controls', () => {
  it('holds all processing while paused and resumes afterwards without dropping the job', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Pause Test', '1')]);
    expect((await jobCall('post', id, '/confirm')).status).toBe(200);
    let paused = true;
    const w = new ImportWorker({
      audit: ctx.modules.audit,
      passwords: ctx.modules.passwords,
      imports: ctx.modules.imports,
      credentialKey: deriveKey(ctx.cfg.twoFactorEncryptionKey, 'import-credentials-v1'),
      logger: createLogger('silent'),
      retentionDays: 30,
      shouldPause: async () => paused, // later: "is an exam window open?"
    });
    await w.drain();
    expect((await jobCall('get', id)).body.status).toBe('queued');
    paused = false;
    await w.drain();
    expect((await jobCall('get', id)).body.status).toBe('completed');
  });
});

describe('retention (D-06)', () => {
  const daysLeft = (d?: Date) => (d ? (d.getTime() - Date.now()) / 86_400_000 : -1);

  it('sets a purge date on previews, clears it while queued/running, and sets it again when finished', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Retention One', '1')]);
    const preview = await ImportJob.findById(id);
    expect(daysLeft(preview?.purgeAt)).toBeGreaterThan(29);
    expect(daysLeft(preview?.purgeAt)).toBeLessThanOrEqual(30.01);
    expect((await ImportRow.find({ jobId: id })).every((r) => r.purgeAt !== undefined)).toBe(true);
    expect((await jobCall('get', id)).body.purgeAt).not.toBeNull();

    expect((await jobCall('post', id, '/confirm')).status).toBe(200);
    expect((await ImportJob.findById(id))?.purgeAt).toBeUndefined(); // must not expire mid-processing
    expect((await ImportRow.find({ jobId: id })).every((r) => r.purgeAt === undefined)).toBe(true);

    await worker().drain();
    const finished = await ImportJob.findById(id);
    expect(finished?.status).toBe('completed');
    expect(daysLeft(finished?.purgeAt)).toBeGreaterThan(29);
    expect((await ImportRow.find({ jobId: id })).every((r) => daysLeft(r.purgeAt) > 29)).toBe(true);
  });

  it('starts the clock when an import is cancelled', async () => {
    const s = await setup();
    const id = await uploadOk(s, [row(s, newLogin(), 'Retention Two', '1')]);
    expect((await jobCall('post', id, '/confirm')).status).toBe(200); // purge date cleared
    expect((await jobCall('post', id, '/cancel')).status).toBe(200);
    expect(daysLeft((await ImportJob.findById(id))?.purgeAt)).toBeGreaterThan(29);
    expect((await ImportRow.find({ jobId: id })).every((r) => daysLeft(r.purgeAt) > 29)).toBe(true);
  });

  it('has TTL indexes so the database deletes expired jobs and rows by itself', async () => {
    for (const model of [ImportJob, ImportRow]) {
      const indexes = await model.collection.indexes();
      expect(indexes.some((i) => (i.key as Record<string, number>).purgeAt === 1 && (i as { expireAfterSeconds?: number }).expireAfterSeconds === 0)).toBe(true);
    }
  });
});
