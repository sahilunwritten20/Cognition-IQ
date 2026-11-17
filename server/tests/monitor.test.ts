import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AcademicYear, Department, Division, Enrollment, SchoolClass, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { Attempt } from '../src/modules/attempts/attempt.model';
import { gradeAttempt } from '../src/modules/attempts/grading';
import { AuditLog } from '../src/modules/audit/audit.model';
import { Question } from '../src/modules/questions/question.model';
import { Quiz } from '../src/modules/quizzes/quiz.model';
import { ROLES, type Role, type UserDoc } from '../src/modules/users/user.model';
import { bearer, collectKeys, FORBIDDEN_KEYS, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;
const oid = () => new Types.ObjectId().toString();
const at = (minutes: number) => new Date(ctx.clock.now + minutes * 60_000).toISOString();
const GRACE = 15_000;
const MIN = 60_000;
const SEC = 1000;

async function atTime<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const saved = ctx.clock.now;
  ctx.clock.now = ms;
  try {
    return await fn();
  } finally {
    ctx.clock.now = saved;
  }
}

// ---------------------------------------------------------------- fixtures
type S = Awaited<ReturnType<typeof setupSubject>>;
async function setupSubject() {
  const collegeId = ctx.collegeId;
  const dept = await Department.create({ collegeId, name: 'Science', code: uniq('SC') });
  const year = await AcademicYear.create({ collegeId, label: uniq('AY'), startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31'), isCurrent: false });
  const cls = await SchoolClass.create({ collegeId, departmentId: dept._id, academicYearId: year._id, name: 'First Year', code: uniq('FY') });
  const div = await Division.create({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: 'A' });
  const subject = await Subject.create({ collegeId, departmentId: dept._id, name: 'Biology', code: uniq('BIO') });
  return { dept, year, cls, div, subject };
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
async function enrollStudent(s: S, rollNo = uniq('')) {
  const { user } = await makeUser(ctx, { role: 'STUDENT' });
  await Enrollment.create({ collegeId: ctx.collegeId, studentId: user._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: s.div._id, rollNo });
  return { user, token: tokenFor(ctx, user) };
}

const quizApi = (method: 'get' | 'post', path: string, token: string, body?: object) => request(ctx.app)[method](`/api/v1/quizzes${path}`).set(bearer(token)).send(body);
const startReq = (token: string, quizId: string) => request(ctx.app).post(`/api/v1/student/quizzes/${quizId}/start`).set(bearer(token)).send({});
const getAttempt = (token: string, id: string) => request(ctx.app).get(`/api/v1/student/attempts/${id}`).set(bearer(token));
const saveReq = (token: string, id: string, body: object) => request(ctx.app).put(`/api/v1/student/attempts/${id}/answers`).set(bearer(token)).send(body);
const submitReq = (token: string, id: string) => request(ctx.app).post(`/api/v1/student/attempts/${id}/submit`).set(bearer(token)).send({});

type Q = Awaited<ReturnType<typeof mkQuestion>>;
type Student = Awaited<ReturnType<typeof enrollStudent>>;
interface Live { s: S; t: Awaited<ReturnType<typeof mkTeacher>>; qs: [Q, Q, Q]; quiz: { id: string }; student: Student }
/** A published quiz that is open NOW: 3 questions (4.5 marks), 30 minutes, window -10..+120 min. The right answer is always "a". */
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
  const r = await startReq(student.token, l.quiz.id);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { attempt: { id: string; endsAt: string } };
}
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
const api = (method: 'get' | 'post', l: { quiz: { id: string } }, path: string, token: string, body?: object) =>
  request(ctx.app)[method](`/api/v1/quizzes/${l.quiz.id}${path}`).set(bearer(token)).send(body);
const db = (id: string) => Attempt.findById(id).select('+answerKey');
const T = () => ctx.clock.now;

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});
beforeEach(() => ctx.store.clear());

// ================================================================= LIVE MONITOR
describe('the live monitor', () => {
  it('shows everyone: stalled first, then running, not started and finished; with counts, remaining time and the server clock', async () => {
    const l = await liveQuiz();
    await Enrollment.updateOne({ studentId: l.student.user._id }, { $set: { rollNo: '1' } }); // never starts
    const [s2, s3, s4, s5] = [await enrollStudent(l.s, '2'), await enrollStudent(l.s, '3'), await enrollStudent(l.s, '4'), await enrollStudent(l.s, '5')];
    const start = T();
    const a2 = await begin(l, s2);
    await begin(l, s3);
    await take(l, s4, ['a', 'a', null]);
    const a5 = await begin(l, s5);
    await ctx.modules.attempts.finalize(a5.attempt.id, 'auto_submitted', new Date(start));
    await atTime(start + 100 * SEC, () => saveReq(s2.token, a2.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] })); // s2 is active; s3 is silent

    const r = await atTime(start + 120 * SEC, () => api('get', l, '/monitor', l.t.token));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ serverNow: new Date(start + 120 * SEC).toISOString(), lastUpdated: new Date(start + 120 * SEC).toISOString(), pollAfterSeconds: 10 });
    expect(r.body.quiz).toMatchObject({ status: 'published', state: 'live', durationMinutes: 30, resultsPublished: false });
    expect(r.body.counts).toEqual({ eligible: 5, notStarted: 1, inProgress: 2, stalled: 1, submitted: 1, autoSubmitted: 1, ungraded: 0 });

    const rows = r.body.items as Array<{ rollNo: string; status: string; stalled: boolean; attempt: null | { remainingSeconds: number | null; lastSavedAt: string | null; lastSeq: number; extendedMinutes: number } }>;
    expect(rows.map((x) => [x.rollNo, x.status, x.stalled])).toEqual([['3', 'in_progress', true], ['2', 'in_progress', false], ['1', 'not_started', false], ['5', 'auto_submitted', false], ['4', 'submitted', false]]);
    expect(rows[0]?.attempt).toMatchObject({ remainingSeconds: 1680, lastSavedAt: new Date(start).toISOString(), lastSeq: 0, extendedMinutes: 0 }); // 30 min - 120 s
    expect(rows[1]?.attempt).toMatchObject({ lastSavedAt: new Date(start + 100 * SEC).toISOString(), lastSeq: 1 });
    expect(rows[2]?.attempt).toBeNull();
    expect(rows[3]?.attempt?.remainingSeconds).toBeNull(); // only running attempts have a countdown

    const keys = collectKeys(r.body);
    for (const k of [...FORBIDDEN_KEYS, 'answers', 'selectedOptionId', 'questions', 'score']) expect(keys.has(k), k).toBe(false);
  });

  it('flags a student as stalled only after the threshold (90 s), and not once the time is up', async () => {
    const l = await liveQuiz();
    const a = await begin(l, l.student);
    const start = T();
    const stalledAt = async (ms: number) => ((await atTime(ms, () => api('get', l, '/monitor?view=summary', l.t.token))).body.counts.stalled as number);
    expect(await stalledAt(start + 90 * SEC)).toBe(0);
    expect(await stalledAt(start + 91 * SEC)).toBe(1);
    await atTime(start + 100 * SEC, () => saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] }));
    expect(await stalledAt(start + 150 * SEC)).toBe(0); // saved 50 s ago
    expect(await stalledAt(start + 30 * MIN + SEC)).toBe(0); // past the deadline: out of time, not stalled
    expect((await Attempt.findById(a.attempt.id))?.lastActivityAt.getTime()).toBe(start + 100 * SEC); // server time of the last accepted save
  });

  it('can return only the counts, filter, and paginate within bounds', async () => {
    const l = await liveQuiz();
    const others = [await enrollStudent(l.s, '7'), await enrollStudent(l.s, '8')];
    await begin(l, l.student);
    await take(l, others[0] as Student, ['a', null, null]);
    const summary = await api('get', l, '/monitor?view=summary', l.t.token);
    expect(summary.body.items).toBeUndefined();
    expect(summary.body.counts).toMatchObject({ eligible: 3, inProgress: 1, submitted: 1, notStarted: 1 });
    expect((await api('get', l, '/monitor?status=submitted', l.t.token)).body.total).toBe(1);
    expect((await api('get', l, '/monitor?pageSize=1&page=2', l.t.token)).body).toMatchObject({ page: 2, pageSize: 1, total: 3 });
    for (const bad of ['pageSize=101', 'page=0', 'status=done', 'view=everything', 'unknown=1']) expect((await api('get', l, `/monitor?${bad}`, l.t.token)).status, bad).toBe(400);
  });

  it('counts finished attempts that are not graded yet', async () => {
    const l = await liveQuiz();
    const id = await take(l, l.student, ['a', null, null]);
    await Attempt.updateOne({ _id: id }, { $set: { 'grading.status': 'pending' } });
    expect((await api('get', l, '/monitor?view=summary', l.t.token)).body.counts.ungraded).toBe(1);
  });

  it('is visible to the owner, the department HOD (read-only) and SUPER_ADMIN; never to others or students', async () => {
    const l = await liveQuiz();
    await begin(l, l.student);
    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: foreign } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: (await setupSubject()).dept._id });
    const { user: noDept } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect((await api('get', l, '/monitor', tokenFor(ctx, hod))).status).toBe(200);
    expect((await api('get', l, '/monitor', tokenFor(ctx, admin))).status).toBe(200);
    expect((await api('get', l, '/monitor', other.token)).status).toBe(404);
    expect((await api('get', l, '/monitor', tokenFor(ctx, foreign))).status).toBe(404);
    expect((await api('get', l, '/monitor', tokenFor(ctx, noDept))).status).toBe(403);
    expect((await api('get', l, '/monitor', l.student.token)).status).toBe(403);
    expect((await request(ctx.app).get(`/api/v1/quizzes/${l.quiz.id}/monitor`)).status).toBe(401);
  });
});

// ================================================================= EXTEND TIME
describe('extending time', () => {
  it('adds minutes to every running attempt, records before/after, and students see the new deadline at their next sync', async () => {
    const l = await liveQuiz();
    const s2 = await enrollStudent(l.s);
    const done = await enrollStudent(l.s);
    const a1 = await begin(l, l.student);
    const a2 = await begin(l, s2);
    const finished = await take(l, done, ['a', null, null]);
    const before = Date.parse(a1.attempt.endsAt);

    const r = await api('post', l, '/extend', l.t.token, { scope: 'all', minutes: 10, reason: 'Power cut in the lab' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'all', minutes: 10, extended: 2, expired: 0, capped: 0, skipped: 0 });
    expect(r.body.affected).toHaveLength(2);

    const stored = await Attempt.findById(a1.attempt.id);
    expect(stored?.endsAt.getTime()).toBe(before + 10 * MIN);
    expect(stored?.extensions).toHaveLength(1);
    expect(stored?.extensions[0]).toMatchObject({ minutes: 10, reason: 'Power cut in the lab' });
    expect(stored?.extensions[0]?.beforeEndsAt.getTime()).toBe(before);
    expect(stored?.extensions[0]?.afterEndsAt.getTime()).toBe(before + 10 * MIN);
    expect(stored?.extensions[0]?.by.toString()).toBe(l.t.user.id);
    expect((await Attempt.findById(finished))?.extensions).toHaveLength(0); // finished attempts are untouched

    // The student sees it at the next save and at the next resume.
    const save = await saveReq(l.student.token, a1.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] });
    expect(save.body.endsAt).toBe(new Date(before + 10 * MIN).toISOString());
    expect((await getAttempt(s2.token, a2.attempt.id)).body.attempt.endsAt).toBe(new Date(Date.parse(a2.attempt.endsAt) + 10 * MIN).toISOString());
    const mon = await api('get', l, '/monitor', l.t.token);
    expect((mon.body.items as Array<{ attempt: { extendedMinutes: number } | null; status: string }>).filter((x) => x.status === 'in_progress').every((x) => x.attempt?.extendedMinutes === 10)).toBe(true);

    const audit = await AuditLog.findOne({ action: 'quizzes.time_extended', targetId: l.quiz.id });
    expect(audit?.summary).toMatchObject({ scope: 'all', minutes: 10, extended: 2, reason: 'Power cut in the lab', role: 'TEACHER' });
  });

  it('can target selected students or selected attempts, and refuses when none of them is running', async () => {
    const l = await liveQuiz();
    const s2 = await enrollStudent(l.s);
    const s3 = await enrollStudent(l.s);
    const a1 = await begin(l, l.student);
    const a2 = await begin(l, s2);
    const a3 = await begin(l, s3);
    const ends = async (id: string) => (await Attempt.findById(id))?.endsAt.getTime() ?? 0;
    const base = [await ends(a1.attempt.id), await ends(a2.attempt.id), await ends(a3.attempt.id)];

    const one = await api('post', l, '/extend', l.t.token, { scope: 'students', studentIds: [l.student.user.id], minutes: 5, reason: 'Accommodation: extra time' });
    expect(one.body).toMatchObject({ extended: 1 });
    const two = await api('post', l, '/extend', l.t.token, { scope: 'attempts', attemptIds: [a2.attempt.id, oid()], minutes: 7, reason: 'Network problems' });
    expect(two.body).toMatchObject({ extended: 1 });
    expect([await ends(a1.attempt.id), await ends(a2.attempt.id), await ends(a3.attempt.id)]).toEqual([(base[0] ?? 0) + 5 * MIN, (base[1] ?? 0) + 7 * MIN, base[2]]);

    await submitReq(s3.token, a3.attempt.id);
    const none = await api('post', l, '/extend', l.t.token, { scope: 'students', studentIds: [s3.user.id], minutes: 5, reason: 'Already finished' });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_MATCHING_ATTEMPTS');
    expect((await api('post', l, '/extend', l.t.token, { scope: 'attempts', attemptIds: [oid()], minutes: 5, reason: 'Unknown attempt' })).status).toBe(409);
  });

  it('caps the total extra time per attempt', async () => {
    const l = await liveQuiz();
    const a = await begin(l, l.student);
    const ext = (minutes: number) => api('post', l, '/extend', l.t.token, { scope: 'all', minutes, reason: 'Repeated extension' });
    expect((await ext(120)).body.extended).toBe(1);
    expect((await ext(120)).body.extended).toBe(1); // 240 in total: the limit
    const third = await ext(1);
    expect(third.body).toMatchObject({ extended: 0, capped: 1 });
    expect((await Attempt.findById(a.attempt.id))?.extensions).toHaveLength(2);
  });

  it('does not revive an attempt that is already out of time, and the sweeper respects extended deadlines', async () => {
    const l = await liveQuiz();
    const other = await enrollStudent(l.s);
    const late = await begin(l, l.student);
    const extended = await begin(l, other);
    const endsAt = Date.parse(late.attempt.endsAt);
    await api('post', l, '/extend', l.t.token, { scope: 'students', studentIds: [other.user.id], minutes: 10, reason: 'Slow connection' });

    const t = endsAt + GRACE + 1; // past the ORIGINAL deadline
    const tooLate = await atTime(t, () => api('post', l, '/extend', l.t.token, { scope: 'students', studentIds: [l.student.user.id], minutes: 10, reason: 'Too late for this one' }));
    expect(tooLate.body).toMatchObject({ extended: 0, expired: 1 });
    expect((await Attempt.findById(late.attempt.id))?.status).toBe('in_progress'); // not revived and not yet closed

    expect(await atTime(t, () => ctx.modules.attempts.finalizeExpired({ quizId: l.quiz.id }))).toBe(1); // only the unextended one
    expect((await Attempt.findById(late.attempt.id))?.status).toBe('auto_submitted');
    expect((await Attempt.findById(extended.attempt.id))?.status).toBe('in_progress');
    expect((await atTime(t, () => saveReq(other.token, extended.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] }))).status).toBe(200); // still open for them
  });

  it('may extend past the end of the quiz window (guide Section 8)', async () => {
    const l = await liveQuiz({ startAt: at(-30), endAt: at(10), durationMinutes: 30 }); // window ends in 10 minutes
    const a = await begin(l, l.student);
    expect(Date.parse(a.attempt.endsAt)).toBe(T() + 10 * MIN); // D-11: capped by the window
    await api('post', l, '/extend', l.t.token, { scope: 'all', minutes: 30, reason: 'Exam started late' });
    const inLateWindow = T() + 35 * MIN; // after the quiz window has ended
    expect((await atTime(inLateWindow, () => saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] }))).status).toBe(200);
    const submit = await atTime(inLateWindow, () => submitReq(l.student.token, a.attempt.id));
    expect(submit.body).toMatchObject({ attempt: { status: 'submitted' }, lateRejected: false });
    const another = await enrollStudent(l.s);
    expect((await atTime(inLateWindow, () => startReq(another.token, l.quiz.id))).body.error.details.reason).toBe('ended'); // no NEW starts
  });

  it('is consistent when two extensions arrive at the same moment', async () => {
    const l = await liveQuiz();
    const a = await begin(l, l.student);
    const base = Date.parse(a.attempt.endsAt);
    const results = await Promise.all([1, 2].map(() => api('post', l, '/extend', l.t.token, { scope: 'all', minutes: 10, reason: 'Simultaneous request' })));
    const applied = results.reduce((sum, r) => sum + (r.body.extended as number), 0);
    const stored = await Attempt.findById(a.attempt.id);
    expect(stored?.extensions.length).toBe(applied); // every applied extension is recorded, none is lost
    expect(stored?.endsAt.getTime()).toBe(base + applied * 10 * MIN);
    expect(applied).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid requests, drafts and everyone who may not extend', async () => {
    const l = await liveQuiz();
    await begin(l, l.student);
    const ok = { scope: 'all', minutes: 5, reason: 'A valid reason' };
    const cases: Array<[string, object]> = [
      ['0 minutes', { ...ok, minutes: 0 }],
      ['121 minutes', { ...ok, minutes: 121 }],
      ['fractional', { ...ok, minutes: 1.5 }],
      ['string minutes', { ...ok, minutes: '5' }],
      ['no reason', { scope: 'all', minutes: 5 }],
      ['short reason', { ...ok, reason: 'ab' }],
      ['unknown scope', { ...ok, scope: 'everyone' }],
      ['extra field', { ...ok, endsAt: at(500) }],
      ['students without ids', { scope: 'students', studentIds: [], minutes: 5, reason: 'A valid reason' }],
      ['201 students', { scope: 'students', studentIds: Array.from({ length: 201 }, () => oid()), minutes: 5, reason: 'A valid reason' }],
      ['operator injection', { scope: 'students', studentIds: [{ $ne: 1 }], minutes: 5, reason: 'A valid reason' }],
      ['ids on the wrong scope', { ...ok, studentIds: [oid()] }],
    ];
    for (const [label, body] of cases) expect((await api('post', l, '/extend', l.t.token, body)).status, label).toBe(400);

    const draftS = await setupSubject();
    const draftT = await mkTeacher(draftS);
    const draft = await quizApi('post', '/', draftT.token, { title: 'Just a draft', subjectId: draftS.subject.id, targets: [{ classId: draftS.cls.id, divisionId: draftS.div.id }] });
    expect((await api('post', { quiz: { id: draft.body.id } }, '/extend', draftT.token, ok)).status).toBe(409);

    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect((await api('post', l, '/extend', other.token, ok)).status).toBe(404);
    for (const token of [tokenFor(ctx, hod), l.student.token]) expect((await api('post', l, '/extend', token, ok)).status).toBe(403);
    // SUPER_ADMIN may extend in an emergency; the audit record says who.
    expect((await api('post', l, '/extend', tokenFor(ctx, admin), ok)).body.extended).toBe(1);
    expect((await AuditLog.findOne({ action: 'quizzes.time_extended', targetId: l.quiz.id, 'summary.role': 'SUPER_ADMIN' }))?.actorId?.toString()).toBe(admin.id);
  });
});

// ================================================================= REOPEN
describe('reopening an attempt', () => {
  const reopen = (l: Live, attemptId: string, token: string, body: object = { minutes: 10, reason: 'Submitted by mistake' }) =>
    request(ctx.app).post(`/api/v1/quizzes/${l.quiz.id}/attempts/${attemptId}/reopen`).set(bearer(token)).send(body);

  it('brings a submitted attempt back with its answers, a new deadline and the old grade kept; it is graded again as a new revision', async () => {
    const l = await liveQuiz();
    const id = await take(l, l.student, ['a', 'a', null]); // 3.5
    expect((await db(id))?.grading).toMatchObject({ status: 'done', score: 3.5, revision: 1 });

    const r = await reopen(l, id, l.t.token);
    expect(r.status).toBe(200);
    expect(r.body.attempt).toMatchObject({ id, status: 'in_progress', endsAt: new Date(T() + 10 * MIN).toISOString() });
    const stored = await db(id);
    expect(stored?.status).toBe('in_progress');
    expect(stored?.submittedAt).toBeUndefined();
    expect(stored?.grading.status).toBe('pending');
    expect(stored?.grading.history?.map((h) => [h.revision, h.score])).toEqual([[1, 3.5]]); // the previous grade is kept
    expect(stored?.extensions[0]).toMatchObject({ minutes: 10, reason: 'Submitted by mistake' });
    expect(await AuditLog.findOne({ action: 'attempts.reopened', targetId: l.quiz.id })).not.toBeNull();

    // The student carries on exactly where they were: answers kept, saves continue, one attempt is still all they have used.
    const resumed = await startReq(l.student.token, l.quiz.id);
    expect(resumed.status).toBe(200);
    expect(resumed.body.attempt.id).toBe(id);
    expect(resumed.body.answers).toHaveLength(2);
    expect((await saveReq(l.student.token, id, { seq: 2, answers: [ans(l.qs[2], 'a')] })).status).toBe(200);

    // While reopened it is not part of the official results, and publication waits.
    const row = ((await api('get', l, '/results', l.t.token)).body.items as Array<{ status: string; score: number | null }>)[0];
    expect(row).toMatchObject({ status: 'in_progress', score: null });
    expect((await submitReq(l.student.token, id)).status).toBe(200);
    const regraded = (await db(id))?.grading;
    expect(regraded).toMatchObject({ status: 'done', score: 4.5, revision: 2 });
    expect(regraded?.history).toHaveLength(1);
    expect(((await api('get', l, '/results', l.t.token)).body.items as Array<{ score: number }>)[0]?.score).toBe(4.5);
  });

  it('also works for an auto-submitted attempt', async () => {
    const l = await liveQuiz();
    const a = await begin(l, l.student);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] });
    await ctx.modules.attempts.finalize(a.attempt.id, 'auto_submitted', new Date(T()));
    expect((await reopen(l, a.attempt.id, l.t.token)).body.attempt.status).toBe('in_progress');
  });

  it('refuses when it is not allowed: running, another attempt running, results published, voided, or not this quiz', async () => {
    const running = await liveQuiz();
    const a = await begin(running, running.student);
    const notFinished = await reopen(running, a.attempt.id, running.t.token);
    expect(notFinished.status).toBe(409);
    expect(notFinished.body.error.message).toMatch(/Only a submitted attempt/);

    const two = await liveQuiz({ maxAttempts: 2 });
    const first = await take(two, two.student, ['a', null, null]);
    await begin(two, two.student); // a second attempt is running
    const clash = await reopen(two, first, two.t.token);
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/already has an attempt in progress/);

    const published = await liveQuiz();
    const pid = await take(published, published.student, ['a', null, null]);
    await quizApi('post', `/${published.quiz.id}/close`, published.t.token, { reason: 'Finished' });
    expect((await api('post', published, '/results/publish', published.t.token)).status).toBe(200);
    const blocked = await reopen(published, pid, published.t.token);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Unpublish/);

    const voided = await liveQuiz();
    const vid = await take(voided, voided.student, ['a', null, null]);
    await Attempt.updateOne({ _id: vid }, { $set: { status: 'invalidated' } });
    expect((await reopen(voided, vid, voided.t.token)).status).toBe(409);

    const elsewhere = await liveQuiz();
    const eid = await take(elsewhere, elsewhere.student, ['a', null, null]);
    expect((await reopen(running, eid, running.t.token)).status).toBe(404); // an attempt of another quiz
    expect((await reopen(running, oid(), running.t.token)).status).toBe(404);
  });

  it('is for the owning teacher only, and needs a valid reason and time', async () => {
    const l = await liveQuiz();
    const id = await take(l, l.student, ['a', null, null]);
    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    expect((await reopen(l, id, other.token)).status).toBe(404);
    for (const token of [tokenFor(ctx, hod), tokenFor(ctx, admin), l.student.token]) expect((await reopen(l, id, token)).status).toBe(403);
    for (const body of [{ minutes: 0, reason: 'A valid reason' }, { minutes: 121, reason: 'A valid reason' }, { minutes: 10 }, { minutes: 10, reason: 'ab' }, { minutes: 10, reason: 'A valid reason', status: 'x' }]) {
      expect((await reopen(l, id, l.t.token, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await db(id))?.status).toBe('submitted'); // nothing changed
  });
});

// ================================================================= EMERGENCY CLOSE
describe('emergency close', () => {
  const close = (l: Live, token: string, body: object = { reason: 'Fire alarm: evacuating the building' }) => api('post', l, '/emergency-close', token, body);

  it('stops new starts and finalizes every running attempt with its last acknowledged answers, exactly once', async () => {
    const l = await liveQuiz();
    const [s2, s3, s4] = [await enrollStudent(l.s), await enrollStudent(l.s), await enrollStudent(l.s)];
    const a1 = await begin(l, l.student);
    const a2 = await begin(l, s2);
    const a3 = await begin(l, s3);
    const finished = await take(l, s4, ['a', 'a', 'a']);
    await saveReq(l.student.token, a1.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] }); // 2
    await saveReq(s3.token, a3.attempt.id, { seq: 1, answers: l.qs.map((q) => ans(q, 'a')) }); // 4.5

    const r = await close(l, l.t.token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ finalized: 3, quizStatus: 'closed' });
    const rows = await Promise.all([a1, a2, a3].map((a) => db(a.attempt.id)));
    expect(rows.map((x) => x?.status)).toEqual(['auto_submitted', 'auto_submitted', 'auto_submitted']);
    expect(rows.map((x) => x?.grading.score)).toEqual([2, 0, 4.5]);
    expect((await db(finished))?.status).toBe('submitted'); // already finished: untouched
    const quiz = await Quiz.findById(l.quiz.id);
    expect(quiz).toMatchObject({ status: 'closed', statusReason: 'Fire alarm: evacuating the building' });

    const late = await enrollStudent(l.s);
    expect((await startReq(late.token, l.quiz.id)).body.error.details.reason).toBe('closed');
    expect((await close(l, l.t.token)).body).toEqual({ finalized: 0, quizStatus: 'closed' }); // idempotent
    expect((await saveReq(l.student.token, a1.attempt.id, { seq: 2, answers: [ans(l.qs[1], 'a')] })).body.error.code).toBe('ATTEMPT_FINISHED');
    expect((await AuditLog.findOne({ action: 'quizzes.emergency_closed', targetId: l.quiz.id, 'summary.finalized': 3 }))?.summary).toMatchObject({ finalized: 3, role: 'TEACHER', reason: 'Fire alarm: evacuating the building' });
  });

  it('works for a paused quiz and for SUPER_ADMIN, and the audit says who', async () => {
    const l = await liveQuiz();
    await begin(l, l.student);
    await quizApi('post', `/${l.quiz.id}/pause`, l.t.token, { reason: 'Fire drill' });
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const r = await close(l, tokenFor(ctx, admin), { reason: 'Building evacuation ordered' });
    expect(r.body).toEqual({ finalized: 1, quizStatus: 'closed' });
    expect(await AuditLog.findOne({ action: 'quizzes.emergency_closed', targetId: l.quiz.id, 'summary.role': 'SUPER_ADMIN' })).not.toBeNull();
  });

  it('keeps what is stored and what is graded identical even if a save races the close', async () => {
    const l = await liveQuiz();
    const a = await begin(l, l.student);
    await Promise.all([saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a'), ans(l.qs[1], 'a')] }), close(l, l.t.token)]);
    const stored = await db(a.attempt.id);
    expect(stored?.status).toBe('auto_submitted');
    const expected = gradeAttempt(l.qs.map((q, i) => ({ questionId: q.id, marks: [2, 1.5, 1][i] ?? 0 })), stored?.answerKey ?? {}, stored?.answers ?? {});
    expect(stored?.grading.score).toBe(expected.score);
  });

  it('needs a reason and the right person, and refuses drafts', async () => {
    const l = await liveQuiz();
    const other = await mkTeacher(l.s);
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: l.s.dept._id });
    expect((await close(l, l.t.token, {})).status).toBe(400);
    expect((await close(l, l.t.token, { reason: 'ab' })).status).toBe(400);
    expect((await close(l, l.t.token, { reason: 'A valid reason', finalize: false })).status).toBe(400);
    expect((await close(l, other.token)).status).toBe(404);
    for (const token of [tokenFor(ctx, hod), l.student.token]) expect((await close(l, token)).status).toBe(403);
    const draftS = await setupSubject();
    const draftT = await mkTeacher(draftS);
    const draft = await quizApi('post', '/', draftT.token, { title: 'Just a draft', subjectId: draftS.subject.id, targets: [{ classId: draftS.cls.id, divisionId: draftS.div.id }] });
    expect((await close({ quiz: { id: draft.body.id } } as Live, draftT.token)).status).toBe(409);
    expect((await Quiz.findById(l.quiz.id))?.status).toBe('published'); // none of the refused calls changed anything
  });
});

// ================================================================= AUDIT LOG VIEWER
describe('the audit log viewer (SUPER_ADMIN)', () => {
  let admin: { user: UserDoc; token: string };
  let quizId: string;
  let teacherId: string;
  beforeAll(async () => {
    const l = await liveQuiz();
    await begin(l, l.student);
    await api('post', l, '/extend', l.t.token, { scope: 'all', minutes: 5, reason: 'Audit viewer fixture' });
    await api('post', l, '/emergency-close', l.t.token, { reason: 'Audit viewer fixture' });
    quizId = l.quiz.id;
    teacherId = l.t.user.id;
    const { user } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    admin = { user, token: tokenFor(ctx, user) };
  });
  const audit = (qs = '', token = admin.token) => request(ctx.app).get(`/api/v1/audit${qs}`).set(bearer(token));

  it('filters by action, prefix, actor, target and date, newest first, with the actor identified', async () => {
    const byPrefix = await audit('?actionPrefix=quizzes.&pageSize=100');
    expect(byPrefix.status).toBe(200);
    const items = byPrefix.body.items as Array<{ at: string; action: string; actor: { id: string; role: string; loginId: string } | null; targetId: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.action.startsWith('quizzes.'))).toBe(true);
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort().reverse()); // newest first

    const forQuiz = await audit(`?targetId=${quizId}&pageSize=100`);
    const actions = (forQuiz.body.items as Array<{ action: string }>).map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['quizzes.created', 'quizzes.published', 'quizzes.time_extended', 'quizzes.emergency_closed']));
    const extended = (forQuiz.body.items as Array<{ action: string; actor: { id: string; role: string; loginId: string }; summary: Record<string, unknown> }>).find((i) => i.action === 'quizzes.time_extended');
    expect(extended?.actor).toMatchObject({ id: teacherId, role: 'TEACHER' });
    expect(extended?.summary).toMatchObject({ minutes: 5, reason: 'Audit viewer fixture' });

    expect((await audit('?action=quizzes.emergency_closed&pageSize=100')).body.items.every((i: { action: string }) => i.action === 'quizzes.emergency_closed')).toBe(true);
    expect((await audit(`?actorId=${teacherId}&pageSize=100`)).body.items.every((i: { actor: { id: string } }) => i.actor.id === teacherId)).toBe(true);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await audit(`?from=${encodeURIComponent(future)}`)).body.total).toBe(0);
    expect((await audit(`?to=${encodeURIComponent(past)}`)).body.total).toBe(0);
    expect((await audit(`?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}&targetId=${quizId}`)).body.total).toBeGreaterThan(0);
  });

  it('treats the prefix as text, not a pattern, and bounds and validates every parameter', async () => {
    expect((await audit('?actionPrefix=.*')).body.total).toBe(0); // "match everything" is just a literal here
    expect((await audit('?actionPrefix=quizzes.&pageSize=2&page=2')).body).toMatchObject({ page: 2, pageSize: 2 });
    for (const bad of ['pageSize=101', 'page=0', 'actorId=nope', 'from=yesterday', 'unknown=1', `from=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 1000).toISOString())}`, 'actionPrefix[$ne]=x']) {
      expect((await audit(`?${bad}`)).status, bad).toBe(400);
    }
  });

  it('is read-only for SUPER_ADMIN only, and holds no secrets', async () => {
    const teacher = await mkTeacher(await setupSubject());
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: (await setupSubject()).dept._id });
    const student = await enrollStudent(await setupSubject());
    for (const token of [teacher.token, tokenFor(ctx, hod), student.token]) expect((await audit('', token)).status).toBe(403);
    expect((await request(ctx.app).get('/api/v1/audit')).status).toBe(401);

    // Append-only: the application has no way to change or delete an entry.
    const some = (await audit('?pageSize=1')).body.items[0] as { id: string };
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(ctx.app)[method]('/api/v1/audit').set(bearer(admin.token)).send({})).status, method).toBe(404);
      expect((await request(ctx.app)[method](`/api/v1/audit/${some.id}`).set(bearer(admin.token)).send({})).status, `${method} /:id`).toBe(404);
    }
    const dump = JSON.stringify((await audit('?pageSize=100')).body);
    for (const secret of ['passwordHash', 'correctOptionId', 'answerKey', 'selectedOptionId', 'tokenHash', 'secretEnc', 'codeHash']) expect(dump).not.toContain(secret);
  });
});

// ================================================================= PERMISSIONS
describe('permission matrix: monitor and recovery', () => {
  const ZERO = '0'.repeat(24);
  type Method = 'get' | 'post';
  interface Endpoint { method: Method; path: string; body?: object; allowed: Role[] }
  const valid = { reason: 'A valid reason' };
  const ENDPOINTS: Endpoint[] = [
    { method: 'get', path: `/quizzes/${ZERO}/monitor`, allowed: ['TEACHER', 'HOD', 'SUPER_ADMIN'] },
    { method: 'post', path: `/quizzes/${ZERO}/extend`, body: { scope: 'all', minutes: 5, ...valid }, allowed: ['TEACHER', 'SUPER_ADMIN'] },
    { method: 'post', path: `/quizzes/${ZERO}/emergency-close`, body: valid, allowed: ['TEACHER', 'SUPER_ADMIN'] },
    { method: 'post', path: `/quizzes/${ZERO}/attempts/${ZERO}/reopen`, body: { minutes: 5, ...valid }, allowed: ['TEACHER'] },
    { method: 'get', path: '/audit', allowed: ['SUPER_ADMIN'] },
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
