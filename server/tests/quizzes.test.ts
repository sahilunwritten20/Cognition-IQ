import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKey } from '../src/common/crypto';
import { AcademicYear, Department, Division, Enrollment, SchoolClass, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { Question } from '../src/modules/questions/question.model';
import { verifyQuizCode } from '../src/modules/quizzes/quiz.code';
import { Quiz } from '../src/modules/quizzes/quiz.model';
import { ROLES, type Role, type UserDoc } from '../src/modules/users/user.model';
import { bearer, collectKeys, FORBIDDEN_KEYS, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
const attempts = { counts: new Map<string, number>(), started: new Set<string>() };
let n = 0;
const uniq = (p: string) => `${p}${++n}`;
const oid = () => new Types.ObjectId().toString();
const at = (minutes: number) => new Date(ctx.clock.now + minutes * 60_000).toISOString();

type Method = 'get' | 'post' | 'patch';
const api = (method: Method, path: string, token: string, body?: object) => request(ctx.app)[method](`/api/v1/quizzes${path}`).set(bearer(token)).send(body);
const studentApi = (token: string, qs = '') => request(ctx.app).get(`/api/v1/student/quizzes${qs}`).set(bearer(token));

/** Runs `fn` with the server clock set to `ms`, then restores it. */
async function atTime<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const saved = ctx.clock.now;
  ctx.clock.now = ms;
  try {
    return await fn();
  } finally {
    ctx.clock.now = saved;
  }
}

type S = Awaited<ReturnType<typeof setupSubject>>;
async function setupSubject() {
  const collegeId = ctx.collegeId;
  const dept = await Department.create({ collegeId, name: 'Science', code: uniq('SC') });
  const year = await AcademicYear.create({ collegeId, label: uniq('AY'), startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31'), isCurrent: false });
  const cls = await SchoolClass.create({ collegeId, departmentId: dept._id, academicYearId: year._id, name: 'First Year', code: uniq('FY') });
  const div = await Division.create({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: 'A' });
  const div2 = await Division.create({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: 'B' });
  const subject = await Subject.create({ collegeId, departmentId: dept._id, name: 'Biology', code: uniq('BIO') });
  return { dept, year, cls, div, div2, subject };
}
async function assign(teacher: UserDoc, s: S, div = s.div, cls = s.cls, year = s.year) {
  return TeachingAssignment.create({ collegeId: ctx.collegeId, teacherId: teacher._id, subjectId: s.subject._id, departmentId: s.dept._id, academicYearId: year._id, classId: cls._id, divisionId: div._id, active: true });
}
async function mkTeacher(s?: S) {
  const { user } = await makeUser(ctx, { role: 'TEACHER', ...(s ? { departmentId: s.dept._id } : {}) });
  if (s) await assign(user, s);
  return { user, token: tokenFor(ctx, user) };
}
async function mkQuestion(t: { user: UserDoc }, s: S, over: Partial<{ marks: number; status: 'active' | 'archived'; subjectId: Types.ObjectId; createdBy: Types.ObjectId }> = {}) {
  return Question.create({
    collegeId: ctx.collegeId,
    departmentId: s.dept._id,
    subjectId: over.subjectId ?? s.subject._id,
    type: 'true_false',
    text: uniq('Question '),
    options: [{ optionId: 'o_aaaaaa', text: 'True' }, { optionId: 'o_bbbbbb', text: 'False' }],
    correctOptionId: 'o_aaaaaa',
    marks: over.marks ?? 1,
    status: over.status ?? 'active',
    createdBy: over.createdBy ?? t.user._id,
  });
}
const quizBody = (s: S, questionIds: string[], over: Record<string, unknown> = {}) => ({
  title: 'Unit Test 1',
  subjectId: s.subject.id,
  targets: [{ classId: s.cls.id, divisionId: s.div.id }],
  items: questionIds.map((questionId) => ({ questionId })),
  startAt: at(60),
  endAt: at(180),
  durationMinutes: 60,
  ...over,
});

interface QuizBody { id: string; revision: number; status: string; state: string; accessCode?: string; totalMarks: number; hasCode: boolean; [k: string]: unknown }
async function createQuiz(token: string, body: object): Promise<QuizBody> {
  const res = await api('post', '/', token, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as QuizBody;
}
/** A teacher, a subject, three questions, and a ready-to-publish draft. */
async function readyDraft(over: Record<string, unknown> = {}) {
  const s = await setupSubject();
  const t = await mkTeacher(s);
  const qs = await Promise.all([mkQuestion(t, s, { marks: 2 }), mkQuestion(t, s, { marks: 1.5 }), mkQuestion(t, s)]);
  const quiz = await createQuiz(t.token, quizBody(s, qs.map((q) => q.id as string), over));
  return { s, t, qs, quiz };
}
async function enrollStudent(s: S, div = s.div, rollNo = uniq('')) {
  const { user } = await makeUser(ctx, { role: 'STUDENT' });
  await Enrollment.create({ collegeId: ctx.collegeId, studentId: user._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: div._id, rollNo });
  return { user, token: tokenFor(ctx, user) };
}

beforeAll(async () => {
  ctx = await startTestApp({
    attempts: {
      countsForStudent: async (studentId, quizIds) => new Map(quizIds.map((id): [string, number] => [id, attempts.counts.get(`${studentId}:${id}`) ?? 0])),
      quizHasAttempts: async (id) => attempts.started.has(id),
    },
  });
});
afterAll(async () => {
  await ctx.stop();
});

describe('creating a draft', () => {
  it('computes totals on the server, defaults marks from questions, derives scope, and shows the access code only once', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const [q1, q2] = await Promise.all([mkQuestion(t, s, { marks: 2 }), mkQuestion(t, s, { marks: 1.5 })]);
    const res = await api('post', '/', t.token, quizBody(s, [], { items: [{ questionId: q1.id }, { questionId: q2.id, marks: 3.25 }], accessMode: 'code' }));
    expect(res.status).toBe(201);
    const q = res.body as QuizBody;
    expect(q).toMatchObject({ status: 'draft', state: 'draft', totalMarks: 5.25, resultVisibility: 'hidden', maxAttempts: 1, revision: 1, mine: true, hasCode: true, requiresCode: true, resultsPublished: false, questionCount: 2, departmentId: s.dept.id, academicYearId: s.year.id });
    expect((q.items as Array<{ marks: number }>).map((i) => i.marks)).toEqual([2, 3.25]);
    expect((q.targets as Array<{ class: { code: string }; division: { name: string } }>)[0]).toMatchObject({ class: { code: s.cls.code }, division: { name: 'A' } });
    expect(q.accessCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    // Only a keyed hash is stored; the plain code and its hash never appear again.
    const plain = await Quiz.findById(q.id);
    expect(plain?.codeHash).toBeUndefined();
    const stored = await Quiz.findById(q.id).select('+codeHash');
    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyQuizCode(stored?.codeHash ?? '', q.accessCode ?? '', deriveKey(ctx.cfg.twoFactorEncryptionKey, 'quiz-codes-v1'))).toBe(true);
    const again = await api('get', `/${q.id}`, t.token);
    expect(again.body.accessCode).toBeUndefined();
    expect(again.body.hasCode).toBe(true);
    expect(JSON.stringify(again.body)).not.toContain(stored?.codeHash ?? 'x');

    const audits = JSON.stringify(await AuditLog.find({ action: /^quizzes\./ }).lean());
    expect(audits).not.toContain((q.accessCode ?? 'x').replace('-', ''));
    expect(audits).not.toContain(stored?.codeHash ?? 'x');
  });

  it('rounds the total half-up to 2 decimals and allows an empty, window-less draft', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const [a, b] = await Promise.all([mkQuestion(t, s, { marks: 0.1 }), mkQuestion(t, s, { marks: 0.2 })]);
    expect((await createQuiz(t.token, quizBody(s, [a.id, b.id]))).totalMarks).toBe(0.3);
    const bare = await createQuiz(t.token, { title: 'Bare draft', subjectId: s.subject.id, targets: [{ classId: s.cls.id, divisionId: s.div.id }] });
    expect(bare).toMatchObject({ totalMarks: 0, questionCount: 0, startAt: null, endAt: null, durationMinutes: null, hasCode: false, requiresCode: false });
    expect(bare.accessCode).toBeUndefined();
  });

  it('rejects every kind of invalid payload', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q1 = await mkQuestion(t, s);
    const ok = (over: Record<string, unknown> = {}) => quizBody(s, [q1.id], over);
    const bodies: Array<[string, object]> = [
      ['client sets totalMarks', ok({ totalMarks: 99 })],
      ['client sets status', ok({ status: 'published' })],
      ['client sets createdBy', ok({ createdBy: oid() })],
      ['client sets collegeId', ok({ collegeId: oid() })],
      ['client sets departmentId', ok({ departmentId: oid() })],
      ['client sets academicYearId', ok({ academicYearId: oid() })],
      ['client sets codeHash', ok({ codeHash: 'x'.repeat(64) })],
      ['client sets resultsPublishedAt', ok({ resultsPublishedAt: at(0) })],
      ['attempts 0', ok({ maxAttempts: 0 })],
      ['attempts 6', ok({ maxAttempts: 6 })],
      ['attempts 1.5', ok({ maxAttempts: 1.5 })],
      ['duration 0', ok({ durationMinutes: 0 })],
      ['duration 481', ok({ durationMinutes: 481 })],
      ['end before start', ok({ startAt: at(120), endAt: at(60) })],
      ['end equals start', ok({ startAt: at(60), endAt: at(60) })],
      ['date without time', ok({ startAt: '2026-11-20' })],
      ['date without offset', ok({ startAt: '2026-11-20T09:00:00' })],
      ['title too short', ok({ title: 'ab' })],
      ['no targets', ok({ targets: [] })],
      ['11 targets', ok({ targets: Array.from({ length: 11 }, () => ({ classId: oid(), divisionId: oid() })) })],
      ['duplicate question', quizBody(s, [q1.id, q1.id])],
      ['201 questions', quizBody(s, Array.from({ length: 201 }, () => oid()))],
      ['item marks 0', ok({ items: [{ questionId: q1.id, marks: 0 }] })],
      ['item marks 3 decimals', ok({ items: [{ questionId: q1.id, marks: 1.234 }] })],
      ['extra item field', ok({ items: [{ questionId: q1.id, correctOptionId: 'x' }] })],
      ['bad access mode', ok({ accessMode: 'secret' })],
      ['bad result visibility', ok({ resultVisibility: 'everyone' })],
      ['question id not an id', ok({ items: [{ questionId: 'nope' }] })],
      ['operator injection', ok({ subjectId: { $ne: null } })],
    ];
    for (const [label, body] of bodies) expect((await api('post', '/', t.token, body)).status, label).toBe(400);
    expect(await Quiz.countDocuments({ subjectId: s.subject._id })).toBe(0);
  });

  it("only accepts the teacher's own, active questions of the quiz's subject", async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const other = await mkTeacher(s);
    const otherSubject = await Subject.create({ collegeId: ctx.collegeId, departmentId: s.dept._id, name: 'Chemistry', code: uniq('CHE') });
    const bad = [
      await mkQuestion(other, s), // someone else's (private bank)
      await mkQuestion(t, s, { status: 'archived' }),
      await mkQuestion(t, s, { subjectId: otherSubject._id }),
    ];
    for (const q of bad) expect((await api('post', '/', t.token, quizBody(s, [q.id as string]))).status).toBe(400);
    expect((await api('post', '/', t.token, quizBody(s, [oid()]))).status).toBe(400);
  });

  it('enforces teaching-assignment scope (403) and a single academic year (400)', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s); // assigned to division A only
    const stranger = await mkTeacher();
    const q = await mkQuestion(t, s);
    const body = (over: Record<string, unknown>) => quizBody(s, [q.id as string], over);

    expect((await api('post', '/', t.token, body({ targets: [{ classId: s.cls.id, divisionId: s.div2.id }] }))).status).toBe(403); // not assigned to B
    expect((await api('post', '/', t.token, body({ targets: [{ classId: s.cls.id, divisionId: s.div.id }, { classId: s.cls.id, divisionId: s.div2.id }] }))).status).toBe(403);
    expect((await api('post', '/', t.token, body({ subjectId: oid() }))).status).toBe(403); // unassigned and non-existent look identical
    expect((await api('post', '/', stranger.token, body({}))).status).toBe(403);

    // Two classes of the same subject in different academic years cannot be mixed in one quiz.
    const year2 = await AcademicYear.create({ collegeId: ctx.collegeId, label: uniq('AY'), startDate: new Date('2027-06-01'), endDate: new Date('2028-05-31'), isCurrent: false });
    const cls2 = await SchoolClass.create({ collegeId: ctx.collegeId, departmentId: s.dept._id, academicYearId: year2._id, name: 'Second Year', code: uniq('SY') });
    const div2y = await Division.create({ collegeId: ctx.collegeId, classId: cls2._id, departmentId: s.dept._id, academicYearId: year2._id, name: 'A' });
    await assign(t.user, s, div2y, cls2, year2);
    const mixed = await api('post', '/', t.token, body({ targets: [{ classId: s.cls.id, divisionId: s.div.id }, { classId: cls2.id, divisionId: div2y.id }] }));
    expect(mixed.status).toBe(400);
    expect(JSON.stringify(mixed.body.error.details)).toMatch(/same academic year/);
    expect((await api('post', '/', t.token, body({ targets: [{ classId: cls2.id, divisionId: div2y.id }] }))).status).toBe(201);
  });
});

describe('editing a draft', () => {
  it('updates fields with optimistic concurrency, clears optional ones, and never changes the subject', async () => {
    const { s, t, qs, quiz } = await readyDraft();
    const extra = await mkQuestion(t, s, { marks: 4 });

    const first = await api('patch', `/${quiz.id}`, t.token, { revision: 1, title: 'Renamed test', instructions: 'Bring a pen.', items: [{ questionId: qs[0]?.id }, { questionId: extra.id }], maxAttempts: 2, resultVisibility: 'score_only' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 2, title: 'Renamed test', instructions: 'Bring a pen.', totalMarks: 6, questionCount: 2, maxAttempts: 2, resultVisibility: 'score_only' });

    expect((await api('patch', `/${quiz.id}`, t.token, { revision: 1, title: 'Stale edit' })).status).toBe(409);

    const cleared = await api('patch', `/${quiz.id}`, t.token, { revision: 2, instructions: '', startAt: null, endAt: null, durationMinutes: null });
    expect(cleared.body).toMatchObject({ instructions: null, startAt: null, endAt: null, durationMinutes: null, revision: 3 });

    for (const [label, body] of [
      ['subject change', { revision: 3, subjectId: oid() }],
      ['nothing to update', { revision: 3 }],
      ['no revision', { title: 'x y z' }],
      ['client sets status', { revision: 3, status: 'published' }],
      ['client sets total', { revision: 3, totalMarks: 50 }],
      ['end before start', { revision: 3, startAt: at(100), endAt: at(50) }],
    ] as Array<[string, object]>) {
      expect((await api('patch', `/${quiz.id}`, t.token, body)).status, label).toBe(400);
    }
  });

  it('keeps the window ordered when only one side changes', async () => {
    const { t, quiz } = await readyDraft(); // start +60, end +180
    expect((await api('patch', `/${quiz.id}`, t.token, { revision: 1, endAt: at(30) })).status).toBe(400);
    expect((await api('patch', `/${quiz.id}`, t.token, { revision: 1, startAt: at(200) })).status).toBe(400);
    expect((await api('patch', `/${quiz.id}`, t.token, { revision: 1, endAt: at(240) })).status).toBe(200);
  });

  it('creates a code when the mode needs one, keeps it across code modes, and drops it for scheduled', async () => {
    const { t, quiz } = await readyDraft();
    expect(quiz.hasCode).toBe(false);

    const toCode = await api('patch', `/${quiz.id}`, t.token, { revision: 1, accessMode: 'code' });
    expect(toCode.body.accessCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(toCode.body.hasCode).toBe(true);
    const hash1 = (await Quiz.findById(quiz.id).select('+codeHash'))?.codeHash;

    const toBoth = await api('patch', `/${quiz.id}`, t.token, { revision: 2, accessMode: 'both' });
    expect(toBoth.body.accessCode).toBeUndefined(); // same code, nothing new to show
    expect((await Quiz.findById(quiz.id).select('+codeHash'))?.codeHash).toBe(hash1);

    const toScheduled = await api('patch', `/${quiz.id}`, t.token, { revision: 3, accessMode: 'scheduled' });
    expect(toScheduled.body).toMatchObject({ hasCode: false, requiresCode: false });
    expect((await Quiz.findById(quiz.id).select('+codeHash'))?.codeHash).toBeUndefined();
  });

  it("is private: another teacher gets 404, and a published quiz is not editable", async () => {
    const { t, quiz } = await readyDraft();
    const other = await mkTeacher();
    expect((await api('patch', `/${quiz.id}`, other.token, { revision: 1, title: 'Hijack attempt' })).status).toBe(404);
    expect((await api('post', `/${quiz.id}/publish`, t.token)).status).toBe(200);
    const edit = await api('patch', `/${quiz.id}`, t.token, { revision: 2, title: 'Too late now' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.message).toMatch(/draft/i);
  });
});

describe('publishing', () => {
  it('lists every problem at once for an incomplete draft', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const draft = await createQuiz(t.token, { title: 'Incomplete', subjectId: s.subject.id, targets: [{ classId: s.cls.id, divisionId: s.div.id }] });
    const res = await api('post', `/${draft.id}/publish`, t.token);
    expect(res.status).toBe(400);
    const paths = (res.body.error.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['items', 'startAt', 'endAt', 'durationMinutes']));
    expect((await Quiz.findById(draft.id))?.status).toBe('draft');
  });

  it('checks the window and duration, and re-checks questions and assignments at publish time', async () => {
    const detail = async (id: string, t: { token: string }) => JSON.stringify((await api('post', `/${id}/publish`, t.token)).body.error?.details ?? []);

    const long = await readyDraft({ durationMinutes: 200 }); // window is 120 min
    expect(await detail(long.quiz.id, long.t)).toMatch(/longer than the time window/);

    const past = await readyDraft({ startAt: at(-120), endAt: at(-10) });
    expect(await detail(past.quiz.id, past.t)).toMatch(/already passed/);

    const archived = await readyDraft();
    await Question.updateOne({ _id: archived.qs[0]?._id }, { $set: { status: 'archived' } });
    expect(await detail(archived.quiz.id, archived.t)).toMatch(/archived or are no longer available/);

    const revoked = await readyDraft();
    await TeachingAssignment.updateMany({ teacherId: revoked.t.user._id }, { $set: { active: false } });
    expect(await detail(revoked.quiz.id, revoked.t)).toMatch(/targets\.0/);
  });

  it('publishes a complete quiz: scheduled or live by the clock, recomputed total, audited', async () => {
    const future = await readyDraft(); // starts in 60 minutes
    const res = await api('post', `/${future.quiz.id}/publish`, future.t.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'published', state: 'scheduled', totalMarks: 4.5, revision: 2 });
    expect(res.body.publishedAt).not.toBeNull();
    expect(res.body.accessCode).toBeUndefined();
    expect(await AuditLog.findOne({ action: 'quizzes.published', targetId: future.quiz.id })).not.toBeNull();

    const live = await readyDraft({ startAt: at(-10), endAt: at(50) });
    expect((await api('post', `/${live.quiz.id}/publish`, live.t.token)).body.state).toBe('live');
    expect((await api('post', `/${future.quiz.id}/publish`, future.t.token)).status).toBe(409); // twice
  });

  it("only the owning teacher can publish; other roles are refused", async () => {
    const { s, quiz } = await readyDraft();
    const other = await mkTeacher(s);
    expect((await api('post', `/${quiz.id}/publish`, other.token)).status).toBe(404);
    const { user: student } = await makeUser(ctx, { role: 'STUDENT' });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: s.dept._id });
    for (const u of [student, admin, hod]) expect((await api('post', `/${quiz.id}/publish`, tokenFor(ctx, u))).status).toBe(403);
  });
});

describe('lifecycle: pause, resume, close, unpublish', () => {
  async function published() {
    const d = await readyDraft();
    await api('post', `/${d.quiz.id}/publish`, d.t.token);
    return d;
  }

  it('pause and close require a reason; resume does not; every step is audited with its reason', async () => {
    const { t, quiz } = await published();
    expect((await api('post', `/${quiz.id}/pause`, t.token, {})).status).toBe(400);
    expect((await api('post', `/${quiz.id}/pause`, t.token, { reason: 'ab' })).status).toBe(400);

    const paused = await api('post', `/${quiz.id}/pause`, t.token, { reason: 'Fire drill' });
    expect(paused.body).toMatchObject({ status: 'paused', state: 'paused', statusReason: 'Fire drill' });
    expect((await api('post', `/${quiz.id}/pause`, t.token, { reason: 'Again please' })).status).toBe(409);

    expect((await api('post', `/${quiz.id}/resume`, t.token)).body).toMatchObject({ status: 'published', state: 'scheduled' });
    expect((await api('post', `/${quiz.id}/resume`, t.token)).status).toBe(409);

    expect((await api('post', `/${quiz.id}/close`, t.token, {})).status).toBe(400);
    const closed = await api('post', `/${quiz.id}/close`, t.token, { reason: 'Exam cancelled' });
    expect(closed.body).toMatchObject({ status: 'closed', state: 'closed', statusReason: 'Exam cancelled' });
    expect(closed.body.closedAt).not.toBeNull();

    for (const path of ['pause', 'close', 'unpublish']) expect((await api('post', `/${quiz.id}/${path}`, t.token, { reason: 'Too late now' })).status, path).toBe(409);
    for (const path of ['resume', 'publish']) expect((await api('post', `/${quiz.id}/${path}`, t.token)).status, path).toBe(409);

    const audits = await AuditLog.find({ targetId: quiz.id, action: /^quizzes\./ }).lean();
    expect(audits.find((a) => a.action === 'quizzes.paused')?.summary?.reason).toBe('Fire drill');
    expect(audits.find((a) => a.action === 'quizzes.closed')?.summary?.reason).toBe('Exam cancelled');
  });

  it('a draft can be discarded by closing it', async () => {
    const { t, quiz } = await readyDraft();
    expect((await api('post', `/${quiz.id}/close`, t.token, { reason: 'Not needed any more' })).body.status).toBe('closed');
  });

  it('unpublish returns to draft (editable again) only while no student has started', async () => {
    const { t, quiz } = await published();
    expect((await api('post', `/${quiz.id}/unpublish`, t.token, {})).status).toBe(400); // reason required

    attempts.started.add(quiz.id);
    const blocked = await api('post', `/${quiz.id}/unpublish`, t.token, { reason: 'Fix a typo' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already started/);
    attempts.started.delete(quiz.id);

    const back = await api('post', `/${quiz.id}/unpublish`, t.token, { reason: 'Fix a typo' });
    expect(back.body).toMatchObject({ status: 'draft', state: 'draft' });
    const edited = await api('patch', `/${quiz.id}`, t.token, { revision: back.body.revision, title: 'Typo fixed' });
    expect(edited.status).toBe(200);
    expect((await api('post', `/${quiz.id}/publish`, t.token)).status).toBe(200);
  });
});

describe('access code rotation', () => {
  it('issues a new code once and the old one stops working at once', async () => {
    const { t, quiz } = await readyDraft({ accessMode: 'code' });
    const key = deriveKey(ctx.cfg.twoFactorEncryptionKey, 'quiz-codes-v1');
    const oldHash = (await Quiz.findById(quiz.id).select('+codeHash'))?.codeHash ?? '';
    const res = await api('post', `/${quiz.id}/code/regenerate`, t.token);
    expect(res.status).toBe(200);
    expect(res.body.accessCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.body.accessCode).not.toBe(quiz.accessCode);
    const newHash = (await Quiz.findById(quiz.id).select('+codeHash'))?.codeHash ?? '';
    expect(newHash).not.toBe(oldHash);
    expect(verifyQuizCode(newHash, res.body.accessCode, key)).toBe(true);
    expect(verifyQuizCode(newHash, quiz.accessCode ?? '', key)).toBe(false);
    expect(JSON.stringify(await AuditLog.find({ action: 'quizzes.code_regenerated' }).lean())).not.toContain(res.body.accessCode.replace('-', ''));
  });

  it('is refused for quizzes without a code, closed quizzes and other teachers', async () => {
    const scheduled = await readyDraft();
    expect((await api('post', `/${scheduled.quiz.id}/code/regenerate`, scheduled.t.token)).status).toBe(409);
    const coded = await readyDraft({ accessMode: 'both' });
    const other = await mkTeacher(coded.s);
    expect((await api('post', `/${coded.quiz.id}/code/regenerate`, other.token)).status).toBe(404);
    await api('post', `/${coded.quiz.id}/close`, coded.t.token, { reason: 'Finished early' });
    expect((await api('post', `/${coded.quiz.id}/code/regenerate`, coded.t.token)).status).toBe(409);
  });
});

describe('who can see which quizzes', () => {
  it('teachers see only their own; HOD only their department (read-only); SUPER_ADMIN everything (read-only)', async () => {
    const a = await readyDraft();
    const b = await readyDraft();
    const idsOf = async (token: string, qs = '') => ((await api('get', `/?pageSize=100${qs}`, token)).body.items as QuizBody[]).map((x) => x.id);

    expect(await idsOf(a.t.token)).toContain(a.quiz.id);
    expect(await idsOf(a.t.token)).not.toContain(b.quiz.id);
    expect((await api('get', `/${a.quiz.id}`, b.t.token)).status).toBe(404);
    expect(await idsOf(a.t.token, '&status=published')).not.toContain(a.quiz.id);
    expect(await idsOf(a.t.token, `&subjectId=${a.s.subject.id}`)).toContain(a.quiz.id);

    const { user: hodA } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: a.s.dept._id });
    const hodSees = await api('get', `/${a.quiz.id}`, tokenFor(ctx, hodA));
    expect(hodSees.status).toBe(200);
    expect(hodSees.body.accessCode).toBeUndefined();
    expect(await idsOf(tokenFor(ctx, hodA))).toContain(a.quiz.id);
    expect(await idsOf(tokenFor(ctx, hodA))).not.toContain(b.quiz.id);
    expect((await api('get', `/${b.quiz.id}`, tokenFor(ctx, hodA))).status).toBe(404);
    const { user: hodNoDept } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true });
    expect((await api('get', '/', tokenFor(ctx, hodNoDept))).status).toBe(403);

    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect(await idsOf(tokenFor(ctx, admin))).toEqual(expect.arrayContaining([a.quiz.id, b.quiz.id]));
    expect((await api('get', `/${a.quiz.id}`, tokenFor(ctx, admin))).status).toBe(200);
    expect((await api('post', `/${a.quiz.id}/pause`, tokenFor(ctx, admin), { reason: 'Not allowed here' })).status).toBe(403);
  });

  it('never leaks across colleges and bounds the list', async () => {
    const foreign = await Quiz.create({
      collegeId: new Types.ObjectId(), departmentId: new Types.ObjectId(), academicYearId: new Types.ObjectId(), subjectId: new Types.ObjectId(), createdBy: new Types.ObjectId(),
      title: 'Foreign college quiz', targets: [{ classId: new Types.ObjectId(), divisionId: new Types.ObjectId() }],
    });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect((await api('get', `/${foreign.id}`, tokenFor(ctx, admin))).status).toBe(404);
    for (const bad of ['pageSize=101', 'status=deleted', 'unknown=1', 'subjectId[$ne]=x']) expect((await api('get', `/?${bad}`, tokenFor(ctx, admin))).status, bad).toBe(400);
  });
});

describe('eligible students', () => {
  it('lists enrolled students of the target divisions only, flags inactive accounts, and is scoped', async () => {
    const { s, t, quiz } = await readyDraft();
    const a = await enrollStudent(s, s.div, '1');
    const b = await enrollStudent(s, s.div, '2');
    await enrollStudent(s, s.div2, '1'); // other division: not a target
    await makeUser(ctx, { role: 'STUDENT' }); // not enrolled anywhere
    const { user: inactive } = await makeUser(ctx, { role: 'STUDENT', status: 'inactive' });
    await Enrollment.create({ collegeId: ctx.collegeId, studentId: inactive._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: s.div._id, rollNo: '3' });

    const res = await api('get', `/${quiz.id}/eligible-students?pageSize=100`, t.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const items = res.body.items as Array<{ student: { id: string }; eligible: boolean; accountStatus: string; rollNo: string }>;
    expect(items.map((i) => i.student.id).sort()).toEqual([a.user.id, b.user.id, inactive.id].sort());
    expect(items.find((i) => i.student.id === inactive.id)).toMatchObject({ eligible: false, accountStatus: 'inactive' });
    expect(items.filter((i) => i.eligible)).toHaveLength(2);
    expect((await api('get', `/${quiz.id}/eligible-students?pageSize=2`, t.token)).body.items).toHaveLength(2);

    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: s.dept._id });
    expect((await api('get', `/${quiz.id}/eligible-students`, tokenFor(ctx, hod))).status).toBe(200);
    const other = await mkTeacher();
    expect((await api('get', `/${quiz.id}/eligible-students`, other.token)).status).toBe(404);
  });
});

describe('what students see', () => {
  async function liveSetup(over: Record<string, unknown> = {}) {
    const d = await readyDraft({ startAt: at(60), endAt: at(180), ...over });
    const student = await enrollStudent(d.s, d.s.div);
    return { ...d, student };
  }
  const listed = async (token: string, qs = '') => (await studentApi(token, qs)).body.items as Array<Record<string, unknown>>;

  it('hides drafts, and shows a published quiz only to students enrolled in a target division', async () => {
    const { s, t, quiz, student } = await liveSetup();
    const sameClassOtherDivision = await enrollStudent(s, s.div2);
    const notEnrolled = (await makeUser(ctx, { role: 'STUDENT' })).user;

    expect((await listed(student.token)).some((q) => q.id === quiz.id)).toBe(false); // still a draft
    await api('post', `/${quiz.id}/publish`, t.token);
    expect((await listed(student.token)).some((q) => q.id === quiz.id)).toBe(true);
    expect(await listed(sameClassOtherDivision.token)).toHaveLength(0);
    expect(await listed(tokenFor(ctx, notEnrolled))).toHaveLength(0);

    // A student of ANOTHER year/class never sees it either.
    const elsewhere = await setupSubject();
    expect((await listed((await enrollStudent(elsewhere)).token)).some((q) => q.id === quiz.id)).toBe(false);

    // Widening the targets to both divisions (before publishing again) makes it visible to the other division too.
    await api('post', `/${quiz.id}/unpublish`, t.token, { reason: 'Add division B' });
    await assign(t.user, s, s.div2);
    const widened = await api('patch', `/${quiz.id}`, t.token, { revision: 3, targets: [{ classId: s.cls.id, divisionId: s.div.id }, { classId: s.cls.id, divisionId: s.div2.id }] });
    expect(widened.status).toBe(200);
    await api('post', `/${quiz.id}/publish`, t.token);
    expect((await listed(sameClassOtherDivision.token)).some((q) => q.id === quiz.id)).toBe(true);
  });

  it('returns an explicit allow-list: no question ids, code, hash, teacher or department ids', async () => {
    const { t, quiz, student } = await liveSetup({ accessMode: 'code' });
    await api('post', `/${quiz.id}/publish`, t.token);
    const res = await studentApi(student.token);
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<Record<string, unknown>>).find((q) => q.id === quiz.id) as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      ['activeAttemptId', 'attemptsLeft', 'attemptsUsed', 'available', 'durationMinutes', 'endAt', 'id', 'instructions', 'maxAttempts', 'questionCount', 'reason', 'reasonText', 'requiresCode', 'startAt', 'state', 'subject', 'title', 'totalMarks'].sort(),
    );
    expect(item).toMatchObject({ requiresCode: true, questionCount: 3, totalMarks: 4.5, durationMinutes: 60 });
    const keys = collectKeys(item); // the quiz object itself (the page wrapper legitimately has an `items` key)
    for (const k of [...FORBIDDEN_KEYS, 'items', 'questionId', 'codeHash', 'accessCode', 'createdBy', 'departmentId', 'targets', 'revision', 'resultVisibility']) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(quiz.accessCode ?? 'x');
  });

  it('follows the window boundaries exactly: start is inclusive, end is exclusive', async () => {
    const { t, quiz, student } = await liveSetup();
    await api('post', `/${quiz.id}/publish`, t.token);
    const start = Date.parse(at(60));
    const end = Date.parse(at(180));
    const view = (ms: number) => atTime(ms, async () => (await listed(student.token)).find((q) => q.id === quiz.id) as Record<string, unknown>);

    expect(await view(start - 1)).toMatchObject({ available: false, reason: 'not_started', state: 'scheduled' });
    expect((await view(start - 1)).reasonText).toBeTruthy();
    expect(await view(start)).toMatchObject({ available: true, reason: null, state: 'live' });
    expect(await view(end - 1)).toMatchObject({ available: true, state: 'live' });
    expect(await view(end)).toMatchObject({ available: false, reason: 'ended', state: 'ended' });
    // Ended less than 24 h ago: still listed, with the reason. Longer ago: gone.
    expect(await view(end + 23 * 3_600_000)).toMatchObject({ available: false, reason: 'ended' });
    expect(await view(end + 25 * 3_600_000)).toBeUndefined();
  });

  it('shows paused quizzes with the reason, and never shows closed or unpublished ones', async () => {
    const { t, quiz, student } = await liveSetup({ startAt: at(-10), endAt: at(100) });
    await api('post', `/${quiz.id}/publish`, t.token);
    const row = async () => (await listed(student.token)).find((q) => q.id === quiz.id);
    expect(await row()).toMatchObject({ available: true });

    await api('post', `/${quiz.id}/pause`, t.token, { reason: 'Power cut' });
    expect(await row()).toMatchObject({ available: false, reason: 'paused', state: 'paused' });
    await api('post', `/${quiz.id}/resume`, t.token);
    expect(await row()).toMatchObject({ available: true });

    await api('post', `/${quiz.id}/unpublish`, t.token, { reason: 'Check wording' });
    expect(await row()).toBeUndefined();
    await api('post', `/${quiz.id}/publish`, t.token);
    await api('post', `/${quiz.id}/close`, t.token, { reason: 'Finished' });
    expect(await row()).toBeUndefined();
  });

  it('counts finished attempts against the limit', async () => {
    const { t, quiz, student } = await liveSetup({ startAt: at(-10), endAt: at(100), maxAttempts: 2 });
    await api('post', `/${quiz.id}/publish`, t.token);
    const row = async () => (await listed(student.token)).find((q) => q.id === quiz.id);

    attempts.counts.set(`${student.user.id}:${quiz.id}`, 1);
    expect(await row()).toMatchObject({ available: true, attemptsUsed: 1, attemptsLeft: 1 });
    attempts.counts.set(`${student.user.id}:${quiz.id}`, 2);
    expect(await row()).toMatchObject({ available: false, reason: 'no_attempts_left', attemptsUsed: 2, attemptsLeft: 0 });
  });

  it('is for students only and bounds the page size', async () => {
    const { student, t } = await liveSetup();
    expect((await studentApi(t.token)).status).toBe(403);
    expect((await studentApi(student.token, '?pageSize=101')).status).toBe(400);
    expect((await studentApi(student.token, '?unknown=1')).status).toBe(400);
    expect((await request(ctx.app).get('/api/v1/student/quizzes')).status).toBe(401);
  });
});

describe('permission matrix: quizzes', () => {
  const ZERO = '0'.repeat(24);
  interface Endpoint { method: Method; path: string; body?: object; allowed: Role[]; student?: boolean }
  const reason = { reason: 'A valid reason' };
  const TEACHER: Role[] = ['TEACHER'];
  const READERS: Role[] = ['TEACHER', 'HOD', 'SUPER_ADMIN'];
  const ENDPOINTS: Endpoint[] = [
    { method: 'get', path: '/', allowed: READERS },
    { method: 'post', path: '/', body: {}, allowed: TEACHER },
    { method: 'get', path: `/${ZERO}`, allowed: READERS },
    { method: 'get', path: `/${ZERO}/eligible-students`, allowed: READERS },
    { method: 'patch', path: `/${ZERO}`, body: { revision: 1, title: 'Some title' }, allowed: TEACHER },
    { method: 'post', path: `/${ZERO}/publish`, allowed: TEACHER },
    { method: 'post', path: `/${ZERO}/unpublish`, body: reason, allowed: TEACHER },
    { method: 'post', path: `/${ZERO}/pause`, body: reason, allowed: TEACHER },
    { method: 'post', path: `/${ZERO}/resume`, allowed: TEACHER },
    { method: 'post', path: `/${ZERO}/close`, body: reason, allowed: TEACHER },
    { method: 'post', path: `/${ZERO}/code/regenerate`, allowed: TEACHER },
  ];
  let deptId: Types.ObjectId;
  beforeAll(async () => {
    deptId = (await setupSubject()).dept._id;
  });

  for (const ep of ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} /quizzes${ep.path === '/' ? '' : ep.path.replace(ZERO, '/:id')}`, () => {
      it('401 without a token', async () => {
        expect((await request(ctx.app)[ep.method](`/api/v1/quizzes${ep.path}`).send(ep.body)).status).toBe(401);
      });
      for (const role of ROLES) {
        const allowed = ep.allowed.includes(role);
        it(`${role}: ${allowed ? 'allowed' : '403'}`, async () => {
          const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD', ...(role === 'HOD' ? { departmentId: deptId } : {}) });
          const res = await api(ep.method, ep.path, tokenFor(ctx, user), ep.body);
          if (allowed) expect([401, 403]).not.toContain(res.status);
          else expect(res.status).toBe(403);
        });
      }
    });
  }

  describe('GET /student/quizzes', () => {
    for (const role of ROLES) {
      it(`${role}: ${role === 'STUDENT' ? 'allowed' : '403'}`, async () => {
        const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD', ...(role === 'HOD' ? { departmentId: deptId } : {}) });
        const res = await studentApi(tokenFor(ctx, user));
        expect(res.status).toBe(role === 'STUDENT' ? 200 : 403);
      });
    }
  });
});
