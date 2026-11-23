import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/common/csv';
import { totpCode } from '../src/common/totp';
import { Attempt } from '../src/modules/attempts/attempt.model';
import { User } from '../src/modules/users/user.model';
import { bearer, collectKeys, CSRF, FORBIDDEN_KEYS, refreshCookie, startTestApp, type TestCtx } from './helpers';

/**
 * The whole college, end to end, over HTTP only, with REAL logins (no minted tokens): first-login security steps, college structure,
 * staff, student import and one-time passwords, question bank, quiz, a live exam with a silent student, recovery, results,
 * publication, sessions and the audit trail. If this passes, the pieces really fit together.
 */
let ctx: TestCtx;
const A = '/api/v1';
const MIN = 60_000;
const GRACE = 15_000;

const call = (method: 'get' | 'post' | 'patch' | 'put', path: string, token?: string, body?: object) => {
  let req = request(ctx.app)[method](`${A}${path}`);
  if (token) req = req.set(bearer(token));
  return body === undefined ? req : req.send(body);
};
const at = (minutes: number) => new Date(ctx.clock.now + minutes * MIN).toISOString();

interface Session { token: string; cookie: string; pending: string[] }
async function login(loginId: string, password: string): Promise<Session> {
  const r = await request(ctx.app).post(`${A}/auth/login`).set(CSRF).send({ loginId, password });
  expect(r.status, `login ${loginId}: ${JSON.stringify(r.body)}`).toBe(200);
  return { token: r.body.accessToken as string, cookie: refreshCookie(r), pending: r.body.pendingActions as string[] };
}
async function changePassword(session: Session, current: string, next: string): Promise<Session> {
  const r = await call('post', '/auth/change-password', session.token, { currentPassword: current, newPassword: next });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { token: r.body.accessToken as string, cookie: refreshCookie(r), pending: r.body.pendingActions as string[] };
}
/** Enrols an authenticator app and returns its secret. */
async function enrolTotp(token: string): Promise<string> {
  const setup = await call('post', '/auth/2fa/setup', token);
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  expect((await call('post', '/auth/2fa/enable', token, { code: totpCode(secret, ctx.clock.now) })).status).toBe(204);
  return secret;
}
/** Password, then the one-time code of the NEXT 30 s step (a code can never be used twice). */
async function loginWith2fa(loginId: string, password: string, secret: string): Promise<Session> {
  ctx.clock.now += 30_000;
  const step1 = await request(ctx.app).post(`${A}/auth/login`).set(CSRF).send({ loginId, password });
  expect(step1.body.twoFactorRequired).toBe(true);
  const step2 = await request(ctx.app).post(`${A}/auth/2fa/verify`).set(CSRF).send({ challengeToken: step1.body.challengeToken, code: totpCode(secret, ctx.clock.now) });
  expect(step2.status, JSON.stringify(step2.body)).toBe(200);
  return { token: step2.body.accessToken as string, cookie: refreshCookie(step2), pending: step2.body.pendingActions as string[] };
}

// ---------------------------------------------------------------- shared story state
const ADMIN_PASS = 'Admin-Pass-2026-x';
let admin: Session;
let teacher: Session;
let hod: Session;
const id = {} as Record<'dept' | 'year' | 'cls' | 'div' | 'subject' | 'teacher' | 'hod' | 'quiz', string>;
interface Student { loginId: string; session: Session; userId: string }
const students: Student[] = [];
const questions: Array<{ id: string; correct: string; wrong: string; marks: number }> = [];
const handedOutPasswords: string[] = []; // every temporary password the system ever gave out
const studentBodies: unknown[] = []; // every student-facing response BEFORE results are published
const record = <T extends { body: unknown }>(r: T): T => {
  studentBodies.push(r.body);
  return r;
};
const three = <T>(xs: T[]): [T, T, T] => [xs[0] as T, xs[1] as T, xs[2] as T];

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});

describe('end to end: from a brand-new college to published results', () => {
  it('1. the administrator signs in for the first time: forced password change and two-factor enrolment before anything else', async () => {
    await User.create({
      collegeId: ctx.collegeId, name: 'College Admin', loginId: 'root.admin', role: 'SUPER_ADMIN', status: 'active', mustChangePassword: true,
      passwordHash: await ctx.modules.passwords.hash('Initial-Admin-Pass1'), // exactly what `npm run seed:admin` does
    });
    const first = await login('root.admin', 'Initial-Admin-Pass1');
    expect(first.pending).toEqual(['change_password', 'setup_2fa']);
    const blocked = await call('get', '/admin/users', first.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACTION_REQUIRED');

    const changed = await changePassword(first, 'Initial-Admin-Pass1', ADMIN_PASS);
    expect(changed.pending).toEqual(['setup_2fa']);
    const secret = await enrolTotp(changed.token);
    admin = await loginWith2fa('root.admin', ADMIN_PASS, secret);
    expect(admin.pending).toEqual([]);
    expect((await call('get', '/admin/users', admin.token)).status).toBe(200);
  });

  it('2. the administrator sets up the college structure', async () => {
    const post = async (path: string, body: object) => {
      const r = await call('post', path, admin.token, body);
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
      return r.body as { id: string };
    };
    id.dept = (await post('/academics/departments', { name: 'Computer Science', code: 'CS' })).id;
    id.year = (await post('/academics/years', { label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' })).id;
    expect((await call('post', `/academics/years/${id.year}/set-current`, admin.token)).body.isCurrent).toBe(true);
    id.cls = (await post('/academics/classes', { departmentId: id.dept, academicYearId: id.year, name: 'First Year BSc CS', code: 'FYCS' })).id;
    id.div = (await post('/academics/divisions', { classId: id.cls, name: 'A' })).id;
    id.subject = (await post('/academics/subjects', { departmentId: id.dept, name: 'Data Structures', code: 'DS101' })).id;
  });

  it('3. creates the head of department and a teacher; each completes their first-login steps (the HOD must use two-factor)', async () => {
    const create = async (loginId: string, name: string, role: 'HOD' | 'TEACHER') => {
      const r = await call('post', '/admin/users', admin.token, { name, loginId, role });
      expect(r.status).toBe(201);
      expect(r.body.user.mustChangePassword).toBe(true);
      handedOutPasswords.push(r.body.temporaryPassword as string);
      const link = await call('patch', `/academics/staff/${r.body.user.id}/department`, admin.token, { departmentId: id.dept });
      expect(link.body.user.departmentId).toBe(id.dept);
      return { userId: r.body.user.id as string, temp: r.body.temporaryPassword as string };
    };
    const t = await create('rao.teacher', 'Dr. S. Rao', 'TEACHER');
    const h = await create('iyer.hod', 'Prof. M. Iyer', 'HOD');
    id.teacher = t.userId;
    id.hod = h.userId;

    const tFirst = await login('rao.teacher', t.temp);
    expect(tFirst.pending).toEqual(['change_password']);
    teacher = await changePassword(tFirst, t.temp, 'Teacher-Pass-2026');
    expect(teacher.pending).toEqual([]);

    const hChanged = await changePassword(await login('iyer.hod', h.temp), h.temp, 'Hod-Pass-2026-xx');
    expect(hChanged.pending).toEqual(['setup_2fa']); // mandatory for HOD
    expect((await call('get', '/quizzes', hChanged.token)).body.error.code).toBe('ACTION_REQUIRED');
    hod = await loginWith2fa('iyer.hod', 'Hod-Pass-2026-xx', await enrolTotp(hChanged.token));

    const assignment = await call('post', '/academics/teaching-assignments', admin.token, { teacherId: id.teacher, subjectId: id.subject, classId: id.cls, divisionId: id.div });
    expect(assignment.status, JSON.stringify(assignment.body)).toBe(201);
  });

  it('4. imports the students; passwords are handed out ONCE; each student sets their own password', async () => {
    const csv = ['loginId,name,rollNo,departmentCode,classCode,divisionName', 'asha.patil,Asha Patil,1,CS,FYCS,A', 'bhavesh.k,Bhavesh Kulkarni,2,CS,FYCS,A', 'chitra.d,Chitra Deshmukh,3,CS,FYCS,A'].join('\n');
    const up = await request(ctx.app).post(`${A}/imports/students`).set(bearer(admin.token)).set('Content-Type', 'text/csv').send(csv);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.job.counts).toMatchObject({ total: 3, ready: 3, invalid: 0 }); // used the current academic year
    expect((await call('post', `/imports/${up.body.job.id}/confirm`, admin.token, {})).status).toBe(200);
    await ctx.modules.importWorker.drain();
    expect((await call('get', `/imports/${up.body.job.id}`, admin.token)).body.status).toBe('completed');

    const exp = await call('post', `/imports/${up.body.job.id}/credentials/export`, admin.token);
    expect(exp.status).toBe(200);
    const [, ...rows] = parseCsv(exp.text, { maxRows: 10 });
    expect(rows).toHaveLength(3);
    expect((await call('post', `/imports/${up.body.job.id}/credentials/export`, admin.token)).status).toBe(410); // one time only

    for (const r of rows) {
      const loginId = r[0] ?? '';
      const temp = r[6] ?? '';
      handedOutPasswords.push(temp);
      const first = await login(loginId, temp);
      expect(first.pending).toEqual(['change_password']);
      const session = await changePassword(first, temp, `Student-${loginId}-2026`);
      students.push({ loginId, session, userId: (await call('get', '/auth/me', session.token)).body.user.id as string });
    }
    // The temporary password stops working the moment the student chooses their own.
    const stale = await request(ctx.app).post(`${A}/auth/login`).set(CSRF).send({ loginId: 'asha.patil', password: handedOutPasswords[2] });
    expect(stale.status).toBe(401);
  });

  it('5. the teacher builds a quiz from their own questions and publishes it', async () => {
    const mine = await call('get', '/academics/teaching-assignments/mine', teacher.token);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].subject.id).toBe(id.subject);

    for (const [text, marks] of [['What is a stack?', 2], ['What is a queue?', 2], ['What is a heap?', 1]] as const) {
      const r = await call('post', '/questions', teacher.token, { type: 'mcq', subjectId: id.subject, text, marks, options: [{ text: 'Right answer', correct: true }, { text: 'Wrong answer' }, { text: 'Another wrong answer' }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const options = r.body.options as Array<{ optionId: string }>;
      questions.push({ id: r.body.id, correct: r.body.correctOptionId, wrong: options.find((o) => o.optionId !== r.body.correctOptionId)?.optionId ?? '', marks });
    }
    const quiz = await call('post', '/quizzes', teacher.token, {
      title: 'Data Structures: Unit Test 1', subjectId: id.subject, targets: [{ classId: id.cls, divisionId: id.div }],
      items: questions.map((q) => ({ questionId: q.id })), startAt: at(-10), endAt: at(120), durationMinutes: 30, passMarks: 2,
    });
    expect(quiz.status, JSON.stringify(quiz.body)).toBe(201);
    expect(quiz.body.totalMarks).toBe(5); // computed by the server
    id.quiz = quiz.body.id;
    expect((await call('post', `/quizzes/${id.quiz}/publish`, teacher.token)).body).toMatchObject({ status: 'published', state: 'live' });
  });

  it('6. the students take the exam: one answers everything right, one partly, one starts and goes silent', async () => {
    const [s1, s2, s3] = three(students);
    const [q1, q2, q3] = three(questions);
    for (const s of students) {
      const list = record(await call('get', '/student/quizzes', s.session.token));
      expect((list.body.items as Array<{ id: string; available: boolean }>).find((q) => q.id === id.quiz)?.available, s.loginId).toBe(true);
    }
    const start = async (s: Student) => {
      const r = record(await call('post', `/student/quizzes/${id.quiz}/start`, s.session.token, {}));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.questions).toHaveLength(3);
      return r.body as { attempt: { id: string } };
    };
    const a1 = await start(s1);
    const a2 = await start(s2);
    await start(s3); // goes silent
    // s1: cumulative autosaves (the second request carries everything changed since the first was acknowledged), then submit.
    expect(record(await call('put', `/student/attempts/${a1.attempt.id}/answers`, s1.session.token, { seq: 1, answers: [{ questionId: q1.id, selectedOptionId: q1.wrong }] })).status).toBe(200);
    expect(record(await call('put', `/student/attempts/${a1.attempt.id}/answers`, s1.session.token, { seq: 2, answers: [{ questionId: q1.id, selectedOptionId: q1.correct }, { questionId: q2.id, selectedOptionId: q2.correct }, { questionId: q3.id, selectedOptionId: q3.correct }] })).status).toBe(200);
    const done1 = record(await call('post', `/student/attempts/${a1.attempt.id}/submit`, s1.session.token, {}));
    expect(done1.body.attempt.status).toBe('submitted');
    expect(done1.body.attempt.score).toBeUndefined(); // no score for the student yet

    // s2: first right, second wrong; a repeated submit changes nothing; nobody can read someone else's attempt.
    record(await call('put', `/student/attempts/${a2.attempt.id}/answers`, s2.session.token, { seq: 1, answers: [{ questionId: q1.id, selectedOptionId: q1.correct }, { questionId: q2.id, selectedOptionId: q2.wrong }] }));
    expect(record(await call('post', `/student/attempts/${a2.attempt.id}/submit`, s2.session.token, {})).body.attempt.status).toBe('submitted');
    expect(record(await call('post', `/student/attempts/${a2.attempt.id}/submit`, s2.session.token, {})).status).toBe(200);
    expect(record(await call('get', `/student/attempts/${a1.attempt.id}`, s2.session.token)).status).toBe(404);
  });

  it('7. the teacher watches the monitor, extends time for the silent student, and recovers the exam without touching the database', async () => {
    const monitor = await call('get', `/quizzes/${id.quiz}/monitor`, teacher.token);
    expect(monitor.body.counts).toMatchObject({ eligible: 3, notStarted: 0, inProgress: 1, submitted: 2, autoSubmitted: 0, ungraded: 0 });
    const silent = (monitor.body.items as Array<{ status: string; student: { loginId: string }; attempt: { endsAt: string } }>).find((r) => r.status === 'in_progress');
    expect(silent?.student.loginId).toBe('chitra.d');

    const ext = await call('post', `/quizzes/${id.quiz}/extend`, teacher.token, { scope: 'students', studentIds: [three(students)[2].userId], minutes: 5, reason: 'Connection problems in the lab' });
    expect(ext.body).toMatchObject({ extended: 1 });
    const newEnds = Date.parse((ext.body.affected as Array<{ afterEndsAt: string }>)[0]?.afterEndsAt ?? '');
    expect(newEnds).toBe(Date.parse(silent?.attempt.endsAt ?? '') + 5 * MIN);

    // The HOD can watch but not act.
    expect((await call('get', `/quizzes/${id.quiz}/monitor`, hod.token)).status).toBe(200);
    expect((await call('post', `/quizzes/${id.quiz}/extend`, hod.token, { scope: 'all', minutes: 5, reason: 'Not allowed for a HOD' })).status).toBe(403);

    // Time passes: the extended deadline and the grace period are over. The teacher closes what is left.
    ctx.clock.now = newEnds + GRACE + 1000;
    expect((await call('post', `/quizzes/${id.quiz}/finalize-expired`, teacher.token)).body).toEqual({ finalized: 1, stillRunning: 0 });
    expect((await call('get', `/quizzes/${id.quiz}/monitor?view=summary`, teacher.token)).body.counts).toMatchObject({ inProgress: 0, submitted: 2, autoSubmitted: 1, ungraded: 0 });
  });

  it('8. results: the table reconciles the roster, the CSV exports, publication is explicit, and students see only their own', async () => {
    const table = await call('get', `/quizzes/${id.quiz}/results`, teacher.token);
    expect(table.body.summary).toEqual({ enrolled: 3, notStarted: 0, inProgress: 0, gradingPending: 0, completed: 3, average: 2.33, highest: 5, lowest: 0, passed: 2, failed: 1 });
    const byLogin = Object.fromEntries((table.body.items as Array<{ student: { loginId: string }; score: number; status: string; passed: boolean }>).map((r) => [r.student.loginId, r]));
    expect(byLogin['asha.patil']).toMatchObject({ score: 5, status: 'submitted', passed: true });
    expect(byLogin['bhavesh.k']).toMatchObject({ score: 2, status: 'submitted', passed: true });
    expect(byLogin['chitra.d']).toMatchObject({ score: 0, status: 'auto_submitted', passed: false }); // closed by the system, no answers

    const csv = await call('get', `/quizzes/${id.quiz}/results/export`, teacher.token);
    expect(parseCsv(csv.text, { maxRows: 10 })).toHaveLength(4); // header + 3 students
    expect((await call('get', `/quizzes/${id.quiz}/results/export`, hod.token)).status).toBe(200);

    // Nothing reaches a student until the teacher publishes, and publishing needs the quiz to be over.
    const early = record(await call('get', `/student/quizzes/${id.quiz}/result`, three(students)[0].session.token));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('RESULT_NOT_RELEASED');
    expect((await call('post', `/quizzes/${id.quiz}/results/publish`, teacher.token)).status).toBe(409); // the window is still open
    expect((await call('post', `/quizzes/${id.quiz}/close`, teacher.token, { reason: 'Exam finished' })).body.status).toBe('closed');
    expect((await call('post', `/quizzes/${id.quiz}/results/visibility`, teacher.token, { visibility: 'score_and_answers' })).status).toBe(200);
    expect((await call('post', `/quizzes/${id.quiz}/results/publish`, hod.token)).status).toBe(403); // HOD cannot publish
    const published = await call('post', `/quizzes/${id.quiz}/results/publish`, teacher.token);
    expect(published.body).toMatchObject({ resultsPublished: true, resultVisibility: 'score_and_answers' });
  });

  it('9. every student sees exactly their own released result, with a review of their own answers', async () => {
    const [s1, s2, s3] = three(students);
    const [q1, q2, q3] = three(questions);
    const result = async (s: Student) => {
      const r = await call('get', `/student/quizzes/${id.quiz}/result`, s.session.token);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    const r1 = await result(s1);
    expect(r1.result).toMatchObject({ score: 5, totalMarks: 5, percentage: 100, passed: true, status: 'submitted' });
    expect((r1.review as Array<{ selectedOptionId: string; correctOptionId: string; awarded: number }>).map((x) => [x.selectedOptionId, x.correctOptionId, x.awarded])).toEqual([[q1.correct, q1.correct, 2], [q2.correct, q2.correct, 2], [q3.correct, q3.correct, 1]]);

    const r2 = await result(s2);
    expect(r2.result).toMatchObject({ score: 2, passed: true });
    expect((r2.review as Array<{ selectedOptionId: string | null; awarded: number }>).map((x) => [x.selectedOptionId, x.awarded])).toEqual([[q1.correct, 2], [q2.wrong, 0], [null, 0]]);

    const r3 = await result(s3);
    expect(r3.result).toMatchObject({ score: 0, status: 'auto_submitted', passed: false });

    for (const s of students) {
      const list = await call('get', '/student/results', s.session.token);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({ quizId: id.quiz, totalMarks: 5 });
    }
  });

  it('10. sessions: the refresh token rotates, a replayed one is refused, and logout ends the session', async () => {
    const s1 = three(students)[0];
    const refresh = (cookie: string) => request(ctx.app).post(`${A}/auth/refresh`).set(CSRF).set('Cookie', cookie);
    const rotated = await refresh(s1.session.cookie);
    expect(rotated.status).toBe(200);
    const newCookie = refreshCookie(rotated);
    expect(newCookie).not.toBe(s1.session.cookie);
    expect((await call('get', '/auth/me', rotated.body.accessToken)).status).toBe(200);
    expect([401, 409]).toContain((await refresh(s1.session.cookie)).status); // the old token cannot be used again

    expect((await request(ctx.app).post(`${A}/auth/logout`).set(CSRF).set('Cookie', newCookie)).status).toBe(204);
    expect((await refresh(newCookie)).status).toBe(401); // the session is over
  });

  it('11. the audit trail tells the whole story, and holds none of the secrets that were handed out', async () => {
    const trail = async (qs: string) => ((await call('get', `/audit?${qs}&pageSize=100`, admin.token)).body.items as Array<{ action: string; actor: { role: string } | null }>);
    const quizActions = (await trail(`targetId=${id.quiz}`)).map((i) => i.action);
    expect(quizActions).toEqual(expect.arrayContaining(['quizzes.created', 'quizzes.published', 'quizzes.time_extended', 'results.attempts_finalized', 'quizzes.closed', 'results.visibility_changed', 'results.published']));
    expect((await trail('actionPrefix=admin.')).filter((i) => i.action === 'admin.user_created')).toHaveLength(2);
    expect((await trail('actionPrefix=import.')).map((i) => i.action)).toEqual(expect.arrayContaining(['import.validated', 'import.confirmed', 'import.completed', 'import.credentials_exported']));
    expect((await trail('actionPrefix=auth.')).map((i) => i.action)).toEqual(expect.arrayContaining(['auth.password_changed', 'auth.2fa_enabled']));

    const dump = JSON.stringify((await call('get', '/audit?pageSize=100', admin.token)).body);
    for (const secret of [...handedOutPasswords, ADMIN_PASS, 'Teacher-Pass-2026', 'Hod-Pass-2026-xx', 'passwordHash', 'correctOptionId', 'selectedOptionId']) expect(dump, secret).not.toContain(secret);
  });

  it('12. nothing a student received before publication contained a key, a score or grading data', () => {
    expect(studentBodies.length).toBeGreaterThan(10);
    for (const body of studentBodies) {
      const keys = collectKeys(body);
      for (const k of [...FORBIDDEN_KEYS, 'score', 'awarded', 'review', 'isCorrect', 'correct']) expect(keys.has(k), `${k} in ${JSON.stringify(body).slice(0, 120)}`).toBe(false);
    }
  });

  it('13. the database ends in a consistent state', async () => {
    expect(await Attempt.countDocuments({ quizId: id.quiz })).toBe(3);
    expect(await Attempt.countDocuments({ quizId: id.quiz, status: 'in_progress' })).toBe(0);
    const graded = await Attempt.find({ quizId: id.quiz }).select('grading.status grading.revision grading.score');
    expect(graded.every((a) => a.grading.status === 'done' && a.grading.revision === 1)).toBe(true);
    expect(graded.map((a) => a.grading.score).sort()).toEqual([0, 2, 5]);
  });
});
