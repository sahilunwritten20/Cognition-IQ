import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/common/csv';
import { AcademicYear, Department, Division, Enrollment, SchoolClass, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { Attempt } from '../src/modules/attempts/attempt.model';
import { AuditLog } from '../src/modules/audit/audit.model';
import { Question } from '../src/modules/questions/question.model';
import { Quiz } from '../src/modules/quizzes/quiz.model';
import { ROLES, User, type Role, type UserDoc } from '../src/modules/users/user.model';
import { bearer, collectKeys, FORBIDDEN_KEYS, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;
const oid = () => new Types.ObjectId().toString();
const at = (minutes: number) => new Date(ctx.clock.now + minutes * 60_000).toISOString();
const GRACE = 15_000;
const MIN = 60_000;

async function atTime<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const saved = ctx.clock.now;
  ctx.clock.now = ms;
  try {
    return await fn();
  } finally {
    ctx.clock.now = saved;
  }
}

// ---------------------------------------------------------------- fixtures (same shape as the exam-engine tests)
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
async function mkTeacher(s: S) {
  const { user } = await makeUser(ctx, { role: 'TEACHER', departmentId: s.dept._id });
  await TeachingAssignment.create({ collegeId: ctx.collegeId, teacherId: user._id, subjectId: s.subject._id, departmentId: s.dept._id, academicYearId: s.year._id, classId: s.cls._id, divisionId: s.div._id, active: true });
  return { user, token: tokenFor(ctx, user) };
}
async function mkQuestion(t: { user: UserDoc }, s: S, marks: number) {
  const a = `opt${++n}a`;
  const b = `opt${n}b`;
  const doc = await Question.create({
    collegeId: ctx.collegeId, departmentId: s.dept._id, subjectId: s.subject._id, type: 'mcq', text: uniq('Question '),
    options: [{ optionId: a, text: 'First' }, { optionId: b, text: 'Second' }], correctOptionId: a, marks, status: 'active', createdBy: t.user._id,
  });
  return { id: doc.id as string, a, b };
}
async function enrollStudent(s: S, rollNo = uniq(''), div = s.div) {
  const { user } = await makeUser(ctx, { role: 'STUDENT' });
  await Enrollment.create({ collegeId: ctx.collegeId, studentId: user._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: div._id, rollNo });
  return { user, token: tokenFor(ctx, user) };
}

const quizApi = (method: 'get' | 'post' | 'patch', path: string, token: string, body?: object) => request(ctx.app)[method](`/api/v1/quizzes${path}`).set(bearer(token)).send(body);
const startReq = (token: string, quizId: string) => request(ctx.app).post(`/api/v1/student/quizzes/${quizId}/start`).set(bearer(token)).send({});
const saveReq = (token: string, id: string, body: object) => request(ctx.app).put(`/api/v1/student/attempts/${id}/answers`).set(bearer(token)).send(body);
const submitReq = (token: string, id: string) => request(ctx.app).post(`/api/v1/student/attempts/${id}/submit`).set(bearer(token)).send({});
const stuGet = (token: string, path: string) => request(ctx.app).get(`/api/v1/student${path}`).set(bearer(token));

type Q = Awaited<ReturnType<typeof mkQuestion>>;
type Student = Awaited<ReturnType<typeof enrollStudent>>;
interface Live { s: S; t: Awaited<ReturnType<typeof mkTeacher>>; qs: [Q, Q, Q]; quiz: { id: string }; student: Student }
/** A published quiz that is open NOW: 3 questions (2 + 1.5 + 1 = 4.5 marks), 30 minutes, window -10..+120 min. The right answer is always "a". */
async function liveQuiz(over: Record<string, unknown> = {}): Promise<Live> {
  const s = await setupSubject();
  const t = await mkTeacher(s);
  const qs: [Q, Q, Q] = [await mkQuestion(t, s, 2), await mkQuestion(t, s, 1.5), await mkQuestion(t, s, 1)];
  const created = await quizApi('post', '/', t.token, {
    title: 'Unit Test 1', subjectId: s.subject.id, targets: [{ classId: s.cls.id, divisionId: s.div.id }],
    items: qs.map((q) => ({ questionId: q.id })), startAt: at(-10), endAt: at(120), durationMinutes: 30, ...over,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await quizApi('post', `/${created.body.id}/publish`, t.token)).status).toBe(200);
  return { s, t, qs, quiz: { id: created.body.id as string }, student: await enrollStudent(s) };
}
const ans = (q: Q, which: 'a' | 'b') => ({ questionId: q.id, selectedOptionId: which === 'a' ? q.a : q.b });
async function begin(l: Live, student: Student) {
  const res = await startReq(student.token, l.quiz.id);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { attempt: { id: string; endsAt: string } };
}
/** Starts, answers (null = leave blank), and submits. Returns the attempt id. */
async function take(l: Live, student: Student, picks: Array<'a' | 'b' | null>): Promise<string> {
  const a = await begin(l, student);
  const answers: Array<ReturnType<typeof ans>> = [];
  picks.forEach((p, i) => {
    if (p !== null) answers.push(ans(l.qs[i] as Q, p));
  });
  if (answers.length > 0) expect((await saveReq(student.token, a.attempt.id, { seq: 1, answers })).status).toBe(200);
  expect((await submitReq(student.token, a.attempt.id)).status).toBe(200);
  return a.attempt.id;
}
const close = (l: Live) => quizApi('post', `/${l.quiz.id}/close`, l.t.token, { reason: 'Exam finished' });
const res = (method: 'get' | 'post', l: { quiz: { id: string } }, path: string, token: string, body?: object) => request(ctx.app)[method](`/api/v1/quizzes/${l.quiz.id}${path}`).set(bearer(token)).send(body);
async function publishResults(l: Live, visibility?: 'hidden' | 'score_only' | 'score_and_answers') {
  expect((await close(l)).status).toBe(200);
  if (visibility) expect((await res('post', l, '/results/visibility', l.t.token, { visibility })).status).toBe(200);
  const p = await res('post', l, '/results/publish', l.t.token);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
}
const db = (id: string) => Attempt.findById(id).select('+answerKey');

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});
beforeEach(() => ctx.store.clear());

// ================================================================= TABLE
describe('the results table (roster reconciliation)', () => {
  it('shows every enrolled student: submitted, in progress, not started; sorted by roll number; summary over the whole class', async () => {
    const l = await liveQuiz({ passMarks: 4 });
    const notStarted = await enrollStudent(l.s, '1');
    const submitted = l.student; // roll set below
    await Enrollment.updateOne({ studentId: submitted.user._id }, { $set: { rollNo: '2' } });
    const running = await enrollStudent(l.s, '3');
    const perfect = await enrollStudent(l.s, '10');
    await take(l, submitted, ['a', 'a', null]); // 3.5: below the pass mark of 4
    await begin(l, running);
    await take(l, perfect, ['a', 'a', 'a']); // 4.5

    const r = await res('get', l, '/results', l.t.token);
    expect(r.status).toBe(200);
    expect(r.body.quiz).toMatchObject({ totalMarks: 4.5, passMarks: 4, resultsPublished: false, gradingRevision: 0 });
    expect(r.body.summary).toEqual({ enrolled: 4, notStarted: 1, inProgress: 1, gradingPending: 0, completed: 2, average: 4, highest: 4.5, lowest: 3.5, passed: 1, failed: 1 });
    const rows = r.body.items as Array<{ rollNo: string; status: string; score: number | null; percentage: number | null; passed: boolean | null; student: { id: string }; running: boolean }>;
    expect(rows.map((x) => x.rollNo)).toEqual(['1', '2', '3', '10']); // numeric order, not "1, 10, 2, 3"
    expect(rows.map((x) => x.status)).toEqual(['not_started', 'submitted', 'in_progress', 'submitted']);
    expect(rows.map((x) => x.score)).toEqual([null, 3.5, null, 4.5]);
    expect(rows.map((x) => x.percentage)).toEqual([null, 77.78, null, 100]);
    expect(rows.map((x) => x.passed)).toEqual([null, false, null, true]);
    expect(rows[2]?.running).toBe(true);
    expect(rows[0]?.student.id).toBe(notStarted.user.id);

    // The table never carries answers or keys.
    const keys = collectKeys(r.body);
    for (const k of [...FORBIDDEN_KEYS, 'selectedOptionId', 'answers', 'questions']) expect(keys.has(k), k).toBe(false);
  });

  it('counts the BEST attempt as official (ties: the earliest), and lists every attempt', async () => {
    const l = await liveQuiz({ maxAttempts: 2 });
    const a1 = await take(l, l.student, ['a', null, null]); // 2
    await take(l, l.student, ['a', 'a', 'a']); // 4.5
    const row = async () => ((await res('get', l, '/results', l.t.token)).body.items as Array<Record<string, unknown>>)[0] as { counted: { attemptNo: number; score: number }; attempts: Array<{ attemptNo: number; score: number }>; score: number };
    const first = await row();
    expect(first.counted).toMatchObject({ attemptNo: 2, score: 4.5 });
    expect(first.attempts.map((a) => [a.attemptNo, a.score])).toEqual([[1, 2], [2, 4.5]]);

    // Make both attempts equal: the earlier one is official.
    await Attempt.updateOne({ quizId: l.quiz.id, attemptNo: 2 }, { $set: { 'grading.score': 2 } });
    expect((await row()).counted.attemptNo).toBe(1);
    expect((await db(a1))?.status).toBe('submitted');
  });

  it('filters by status, paginates, and keeps the summary for the whole class', async () => {
    const l = await liveQuiz();
    const others = [await enrollStudent(l.s, '7'), await enrollStudent(l.s, '8')];
    await take(l, l.student, ['a', 'a', 'a']);
    const page = await res('get', l, '/results?pageSize=2&page=2', l.t.token);
    expect(page.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.body.items).toHaveLength(1);
    expect(page.body.summary).toMatchObject({ enrolled: 3, notStarted: 2, completed: 1 });
    const filtered = await res('get', l, '/results?status=not_started', l.t.token);
    expect(filtered.body.total).toBe(2);
    expect((filtered.body.items as Array<{ student: { id: string } }>).map((x) => x.student.id).sort()).toEqual(others.map((o) => o.user.id).sort());
    for (const bad of ['pageSize=101', 'status=done', 'unknown=1', 'page=0']) expect((await res('get', l, `/results?${bad}`, l.t.token)).status, bad).toBe(400);
  });

  it('is private to the owner, readable by the department HOD and (audited) SUPER_ADMIN, never by students', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', null, null]);
    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: foreignHod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: (await setupSubject()).dept._id });
    const { user: hodNoDept } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });

    expect((await res('get', l, '/results', other.token)).status).toBe(404);
    expect((await res('get', l, '/results', tokenFor(ctx, hod))).status).toBe(200);
    expect((await res('get', l, '/results', tokenFor(ctx, foreignHod))).status).toBe(404);
    expect((await res('get', l, '/results', tokenFor(ctx, hodNoDept))).status).toBe(403);
    expect((await res('get', l, '/results', l.student.token)).status).toBe(403);
    expect((await request(ctx.app).get(`/api/v1/quizzes/${l.quiz.id}/results`)).status).toBe(401);

    const before = await AuditLog.countDocuments({ action: 'results.support_access', actorId: admin._id });
    expect((await res('get', l, '/results', tokenFor(ctx, admin))).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'results.support_access', actorId: admin._id })).toBe(before + 1);
  });
});

// ================================================================= CSV
describe('CSV export', () => {
  it('is scoped, escaped, formula-safe, in the display time zone, bounded, and audited', async () => {
    const l = await liveQuiz({ passMarks: 4 });
    await User.updateOne({ _id: l.student.user._id }, { $set: { name: '=HYPERLINK("http://evil","click")' } }); // a hostile name
    const second = await enrollStudent(l.s, '99');
    await User.updateOne({ _id: second.user._id }, { $set: { name: 'Patil, Asha' } }); // a comma
    await Enrollment.updateOne({ studentId: l.student.user._id }, { $set: { rollNo: '5' } });
    await take(l, l.student, ['a', 'a', 'a']); // 4.5 -> PASS

    const out = await res('get', l, '/results/export', l.t.token);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toContain('text/csv');
    expect(out.headers['content-disposition']).toMatch(/^attachment; filename="results-[0-9a-f]{24}\.csv"$/);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.text.startsWith('\uFEFF')).toBe(true); // Excel-friendly for Marathi/Hindi names

    const [header, ...rows] = parseCsv(out.text, { maxRows: 100 });
    expect(header).toEqual(['rollNo', 'loginId', 'name', 'class', 'division', 'status', 'attempts', 'score', 'totalMarks', 'percentage', 'result', 'countedAttempt', 'submittedAt (Asia/Kolkata)']);
    expect(rows).toHaveLength(2);
    const hostile = rows.find((r) => r[0] === '5') as string[];
    expect(hostile[2]).toBe(`'=HYPERLINK("http://evil","click")`); // neutralized: it cannot run as a formula
    expect(hostile.slice(5)).toEqual(['submitted', '1', '4.5', '4.5', '100', 'PASS', '1', '2026-11-06 15:30:00']); // 10:00 UTC = 15:30 IST
    const comma = rows.find((r) => r[0] === '99') as string[];
    expect(comma[2]).toBe('Patil, Asha');
    expect(comma.slice(5)).toEqual(['not_started', '0', '', '4.5', '', '', '', '']);

    expect(await AuditLog.findOne({ action: 'results.exported', targetId: l.quiz.id })).not.toBeNull();
  });

  it('can be exported by the HOD and SUPER_ADMIN of the scope, not by outsiders or students', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', null, null]);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: foreign } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: (await setupSubject()).dept._id });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const other = await mkTeacher(l.s);
    expect((await res('get', l, '/results/export', tokenFor(ctx, hod))).status).toBe(200);
    expect((await res('get', l, '/results/export', tokenFor(ctx, admin))).status).toBe(200);
    expect((await res('get', l, '/results/export', tokenFor(ctx, foreign))).status).toBe(404);
    expect((await res('get', l, '/results/export', other.token)).status).toBe(404);
    expect((await res('get', l, '/results/export', l.student.token)).status).toBe(403);
    const audits = await AuditLog.find({ action: 'results.exported', targetId: l.quiz.id }).lean();
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});

// ================================================================= PUBLICATION
describe('publishing results (D-01)', () => {
  it('needs a started quiz that is over, no running attempts and complete grading', async () => {
    const draftS = await setupSubject();
    const draftT = await mkTeacher(draftS);
    const draft = await quizApi('post', '/', draftT.token, { title: 'Just a draft', subjectId: draftS.subject.id, targets: [{ classId: draftS.cls.id, divisionId: draftS.div.id }] });
    expect((await res('post', { quiz: { id: draft.body.id } }, '/results/publish', draftT.token)).status).toBe(409);

    const l = await liveQuiz();
    const a = await begin(l, l.student);
    const open = await res('post', l, '/results/publish', l.t.token);
    expect(open.status).toBe(409);
    expect(open.body.error.message).toMatch(/still open/);

    await close(l);
    const running = await res('post', l, '/results/publish', l.t.token);
    expect(running.status).toBe(409);
    expect(running.body.error).toMatchObject({ code: 'ATTEMPTS_IN_PROGRESS', details: { running: 1 } });

    // The teacher's "finalize expired attempts": nothing is overdue yet; after the deadline it closes the attempt.
    expect((await res('post', l, '/finalize-expired', l.t.token)).body).toEqual({ finalized: 0, stillRunning: 1 });
    const closed = await atTime(Date.parse(a.attempt.endsAt) + GRACE + 1, () => res('post', l, '/finalize-expired', l.t.token));
    expect(closed.body).toEqual({ finalized: 1, stillRunning: 0 });

    // A closed attempt that is not graded blocks publication until grading completes.
    await Attempt.updateOne({ _id: a.attempt.id }, { $set: { 'grading.status': 'pending' } });
    const ungraded = await res('post', l, '/results/publish', l.t.token);
    expect(ungraded.body.error).toMatchObject({ code: 'GRADING_INCOMPLETE', details: { ungraded: 1 } });
    expect(await ctx.modules.attempts.gradePending()).toBeGreaterThanOrEqual(1);

    const ok = await res('post', l, '/results/publish', l.t.token);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ resultsPublished: true, resultVisibility: 'hidden' });
    expect((await res('post', l, '/results/publish', l.t.token)).status).toBe(409); // twice
    expect((await quizApi('get', `/${l.quiz.id}`, l.t.token)).body).toMatchObject({ resultsPublished: true });
    expect(await AuditLog.findOne({ action: 'results.published', targetId: l.quiz.id })).not.toBeNull();
  });

  it('can also be published once the window has ended without closing the quiz', async () => {
    const l = await liveQuiz({ startAt: at(-30), endAt: at(10) });
    await take(l, l.student, ['a', 'a', 'a']);
    const during = await res('post', l, '/results/publish', l.t.token);
    expect(during.status).toBe(409);
    const after = await atTime(Date.parse(at(10)) + 1, () => res('post', l, '/results/publish', l.t.token));
    expect(after.status).toBe(200);
  });

  it('can be withdrawn with a reason, and the visibility change after publication needs a reason', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', null, null]);
    expect((await res('post', l, '/results/visibility', l.t.token, { visibility: 'score_only' })).status).toBe(200); // open quiz, not published
    await publishResults(l);

    expect((await res('post', l, '/results/visibility', l.t.token, { visibility: 'score_and_answers' })).status).toBe(400); // reason needed now
    expect((await res('post', l, '/results/visibility', l.t.token, { visibility: 'everyone', reason: 'Because I can' })).status).toBe(400);
    const changed = await res('post', l, '/results/visibility', l.t.token, { visibility: 'score_and_answers', reason: 'Students asked for a review' });
    expect(changed.body).toMatchObject({ resultVisibility: 'score_and_answers', resultsPublished: true });
    const audit = await AuditLog.findOne({ action: 'results.visibility_changed', targetId: l.quiz.id, 'summary.to': 'score_and_answers' });
    expect(audit?.summary).toMatchObject({ from: 'score_only', published: true, reason: 'Students asked for a review' });

    expect((await res('post', l, '/results/unpublish', l.t.token, {})).status).toBe(400);
    expect((await res('post', l, '/results/unpublish', l.t.token, { reason: 'Marks sheet is wrong' })).body.resultsPublished).toBe(false);
    expect((await res('post', l, '/results/unpublish', l.t.token, { reason: 'Again please' })).status).toBe(409);
    expect(await AuditLog.findOne({ action: 'results.unpublished', targetId: l.quiz.id })).not.toBeNull();
  });

  it('is only for the owning teacher', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', null, null]);
    await close(l);
    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect((await res('post', l, '/results/publish', other.token)).status).toBe(404);
    for (const token of [tokenFor(ctx, hod), tokenFor(ctx, admin), l.student.token]) expect((await res('post', l, '/results/publish', token)).status).toBe(403);
  });

  it('checks the pass mark against the total when publishing the quiz', async () => {
    const l = await liveQuiz();
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await mkQuestion(t, s, 2);
    const draft = await quizApi('post', '/', t.token, { title: 'Pass mark test', subjectId: s.subject.id, targets: [{ classId: s.cls.id, divisionId: s.div.id }], items: [{ questionId: q.id }], startAt: at(60), endAt: at(180), durationMinutes: 30, passMarks: 10 });
    expect(draft.status).toBe(201);
    expect(draft.body.passMarks).toBe(10);
    const refused = await quizApi('post', `/${draft.body.id}/publish`, t.token);
    expect(JSON.stringify(refused.body.error.details)).toMatch(/passMarks/);
    const cleared = await quizApi('patch', `/${draft.body.id}`, t.token, { revision: 1, passMarks: null });
    expect(cleared.body.passMarks).toBeNull();
    expect((await quizApi('post', `/${draft.body.id}/publish`, t.token)).status).toBe(200);
    expect(l.quiz.id).toBeTruthy();
  });
});

// ================================================================= STUDENT VIEW
describe('what a student sees of their result', () => {
  const resultOf = (l: Live, student: Student) => stuGet(student.token, `/quizzes/${l.quiz.id}/result`);
  const NO_SECRETS = [...FORBIDDEN_KEYS, 'awarded', 'selectedOptionId', 'review', 'createdBy', 'codeHash'];

  it('shows nothing until published, and nothing at all while the visibility is hidden', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', 'a', null]);
    const early = await resultOf(l, l.student);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('RESULT_NOT_RELEASED');
    expect(early.body.error.message).not.toMatch(/\d/); // no score hint in the error

    await publishResults(l); // visibility defaults to hidden (D-01)
    const hidden = await resultOf(l, l.student);
    expect(hidden.status).toBe(409);
    expect(hidden.body.error.code).toBe('RESULT_NOT_RELEASED');
    expect(((await stuGet(l.student.token, '/results')).body.items as unknown[])).toHaveLength(0);
    for (const body of [early.body, hidden.body]) for (const k of NO_SECRETS) expect(collectKeys(body).has(k), k).toBe(false);
  });

  it('score_only: the score and pass/fail, and no per-question data', async () => {
    const l = await liveQuiz({ passMarks: 3 });
    await take(l, l.student, ['a', 'a', null]); // 3.5
    await publishResults(l, 'score_only');
    const r = await resultOf(l, l.student);
    expect(r.status).toBe(200);
    expect(r.body.visibility).toBe('score_only');
    expect(r.body.result).toMatchObject({ attemptNo: 1, status: 'submitted', score: 3.5, totalMarks: 4.5, percentage: 77.78, passed: true });
    expect(r.body.quiz).toMatchObject({ title: 'Unit Test 1', totalMarks: 4.5, passMarks: 3 });
    expect(r.body.review).toBeUndefined();
    for (const k of NO_SECRETS) expect(collectKeys(r.body).has(k), k).toBe(false);
  });

  it('score_and_answers: a review of the student\'s own official attempt, the ONLY place a key reaches a student, and only after release', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', 'b', null]); // q1 right (2), q2 wrong, q3 blank
    expect((await resultOf(l, l.student)).status).toBe(409); // before release: no review either
    await publishResults(l, 'score_and_answers');
    const r = await resultOf(l, l.student);
    expect(r.status).toBe(200);
    const review = r.body.review as Array<{ questionId: string; sequence: number; selectedOptionId: string | null; correctOptionId: string | null; awarded: number; isCorrect: boolean; marks: number }>;
    expect(review.map((x) => x.questionId)).toEqual(l.qs.map((q) => q.id));
    expect(review.map((x) => [x.selectedOptionId, x.correctOptionId, x.awarded, x.isCorrect])).toEqual([
      [l.qs[0].a, l.qs[0].a, 2, true],
      [l.qs[1].b, l.qs[1].a, 0, false],
      [null, l.qs[2].a, 0, false],
    ]);
    const keys = collectKeys(r.body);
    for (const k of ['answerKey', 'grading', 'internalNotes', 'codeHash', 'createdBy', 'tokenVersion']) expect(keys.has(k), k).toBe(false);
    expect(r.body.result.score).toBe(2);
  });

  it('is strictly the student\'s own, and only for students enrolled in the quiz who took it', async () => {
    const l = await liveQuiz();
    const other = await enrollStudent(l.s);
    const absent = await enrollStudent(l.s);
    const elsewhere = await enrollStudent(l.s, uniq(''), l.s.div2);
    await take(l, l.student, ['a', 'a', 'a']);
    await take(l, other, ['a', null, null]);
    await publishResults(l, 'score_only');

    expect((await resultOf(l, l.student)).body.result.score).toBe(4.5);
    expect((await resultOf(l, other)).body.result.score).toBe(2); // their own, never someone else's
    expect((await resultOf(l, absent)).status).toBe(404); // did not take it
    expect((await resultOf(l, elsewhere)).status).toBe(404); // not enrolled in a target division
    expect((await stuGet(l.t.token, `/quizzes/${l.quiz.id}/result`)).status).toBe(403);
    expect((await stuGet(l.student.token, `/quizzes/${oid()}/result`)).status).toBe(404);
  });

  it('lists only released, visible results, newest first, with bounded pages', async () => {
    const l1 = await liveQuiz();
    const student = l1.student;
    await take(l1, student, ['a', 'a', 'a']);
    await publishResults(l1, 'score_only');
    await atTime(ctx.clock.now + 5 * MIN, async () => undefined);

    // A second quiz for the same student: published but hidden, and a third not yet published.
    const mk = async (visibility?: 'hidden' | 'score_only') => {
      const t = l1.t;
      const created = await quizApi('post', '/', t.token, { title: uniq('Second quiz '), subjectId: l1.s.subject.id, targets: [{ classId: l1.s.cls.id, divisionId: l1.s.div.id }], items: l1.qs.map((q) => ({ questionId: q.id })), startAt: at(-10), endAt: at(120), durationMinutes: 30 });
      await quizApi('post', `/${created.body.id}/publish`, t.token);
      const l = { ...l1, quiz: { id: created.body.id as string } };
      await take(l, student, ['a', null, null]);
      if (visibility) await publishResults(l, visibility);
      return l;
    };
    const hiddenQuiz = await mk('hidden');
    const unpublished = await mk();
    const later = await atTime(ctx.clock.now + 10 * MIN, () => mk('score_only'));

    const list = await stuGet(student.token, '/results');
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{ quizId: string; score: number; releasedAt: string; subject: { code: string } | null; visibility: string }>;
    expect(items.map((i) => i.quizId)).toEqual([later.quiz.id, l1.quiz.id]); // newest first; hidden and unpublished excluded
    expect(items.map((i) => i.quizId)).not.toContain(hiddenQuiz.quiz.id);
    expect(items.map((i) => i.quizId)).not.toContain(unpublished.quiz.id);
    expect(items[1]).toMatchObject({ score: 4.5, subject: { code: l1.s.subject.code }, visibility: 'score_only' });
    for (const k of NO_SECRETS) expect(collectKeys(list.body).has(k), k).toBe(false);
    for (const bad of ['pageSize=101', 'page=0', 'x=1']) expect((await stuGet(student.token, `/results?${bad}`)).status, bad).toBe(400);
    expect((await stuGet(l1.t.token, '/results')).status).toBe(403);
  });

  it('reports a result that is not graded yet as "not ready", never as a score', async () => {
    const l = await liveQuiz();
    const a = await take(l, l.student, ['a', 'a', 'a']);
    await publishResults(l, 'score_only');
    await Attempt.updateOne({ _id: a }, { $set: { 'grading.status': 'pending' } });
    const r = await resultOf(l, l.student);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('RESULT_NOT_READY');
  });

  it('shows the official (best) attempt and the score of each attempt', async () => {
    const l = await liveQuiz({ maxAttempts: 2 });
    await take(l, l.student, ['a', null, null]); // 2
    await take(l, l.student, ['a', 'a', 'a']); // 4.5
    await publishResults(l, 'score_only');
    const r = await resultOf(l, l.student);
    expect(r.body.result).toMatchObject({ attemptNo: 2, score: 4.5 });
    expect((r.body.attempts as Array<{ attemptNo: number; score: number }>).map((a) => [a.attemptNo, a.score])).toEqual([[1, 2], [2, 4.5]]);
  });
});

// ================================================================= REGRADE
describe('audited regrade (a wrong answer key, Runbook B)', () => {
  /** Three students; the key of question 2 should have been "b". */
  async function wrongKey() {
    const l = await liveQuiz();
    const s2 = await enrollStudent(l.s);
    const s3 = await enrollStudent(l.s);
    const a1 = await take(l, l.student, ['a', 'b', null]); // 2
    const a2 = await take(l, s2, ['a', 'a', null]); // 3.5
    const a3 = await take(l, s3, [null, null, null]); // 0
    return { l, s2, s3, a1, a2, a3 };
  }
  const fixQ2 = (l: Live, extra: Record<string, unknown> = {}) => ({ reason: 'Question 2 had the wrong key', changes: [{ action: 'set_key', questionId: l.qs[1].id, correctOptionId: l.qs[1].b }], ...extra });

  it('corrects the key, regrades every affected attempt, and keeps the original grade as history', async () => {
    const { l, s2, a1, a2, a3 } = await wrongKey();
    const out = await res('post', l, '/regrade', l.t.token, fixQ2(l));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ revision: 1, processed: 3, revised: 3, skipped: 0, resultsPublished: false });

    const g1 = (await db(a1))?.grading;
    expect(g1).toMatchObject({ status: 'done', score: 3.5, revision: 2, quizRevision: 1 }); // 2 -> 3.5
    expect(g1?.history?.map((h) => [h.revision, h.score, h.quizRevision])).toEqual([[1, 2, 0]]); // the ORIGINAL grade is kept
    expect((await db(a2))?.grading).toMatchObject({ score: 2, revision: 2 }); // 3.5 -> 2: the other answer was the wrong one
    expect((await db(a2))?.grading.history?.[0]?.score).toBe(3.5);
    expect((await db(a3))?.grading).toMatchObject({ score: 0, revision: 2 });
    expect((await db(a1))?.answerKey?.[l.qs[1].id]).toBe(l.qs[1].a); // the stored original key is never overwritten

    const quiz = await Quiz.findById(l.quiz.id);
    expect(quiz?.gradingRevision).toBe(1);
    expect(quiz?.corrections).toHaveLength(1);
    expect(quiz?.corrections[0]).toMatchObject({ revision: 1, reason: 'Question 2 had the wrong key' });

    // The table follows, and the audit trail is complete without exposing the key.
    const rows = (await res('get', l, '/results', l.t.token)).body.items as Array<{ student: { id: string }; score: number | null }>;
    expect(rows.find((r) => r.student.id === l.student.user.id)?.score).toBe(3.5);
    expect(rows.find((r) => r.student.id === s2.user.id)?.score).toBe(2);
    const audits = await AuditLog.find({ targetId: l.quiz.id, action: /^results\.regrade/ }).lean();
    expect(audits.map((a) => a.action).sort()).toEqual(['results.regrade_requested', 'results.regraded']);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain(l.qs[1].b);
    expect(dump).not.toContain(l.qs[1].a);
    expect(JSON.stringify(audits.find((a) => a.action === 'results.regraded')?.summary)).toContain('"revised":3');
  });

  it('shows the teacher one attempt in detail: the answer, the effective key, the marks and every earlier grading', async () => {
    const { l, a1 } = await wrongKey();
    await res('post', l, '/regrade', l.t.token, fixQ2(l));
    const d = await res('get', l, `/attempts/${a1}`, l.t.token);
    expect(d.status).toBe(200);
    expect(d.body.grading).toMatchObject({ status: 'done', score: 3.5, revision: 2, quizRevision: 1 });
    expect(d.body.grading.history).toHaveLength(1);
    const q2 = (d.body.questions as Array<{ sequence: number; selectedOptionId: string | null; correctOptionId: string; awarded: number; correct: boolean }>)[1];
    expect(q2).toMatchObject({ sequence: 2, selectedOptionId: l.qs[1].b, correctOptionId: l.qs[1].b, awarded: 1.5, correct: true });

    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    expect((await res('get', l, `/attempts/${a1}`, other.token)).status).toBe(404);
    expect((await res('get', l, `/attempts/${a1}`, tokenFor(ctx, hod))).status).toBe(403); // HOD never sees answers or keys
    expect((await res('get', l, `/attempts/${a1}`, l.student.token)).status).toBe(403);
    expect((await res('get', l, `/attempts/${oid()}`, l.t.token)).status).toBe(404);
  });

  it('can award everyone the marks of a faulty question, and records which items were adjusted', async () => {
    const { l, a3 } = await wrongKey();
    const out = await res('post', l, '/regrade', l.t.token, { reason: 'Question 3 was ambiguous', changes: [{ action: 'award_all', questionId: l.qs[2].id }] });
    expect(out.body).toMatchObject({ revision: 1, revised: 3 });
    const g = (await db(a3))?.grading;
    expect(g?.score).toBe(1); // a blank answer still earns the marks
    expect(g?.items?.map((i) => [i.awarded, i.adjusted])).toEqual([[0, false], [0, false], [1, true]]);
  });

  it('applies to students who were still taking the quiz, and to those who start later', async () => {
    const { l } = await wrongKey();
    const midway = await enrollStudent(l.s);
    const midwayAttempt = await begin(l, midway); // in progress while the correction is recorded
    await res('post', l, '/regrade', l.t.token, fixQ2(l));
    const late = await enrollStudent(l.s);
    const lateId = await take(l, late, ['a', 'b', null]); // starts AFTER the correction: its snapshot still holds the old key

    await saveReq(midway.token, midwayAttempt.attempt.id, { seq: 1, answers: [ans(l.qs[1], 'b')] });
    await submitReq(midway.token, midwayAttempt.attempt.id);
    expect((await db(midwayAttempt.attempt.id))?.grading).toMatchObject({ score: 1.5, revision: 1, quizRevision: 1 }); // graded WITH the correction
    expect((await db(lateId))?.grading).toMatchObject({ score: 3.5, quizRevision: 1 });
  });

  it('after publication it needs the approver, changes what students see, and is audited with the approver', async () => {
    const { l } = await wrongKey();
    await publishResults(l, 'score_and_answers');
    const student = (query: string) => stuGet(l.student.token, query);
    expect((await student(`/quizzes/${l.quiz.id}/result`)).body.result.score).toBe(2);

    const noApprover = await res('post', l, '/regrade', l.t.token, fixQ2(l));
    expect(noApprover.status).toBe(400);
    expect(JSON.stringify(noApprover.body.error.details)).toMatch(/approvedBy/);
    expect((await Quiz.findById(l.quiz.id))?.gradingRevision).toBe(0); // nothing was applied

    const ok = await res('post', l, '/regrade', l.t.token, fixQ2(l, { approvedBy: 'Dr. R. Joshi, Exam Controller' }));
    expect(ok.body).toMatchObject({ revision: 1, revised: 3, resultsPublished: true });
    const after = await student(`/quizzes/${l.quiz.id}/result`);
    expect(after.body.result.score).toBe(3.5);
    const q2 = (after.body.review as Array<{ correctOptionId: string; isCorrect: boolean }>)[1];
    expect(q2).toMatchObject({ correctOptionId: l.qs[1].b, isCorrect: true });
    const audit = await AuditLog.findOne({ targetId: l.quiz.id, action: 'results.regrade_requested' });
    expect(audit?.summary).toMatchObject({ approvedBy: 'Dr. R. Joshi, Exam Controller', published: true, reason: 'Question 2 had the wrong key' });
  });

  it('can be resumed if it was interrupted, and publication waits for it', async () => {
    const { l, a1, a2 } = await wrongKey();
    // Simulate a crash right after the correction was recorded and before any attempt was regraded.
    await Quiz.updateOne({ _id: l.quiz.id }, { $push: { corrections: { revision: 1, at: new Date(ctx.clock.now), by: l.t.user._id, reason: 'simulated interruption', changes: [{ questionId: new Types.ObjectId(l.qs[1].id), action: 'set_key', correctOptionId: l.qs[1].b }] } }, $set: { gradingRevision: 1 } });
    await close(l);
    const blocked = await res('post', l, '/results/publish', l.t.token);
    expect(blocked.body.error.code).toBe('GRADING_INCOMPLETE');

    const resumed = await res('post', l, '/regrade/resume', l.t.token);
    expect(resumed.body).toMatchObject({ revision: 1, processed: 3, revised: 3 });
    expect((await db(a1))?.grading.score).toBe(3.5);
    expect((await db(a2))?.grading.score).toBe(2);
    expect((await res('post', l, '/regrade/resume', l.t.token)).body).toMatchObject({ processed: 0, revised: 0 }); // nothing left to do
    expect((await res('post', l, '/results/publish', l.t.token)).status).toBe(200);
  });

  it('a later correction stacks on the earlier one, and each attempt keeps its whole history', async () => {
    const { l, a2 } = await wrongKey();
    await res('post', l, '/regrade', l.t.token, fixQ2(l));
    const second = await res('post', l, '/regrade', l.t.token, { reason: 'Changed my mind: Q2 was right after all', changes: [{ action: 'set_key', questionId: l.qs[1].id, correctOptionId: l.qs[1].a }] });
    expect(second.body.revision).toBe(2);
    const g = (await db(a2))?.grading;
    expect(g).toMatchObject({ score: 3.5, revision: 3, quizRevision: 2 });
    expect(g?.history?.map((h) => h.score)).toEqual([3.5, 2]);
  });

  it('refuses invalid corrections without recording anything', async () => {
    const { l } = await wrongKey();
    const base = { reason: 'A valid reason' };
    const q2 = l.qs[1];
    const cases: Array<[string, object]> = [
      ['no changes', { ...base, changes: [] }],
      ['no reason', { changes: [{ action: 'award_all', questionId: q2.id }] }],
      ['short reason', { reason: 'ab', changes: [{ action: 'award_all', questionId: q2.id }] }],
      ['question not in the quiz', { ...base, changes: [{ action: 'award_all', questionId: oid() }] }],
      ['option nobody saw', { ...base, changes: [{ action: 'set_key', questionId: q2.id, correctOptionId: 'opt999z' }] }],
      ['set_key without an option', { ...base, changes: [{ action: 'set_key', questionId: q2.id }] }],
      ['award_all with an option', { ...base, changes: [{ action: 'award_all', questionId: q2.id, correctOptionId: q2.a }] }],
      ['unknown action', { ...base, changes: [{ action: 'delete_question', questionId: q2.id }] }],
      ['same question twice', { ...base, changes: [{ action: 'award_all', questionId: q2.id }, { action: 'set_key', questionId: q2.id, correctOptionId: q2.b }] }],
      ['21 changes', { ...base, changes: Array.from({ length: 21 }, () => ({ action: 'award_all', questionId: oid() })) }],
      ['extra field', { ...base, score: 100, changes: [{ action: 'award_all', questionId: q2.id }] }],
      ['operator injection', { ...base, changes: [{ action: 'award_all', questionId: { $ne: 1 } }] }],
    ];
    for (const [label, body] of cases) expect((await res('post', l, '/regrade', l.t.token, body)).status, label).toBe(400);
    expect((await Quiz.findById(l.quiz.id))?.gradingRevision).toBe(0);

    const draftS = await setupSubject();
    const draftT = await mkTeacher(draftS);
    const draft = await quizApi('post', '/', draftT.token, { title: 'Just a draft', subjectId: draftS.subject.id, targets: [{ classId: draftS.cls.id, divisionId: draftS.div.id }] });
    expect((await res('post', { quiz: { id: draft.body.id } }, '/regrade', draftT.token, { ...base, changes: [{ action: 'award_all', questionId: oid() }] })).status).toBe(409);

    const fresh = await liveQuiz(); // nobody has finished yet: nothing to regrade
    expect((await res('post', fresh, '/regrade', fresh.t.token, { ...base, changes: [{ action: 'award_all', questionId: fresh.qs[0].id }] })).status).toBe(409);
  });

  it('is only for the owning teacher', async () => {
    const { l } = await wrongKey();
    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect((await res('post', l, '/regrade', other.token, fixQ2(l))).status).toBe(404);
    for (const token of [tokenFor(ctx, hod), tokenFor(ctx, admin), l.student.token]) expect((await res('post', l, '/regrade', token, fixQ2(l))).status).toBe(403);
    expect((await Quiz.findById(l.quiz.id))?.gradingRevision).toBe(0);
  });
});

// ================================================================= AUDIT HYGIENE
describe('audit records for results', () => {
  it('contain no student names, marks per student, answers or keys', async () => {
    const l = await liveQuiz();
    await take(l, l.student, ['a', 'b', null]);
    await res('get', l, '/results/export', l.t.token);
    await res('post', l, '/regrade', l.t.token, { reason: 'Fix key', changes: [{ action: 'set_key', questionId: l.qs[1].id, correctOptionId: l.qs[1].b }] });
    await publishResults(l, 'score_and_answers');
    const dump = JSON.stringify(await AuditLog.find({ targetId: l.quiz.id, action: /^results\./ }).lean());
    for (const secret of [l.student.user.loginId, l.student.user.name, l.qs[0].a, l.qs[1].a, l.qs[1].b, 'selectedOptionId', 'correctOptionId', 'answerKey']) expect(dump).not.toContain(secret);
  });
});

// ================================================================= PERMISSIONS
describe('permission matrix: results', () => {
  const ZERO = '0'.repeat(24);
  type Method = 'get' | 'post';
  interface Endpoint { method: Method; path: string; body?: object; allowed: Role[] }
  const reader: Role[] = ['TEACHER', 'HOD', 'SUPER_ADMIN'];
  const teacher: Role[] = ['TEACHER'];
  const ENDPOINTS: Endpoint[] = [
    { method: 'get', path: `/quizzes/${ZERO}/results`, allowed: reader },
    { method: 'get', path: `/quizzes/${ZERO}/results/export`, allowed: reader },
    { method: 'post', path: `/quizzes/${ZERO}/results/publish`, allowed: teacher },
    { method: 'post', path: `/quizzes/${ZERO}/results/unpublish`, body: { reason: 'A valid reason' }, allowed: teacher },
    { method: 'post', path: `/quizzes/${ZERO}/results/visibility`, body: { visibility: 'score_only' }, allowed: teacher },
    { method: 'post', path: `/quizzes/${ZERO}/regrade`, body: { reason: 'A valid reason', changes: [{ action: 'award_all', questionId: ZERO }] }, allowed: teacher },
    { method: 'post', path: `/quizzes/${ZERO}/regrade/resume`, allowed: teacher },
    { method: 'post', path: `/quizzes/${ZERO}/finalize-expired`, allowed: teacher },
    { method: 'get', path: `/quizzes/${ZERO}/attempts/${ZERO}`, allowed: teacher },
    { method: 'get', path: '/student/results', allowed: ['STUDENT'] },
    { method: 'get', path: `/student/quizzes/${ZERO}/result`, allowed: ['STUDENT'] },
  ];
  let deptId: Types.ObjectId;
  beforeAll(async () => {
    deptId = (await setupSubject()).dept._id;
  });

  for (const ep of ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} ${ep.path.replaceAll(ZERO, ':id')}`, () => {
      it('401 without a token', async () => {
        expect((await request(ctx.app)[ep.method](`/api/v1${ep.path}`).send(ep.body)).status).toBe(401);
      });
      for (const role of ROLES) {
        const allowed = ep.allowed.includes(role);
        it(`${role}: ${allowed ? 'allowed' : '403'}`, async () => {
          const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD', ...(role === 'HOD' ? { departmentId: deptId } : {}) });
          const r = await request(ctx.app)[ep.method](`/api/v1${ep.path}`).set(bearer(tokenFor(ctx, user))).send(ep.body);
          if (allowed) expect([401, 403]).not.toContain(r.status);
          else expect(r.status).toBe(403);
        });
      }
    });
  }
});
