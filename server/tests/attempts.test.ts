import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger';
import { AcademicYear, Department, Division, Enrollment, SchoolClass, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { Attempt } from '../src/modules/attempts/attempt.model';
import { AttemptSweeper } from '../src/modules/attempts/attempt.sweeper';
import { gradeAttempt } from '../src/modules/attempts/grading';
import { JobLease } from '../src/modules/jobs/lease.model';
import { Question } from '../src/modules/questions/question.model';
import { ROLES, type Role, type UserDoc } from '../src/modules/users/user.model';
import { bearer, collectKeys, FORBIDDEN_KEYS, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;
const oid = () => new Types.ObjectId().toString();
const at = (minutes: number) => new Date(ctx.clock.now + minutes * 60_000).toISOString();
const GRACE = 15_000; // cfg.examGraceSeconds = 15
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

// ---------------------------------------------------------------- fixtures
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
/** A question with two options; option "a" is the correct one. */
async function mkQuestion(t: { user: UserDoc }, s: S, marks: number) {
  const a = `opt${++n}a`;
  const b = `opt${n}b`;
  const doc = await Question.create({
    collegeId: ctx.collegeId, departmentId: s.dept._id, subjectId: s.subject._id, type: 'mcq', text: uniq('Question '),
    options: [{ optionId: a, text: 'First' }, { optionId: b, text: 'Second' }], correctOptionId: a, marks, status: 'active', createdBy: t.user._id,
  });
  return { id: doc.id as string, a, b };
}
async function enrollStudent(s: S, div = s.div) {
  const { user } = await makeUser(ctx, { role: 'STUDENT' });
  await Enrollment.create({ collegeId: ctx.collegeId, studentId: user._id, academicYearId: s.year._id, departmentId: s.dept._id, classId: s.cls._id, divisionId: div._id, rollNo: uniq('') });
  return { user, token: tokenFor(ctx, user) };
}

const quizApi = (method: 'get' | 'post', path: string, token: string, body?: object) => request(ctx.app)[method](`/api/v1/quizzes${path}`).set(bearer(token)).send(body);
const startReq = (token: string, quizId: string, body?: object) => request(ctx.app).post(`/api/v1/student/quizzes/${quizId}/start`).set(bearer(token)).send(body);
const getReq = (token: string, id: string) => request(ctx.app).get(`/api/v1/student/attempts/${id}`).set(bearer(token));
const saveReq = (token: string, id: string, body: object) => request(ctx.app).put(`/api/v1/student/attempts/${id}/answers`).set(bearer(token)).send(body);
const submitReq = (token: string, id: string, body?: object) => request(ctx.app).post(`/api/v1/student/attempts/${id}/submit`).set(bearer(token)).send(body);
const listReq = (token: string) => request(ctx.app).get('/api/v1/student/quizzes').set(bearer(token));

type Q = Awaited<ReturnType<typeof mkQuestion>>;
interface Live {
  s: S;
  t: Awaited<ReturnType<typeof mkTeacher>>;
  qs: [Q, Q, Q];
  quiz: { id: string; accessCode?: string };
  student: Awaited<ReturnType<typeof enrollStudent>>;
}
/** A published quiz that is open NOW: 3 questions (2 + 1.5 + 1 = 4.5 marks), 30-minute duration, window -10..+120 min. */
async function liveQuiz(over: Record<string, unknown> = {}): Promise<Live> {
  const s = await setupSubject();
  const t = await mkTeacher(s);
  const qs: [Q, Q, Q] = [await mkQuestion(t, s, 2), await mkQuestion(t, s, 1.5), await mkQuestion(t, s, 1)];
  const created = await quizApi('post', '/', t.token, {
    title: 'Unit Test 1', subjectId: s.subject.id, targets: [{ classId: s.cls.id, divisionId: s.div.id }],
    items: qs.map((q) => ({ questionId: q.id })), startAt: at(-10), endAt: at(120), durationMinutes: 30, ...over,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const published = await quizApi('post', `/${created.body.id}/publish`, t.token);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { s, t, qs, quiz: { id: created.body.id as string, accessCode: created.body.accessCode as string | undefined }, student: await enrollStudent(s) };
}
async function begin(l: Live, student = l.student) {
  const res = await startReq(student.token, l.quiz.id, l.quiz.accessCode ? { accessCode: l.quiz.accessCode } : {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { attempt: { id: string; endsAt: string; startedAt: string; lastSeq: number }; questions: Array<{ questionId: string; options: Array<{ optionId: string }> }>; answers: Array<{ questionId: string; selectedOptionId: string }> };
}
const db = (id: string) => Attempt.findById(id).select('+answerKey');
const ans = (q: Q, which: 'a' | 'b' | null) => ({ questionId: q.id, selectedOptionId: which === null ? null : which === 'a' ? q.a : q.b });

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});
beforeEach(() => ctx.store.clear());

// ================================================================= START
describe('starting an attempt', () => {
  it('creates the attempt with a server-side deadline, the quiz questions in order, and no answer key anywhere', async () => {
    const l = await liveQuiz();
    const res = await startReq(l.student.token, l.quiz.id);
    expect(res.status).toBe(201);
    const startedAt = new Date(ctx.clock.now).toISOString();
    expect(res.body.attempt).toMatchObject({ attemptNo: 1, status: 'in_progress', startedAt, endsAt: new Date(ctx.clock.now + 30 * MIN).toISOString(), submittedAt: null, lastSeq: 0 });
    expect(res.body.serverNow).toBe(startedAt);
    expect(res.body.quiz).toMatchObject({ title: 'Unit Test 1', totalMarks: 4.5, questionCount: 3 });
    expect(res.body.answers).toEqual([]);
    expect(res.body.resumed).toBe(false);
    const questions = res.body.questions as Array<{ questionId: string; sequence: number; marks: number; options: Array<Record<string, unknown>> }>;
    expect(questions.map((q) => q.questionId)).toEqual(l.qs.map((q) => q.id));
    expect(questions.map((q) => q.sequence)).toEqual([1, 2, 3]);
    expect(questions.map((q) => q.marks)).toEqual([2, 1.5, 1]);
    expect(questions.every((q) => q.options.every((o) => Object.keys(o).sort().join() === 'optionId,text'))).toBe(true);
    const keys = collectKeys(res.body);
    for (const k of [...FORBIDDEN_KEYS, 'isCorrect', 'score', 'awarded', 'createdBy']) expect(keys.has(k), k).toBe(false);

    // The key lives apart from the student-visible snapshot, and is excluded from default queries.
    const plain = await Attempt.findById(res.body.attempt.id);
    expect(plain?.answerKey).toBeUndefined();
    expect(JSON.stringify(plain?.snapshot)).not.toContain('correct');
    const withKey = await db(res.body.attempt.id);
    expect(withKey?.answerKey).toEqual(Object.fromEntries(l.qs.map((q) => [q.id, q.a])));
    expect(withKey?.grading.status).toBe('pending');
  });

  it('D-11: the deadline is the earlier of start + duration and the end of the window', async () => {
    const l = await liveQuiz({ startAt: at(-30), endAt: at(10), durationMinutes: 30 });
    const res = await startReq(l.student.token, l.quiz.id);
    expect(res.body.attempt.endsAt).toBe(new Date(ctx.clock.now + 10 * MIN).toISOString());
  });

  it('is idempotent: starting again returns the running attempt, even for simultaneous requests', async () => {
    const l = await liveQuiz();
    const first = await startReq(l.student.token, l.quiz.id);
    const again = await startReq(l.student.token, l.quiz.id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ resumed: true });
    expect(again.body.attempt.id).toBe(first.body.attempt.id);

    const other = await enrollStudent(l.s);
    const burst = await Promise.all(Array.from({ length: 6 }, () => startReq(other.token, l.quiz.id)));
    expect(burst.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(burst.map((r) => r.body.attempt.id)).size).toBe(1);
    expect(await Attempt.countDocuments({ quizId: l.quiz.id, studentId: other.user._id })).toBe(1);
  });

  it('refuses ineligible students and hides drafts: all look like "not found"', async () => {
    const l = await liveQuiz();
    const otherDivision = await enrollStudent(l.s, l.s.div2);
    const unenrolled = tokenFor(ctx, (await makeUser(ctx, { role: 'STUDENT' })).user);
    expect((await startReq(otherDivision.token, l.quiz.id)).status).toBe(404);
    expect((await startReq(unenrolled, l.quiz.id)).status).toBe(404);
    expect((await startReq(l.student.token, oid())).status).toBe(404);

    const draft = await quizApi('post', '/', l.t.token, { title: 'Draft quiz', subjectId: l.s.subject.id, targets: [{ classId: l.s.cls.id, divisionId: l.s.div.id }] });
    expect((await startReq(l.student.token, draft.body.id)).status).toBe(404);
    expect((await startReq(l.t.token, l.quiz.id)).status).toBe(403); // a teacher cannot take the quiz
    expect((await request(ctx.app).post(`/api/v1/student/quizzes/${l.quiz.id}/start`)).status).toBe(401);
  });

  it('follows the window exactly: start inclusive, end exclusive; paused and closed block new starts', async () => {
    const l = await liveQuiz({ startAt: at(60), endAt: at(180) });
    const start = Date.parse(at(60));
    const end = Date.parse(at(180));
    const reasonAt = async (ms: number) => {
      const st = await enrollStudent(l.s);
      const r = await atTime(ms, () => startReq(st.token, l.quiz.id));
      return { status: r.status, reason: r.body.error?.details?.reason as string | undefined, code: r.body.error?.code as string | undefined };
    };
    expect(await reasonAt(start - 1)).toEqual({ status: 409, reason: 'not_started', code: 'QUIZ_UNAVAILABLE' });
    expect((await reasonAt(start)).status).toBe(201);
    expect((await reasonAt(end - 1)).status).toBe(201);
    expect(await reasonAt(end)).toEqual({ status: 409, reason: 'ended', code: 'QUIZ_UNAVAILABLE' });

    const live = await liveQuiz();
    await quizApi('post', `/${live.quiz.id}/pause`, live.t.token, { reason: 'Fire drill' });
    expect((await startReq(live.student.token, live.quiz.id)).body.error.details.reason).toBe('paused');
    await quizApi('post', `/${live.quiz.id}/resume`, live.t.token);
    expect((await startReq(live.student.token, live.quiz.id)).status).toBe(201);

    const closed = await liveQuiz();
    await quizApi('post', `/${closed.quiz.id}/close`, closed.t.token, { reason: 'Cancelled' });
    expect((await startReq(closed.student.token, closed.quiz.id)).body.error.details.reason).toBe('closed');
  });

  it('enforces the attempt limit, counts only submitted attempts, and numbers attempts safely', async () => {
    const one = await liveQuiz({ maxAttempts: 1 });
    const a1 = await begin(one);
    expect((await submitReq(one.student.token, a1.attempt.id)).status).toBe(200);
    const blocked = await startReq(one.student.token, one.quiz.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.reason).toBe('no_attempts_left');

    const two = await liveQuiz({ maxAttempts: 2 });
    const first = await begin(two);
    await submitReq(two.student.token, first.attempt.id);
    const second = await startReq(two.student.token, two.quiz.id);
    expect(second.status).toBe(201);
    expect(second.body.attempt.attemptNo).toBe(2);
    await submitReq(two.student.token, second.body.attempt.id);
    expect((await startReq(two.student.token, two.quiz.id)).body.error.details.reason).toBe('no_attempts_left');

    // A voided (invalidated) attempt does not use up an attempt, and the next number never collides.
    const voided = await liveQuiz({ maxAttempts: 1 });
    const v1 = await begin(voided);
    await Attempt.updateOne({ _id: v1.attempt.id }, { $set: { status: 'invalidated' } });
    const v2 = await startReq(voided.student.token, voided.quiz.id);
    expect(v2.status).toBe(201);
    expect(v2.body.attempt.attemptNo).toBe(2);
  });
});

// ================================================================= ACCESS CODE
describe('access code at start', () => {
  it('is required, checked in constant time, and never bypasses the other rules', async () => {
    const l = await liveQuiz({ accessMode: 'code' });
    const code = l.quiz.accessCode ?? '';
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const missing = await startReq(l.student.token, l.quiz.id);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('ACCESS_CODE_REQUIRED');
    const wrong = await startReq(l.student.token, l.quiz.id, { accessCode: 'AAAA-AAAA' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVALID_ACCESS_CODE');
    expect((await Attempt.countDocuments({ quizId: l.quiz.id }))).toBe(0);

    const ok = await startReq(l.student.token, l.quiz.id, { accessCode: code.replace('-', '').toLowerCase() }); // lowercase, no hyphen
    expect(ok.status).toBe(201);

    // The right code does not open a quiz outside its window.
    const future = await liveQuiz({ accessMode: 'both', startAt: at(60), endAt: at(180) });
    const early = await startReq(future.student.token, future.quiz.id, { accessCode: future.quiz.accessCode });
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe('not_started');
  });

  it('locks a student out after repeated wrong guesses, without affecting other students', async () => {
    const l = await liveQuiz({ accessMode: 'code' });
    for (let i = 0; i < 10; i++) expect((await startReq(l.student.token, l.quiz.id, { accessCode: 'ZZZZ-ZZZZ' })).status).toBe(403);
    expect((await startReq(l.student.token, l.quiz.id, { accessCode: l.quiz.accessCode })).status).toBe(429); // even the right code
    const other = await enrollStudent(l.s);
    expect((await startReq(other.token, l.quiz.id, { accessCode: l.quiz.accessCode })).status).toBe(201);
  });

  it('stops accepting a code the moment the teacher regenerates it, and is not needed to resume', async () => {
    const l = await liveQuiz({ accessMode: 'code' });
    const early = await begin(l); // starts with the original code
    const fresh = await quizApi('post', `/${l.quiz.id}/code/regenerate`, l.t.token);
    const newcomer = await enrollStudent(l.s);
    expect((await startReq(newcomer.token, l.quiz.id, { accessCode: l.quiz.accessCode })).status).toBe(403); // old code
    expect((await startReq(newcomer.token, l.quiz.id, { accessCode: fresh.body.accessCode })).status).toBe(201);
    const resumed = await startReq(l.student.token, l.quiz.id); // no code, but already running
    expect(resumed.status).toBe(200);
    expect(resumed.body.attempt.id).toBe(early.attempt.id);
  });
});

// ================================================================= SNAPSHOT
describe('the attempt snapshot (ADR-001)', () => {
  it('keeps the questions and the answer key exactly as the student saw them, whatever happens to the question bank', async () => {
    const l = await liveQuiz();
    const started = await begin(l);
    const [q1, q2, q3] = l.qs;
    await saveReq(l.student.token, started.attempt.id, { seq: 1, answers: [ans(q1, 'a'), ans(q2, 'a'), ans(q3, 'b')] });

    // The teacher rewrites the questions AND flips every key after the student started.
    await Question.updateMany({ _id: { $in: l.qs.map((q) => q.id) } }, { $set: { text: 'CHANGED TEXT', correctOptionId: 'opt0000b', 'options.0.text': 'CHANGED OPTION' } });

    const resumed = await getReq(l.student.token, started.attempt.id);
    expect(JSON.stringify(resumed.body.questions)).not.toContain('CHANGED');
    const done = await submitReq(l.student.token, started.attempt.id);
    expect(done.status).toBe(200);
    const graded = await db(started.attempt.id);
    expect(graded?.grading).toMatchObject({ status: 'done', score: 3.5, totalMarks: 4.5, revision: 1 }); // q1 + q2 right, q3 wrong: original key
    expect(graded?.answerKey).toEqual(Object.fromEntries(l.qs.map((q) => [q.id, q.a])));

    // A student who starts AFTER the edit gets the edited questions (the snapshot is taken at start).
    const later = await enrollStudent(l.s);
    const fresh = await startReq(later.token, l.quiz.id);
    expect(JSON.stringify(fresh.body.questions)).toContain('CHANGED TEXT');
  });
});

// ================================================================= AUTOSAVE
describe('autosave: cumulative and sequence-guarded', () => {
  it('stores the latest acknowledged answers with SERVER time, and resume returns them', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [q1, q2] = l.qs;
    const res = await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(q1, 'a'), ans(q2, 'b')] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, lastSeq: 1, stale: false, endsAt: a.attempt.endsAt });
    const stored = await db(a.attempt.id);
    expect(stored?.lastSeq).toBe(1);
    expect(stored?.answers[q1.id]?.savedAt.getTime()).toBe(ctx.clock.now);

    const resumed = await getReq(l.student.token, a.attempt.id);
    expect(resumed.body.attempt.lastSeq).toBe(1);
    expect(resumed.body.answers).toEqual(expect.arrayContaining([{ questionId: q1.id, selectedOptionId: q1.a }, { questionId: q2.id, selectedOptionId: q2.b }]));
    expect(resumed.body.answers).toHaveLength(2);
  });

  it('the newest answer wins, and null clears an answer', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [q1, q2] = l.qs;
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(q1, 'a'), ans(q2, 'b')] });
    await saveReq(l.student.token, a.attempt.id, { seq: 2, answers: [ans(q1, 'b')] });
    await saveReq(l.student.token, a.attempt.id, { seq: 3, answers: [ans(q1, null)] });
    const answers = (await getReq(l.student.token, a.attempt.id)).body.answers as Array<{ questionId: string }>;
    expect(answers.map((x) => x.questionId)).toEqual([q2.id]);
  });

  it('answers a stale or repeated request with success and changes nothing', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [q1, q2] = l.qs;
    expect((await saveReq(l.student.token, a.attempt.id, { seq: 5, answers: [ans(q1, 'a')] })).body.stale).toBe(false);
    const older = await saveReq(l.student.token, a.attempt.id, { seq: 4, answers: [ans(q1, 'b'), ans(q2, 'b')] });
    expect(older.status).toBe(200);
    expect(older.body).toMatchObject({ ok: true, stale: true, lastSeq: 5 });
    const repeat = await saveReq(l.student.token, a.attempt.id, { seq: 5, answers: [ans(q1, 'b')] });
    expect(repeat.body).toMatchObject({ ok: true, stale: true, lastSeq: 5 });
    const stored = await db(a.attempt.id);
    expect(stored?.answers[q1.id]?.selectedOptionId).toBe(q1.a);
    expect(stored?.answers[q2.id]).toBeUndefined();
  });

  it('loses nothing when cumulative requests arrive out of order', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [q1, q2] = l.qs;
    // Request A (seq 2) carried q1; request B (seq 3) was sent before A was acknowledged, so it carries q1 AND q2.
    const reqA = { seq: 2, answers: [ans(q1, 'a')] };
    const reqB = { seq: 3, answers: [ans(q1, 'a'), ans(q2, 'b')] };
    expect((await saveReq(l.student.token, a.attempt.id, reqB)).body.stale).toBe(false); // B arrives first
    expect((await saveReq(l.student.token, a.attempt.id, reqA)).body.stale).toBe(true); // A arrives late: ignored
    const stored = await db(a.attempt.id);
    expect(stored?.lastSeq).toBe(3);
    expect(stored?.answers[q1.id]?.selectedOptionId).toBe(q1.a);
    expect(stored?.answers[q2.id]?.selectedOptionId).toBe(q2.b);
  });

  it('rejects invalid payloads without applying any part of them', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [q1, q2] = l.qs;
    const other = await mkQuestion(l.t, l.s, 1);
    const cases: Array<[string, object]> = [
      ['unknown question', { seq: 1, answers: [ans(q1, 'a'), { questionId: oid(), selectedOptionId: q1.a }] }],
      ['question of another quiz', { seq: 1, answers: [ans(q1, 'a'), { questionId: other.id, selectedOptionId: other.a }] }],
      ['option of another question', { seq: 1, answers: [ans(q1, 'a'), { questionId: q1.id, selectedOptionId: q2.a }] }],
      ['option that does not exist', { seq: 1, answers: [{ questionId: q1.id, selectedOptionId: 'opt999z' }] }],
      ['duplicate question', { seq: 1, answers: [ans(q1, 'a'), ans(q1, 'b')] }],
      ['seq 0', { seq: 0, answers: [ans(q1, 'a')] }],
      ['seq not an integer', { seq: 1.5, answers: [ans(q1, 'a')] }],
      ['seq too large', { seq: 1_000_001, answers: [ans(q1, 'a')] }],
      ['no answers', { seq: 1, answers: [] }],
      ['option missing', { seq: 1, answers: [{ questionId: q1.id }] }],
      ['client timestamp', { seq: 1, answers: [ans(q1, 'a')], savedAt: '2020-01-01T00:00:00Z' }],
      ['client sets the student', { seq: 1, answers: [ans(q1, 'a')], studentId: oid() }],
      ['client sets the score', { seq: 1, answers: [ans(q1, 'a')], score: 100 }],
      ['201 answers', { seq: 1, answers: Array.from({ length: 201 }, () => ans(q1, 'a')) }],
      ['operator injection', { seq: 1, answers: [{ questionId: { $ne: 1 }, selectedOptionId: null }] }],
    ];
    for (const [label, body] of cases) expect((await saveReq(l.student.token, a.attempt.id, body)).status, label).toBe(400);
    const stored = await db(a.attempt.id);
    expect(stored?.lastSeq).toBe(0);
    expect(stored?.answers).toEqual({});
  });

  it("is private: nobody else's attempt can be read or changed", async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const intruder = await enrollStudent(l.s);
    const body = { seq: 1, answers: [ans(l.qs[0], 'a')] };
    expect((await saveReq(intruder.token, a.attempt.id, body)).status).toBe(404);
    expect((await getReq(intruder.token, a.attempt.id)).status).toBe(404);
    expect((await submitReq(intruder.token, a.attempt.id)).status).toBe(404);
    expect((await saveReq(l.t.token, a.attempt.id, body)).status).toBe(403);
    expect((await saveReq(l.student.token, oid(), body)).status).toBe(404);
    expect((await request(ctx.app).put(`/api/v1/student/attempts/${a.attempt.id}/answers`).send(body)).status).toBe(401);
    expect((await db(a.attempt.id))?.lastSeq).toBe(0);
  });

  it('accepts saves up to endsAt + grace and not a millisecond later: the server then auto-submits what it has', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [q1, q2] = l.qs;
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(q1, 'a')] });
    const endsAt = Date.parse(a.attempt.endsAt);

    const lastChance = await atTime(endsAt + GRACE, () => saveReq(l.student.token, a.attempt.id, { seq: 2, answers: [ans(q2, 'a')] }));
    expect(lastChance.status).toBe(200);

    const tooLate = await atTime(endsAt + GRACE + 1, () => saveReq(l.student.token, a.attempt.id, { seq: 3, answers: [ans(l.qs[2], 'a')] }));
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.code).toBe('TIME_UP');
    const stored = await db(a.attempt.id);
    expect(stored?.status).toBe('auto_submitted');
    expect(stored?.submittedAt?.getTime()).toBe(endsAt + GRACE + 1);
    expect(stored?.answers[l.qs[2].id]).toBeUndefined(); // the late answer was NOT accepted
    expect(stored?.grading).toMatchObject({ status: 'done', score: 3.5, revision: 1 }); // q1 (2) + q2 (1.5)

    const after = await saveReq(l.student.token, a.attempt.id, { seq: 4, answers: [ans(q1, 'b')] });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('ATTEMPT_FINISHED');
  });

  it('keeps working for a running attempt after the teacher pauses or closes the quiz', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await quizApi('post', `/${l.quiz.id}/pause`, l.t.token, { reason: 'Fire drill' });
    expect((await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] })).status).toBe(200);
    await quizApi('post', `/${l.quiz.id}/close`, l.t.token, { reason: 'Cancelled' });
    expect((await saveReq(l.student.token, a.attempt.id, { seq: 2, answers: [ans(l.qs[1], 'a')] })).status).toBe(200);
    expect((await submitReq(l.student.token, a.attempt.id)).body.attempt.status).toBe('submitted');
  });

  it('limits each student to 90 autosaves a minute (per user, not per IP)', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    for (let seq = 1; seq <= 90; seq++) {
      const r = await saveReq(l.student.token, a.attempt.id, { seq, answers: [ans(l.qs[0], seq % 2 === 0 ? 'a' : 'b')] });
      expect(r.status, `save ${seq}`).toBe(200);
    }
    expect((await saveReq(l.student.token, a.attempt.id, { seq: 91, answers: [ans(l.qs[0], 'a')] })).status).toBe(429);
    const neighbour = await enrollStudent(l.s); // another student on the same network is unaffected
    expect((await startReq(neighbour.token, l.quiz.id)).status).toBe(201);
  });
});

// ================================================================= RESUME
describe('resuming', () => {
  it('returns the same questions, the latest answers and the server clock after a refresh', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] });
    await atTime(ctx.clock.now + 5 * MIN, async () => {
      const r1 = await getReq(l.student.token, a.attempt.id);
      const r2 = await getReq(l.student.token, a.attempt.id);
      expect(r1.status).toBe(200);
      expect(r1.body.serverNow).toBe(new Date(ctx.clock.now).toISOString());
      expect(r1.body.questions.map((q: { questionId: string }) => q.questionId)).toEqual(l.qs.map((q) => q.id));
      expect(r1.body.answers).toEqual([{ questionId: l.qs[0].id, selectedOptionId: l.qs[0].a }]);
      expect(r2.body).toEqual(r1.body);
    });
  });

  it('closes an expired attempt when it is touched, and then shows only its final status', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] });
    const res = await atTime(Date.parse(a.attempt.endsAt) + GRACE + 1, () => getReq(l.student.token, a.attempt.id));
    expect(res.status).toBe(200);
    expect(res.body.attempt.status).toBe('auto_submitted');
    expect(res.body.questions).toBeUndefined();
    expect(res.body.answers).toBeUndefined();
    expect((await db(a.attempt.id))?.grading).toMatchObject({ status: 'done', score: 2 });

    // Starting again after expiry is a normal start decision (here: one attempt only, so refused).
    expect((await startReq(l.student.token, l.quiz.id)).status).toBe(409);
  });
});

// ================================================================= SUBMIT
describe('submitting', () => {
  it('finalizes, grades on the server, and tells the student nothing about the score', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a'), ans(l.qs[1], 'b')] });
    const res = await submitReq(l.student.token, a.attempt.id);
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({ status: 'submitted', submittedAt: new Date(ctx.clock.now).toISOString() });
    expect(res.body.lateRejected).toBe(false);
    const keys = collectKeys(res.body);
    for (const k of [...FORBIDDEN_KEYS, 'score', 'awarded', 'questions', 'answers']) expect(keys.has(k), k).toBe(false);

    const graded = await db(a.attempt.id);
    expect(graded?.grading).toMatchObject({ status: 'done', score: 2, totalMarks: 4.5, revision: 1 });
    expect(graded?.grading.items?.map((i) => [i.awarded, i.answered, i.correct])).toEqual([[2, true, true], [0, true, false], [0, false, false]]);
  });

  it('can carry the final cumulative answers, which are applied before finalizing', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'b')] });
    const res = await submitReq(l.student.token, a.attempt.id, { seq: 2, answers: [ans(l.qs[0], 'a'), ans(l.qs[2], 'a')] });
    expect(res.status).toBe(200);
    expect((await db(a.attempt.id))?.grading).toMatchObject({ score: 3 }); // q1 (2) + q3 (1)
    for (const [label, body] of [['seq alone', { seq: 3 }], ['answers alone', { answers: [] }], ['extra field', { score: 10 }]] as Array<[string, object]>) {
      expect((await submitReq((await enrollStudent(l.s)).token, oid(), body)).status, label).toBe(400);
    }
  });

  it('is idempotent: repeating it returns the same final state and does not grade again', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const first = await submitReq(l.student.token, a.attempt.id);
    const gradedAt = (await db(a.attempt.id))?.grading.gradedAt;
    const second = await atTime(ctx.clock.now + MIN, () => submitReq(l.student.token, a.attempt.id));
    expect(second.status).toBe(200);
    expect(second.body.attempt).toEqual(first.body.attempt);
    const after = await db(a.attempt.id);
    expect(after?.grading.revision).toBe(1);
    expect(after?.grading.gradedAt).toEqual(gradedAt);
  });

  it('survives double-clicks and two tabs: simultaneous submits converge on one result', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] });
    const results = await Promise.all(Array.from({ length: 6 }, () => submitReq(l.student.token, a.attempt.id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.attempt.status))).toEqual(new Set(['submitted']));
    expect(new Set(results.map((r) => r.body.attempt.submittedAt)).size).toBe(1);
    expect(results.some((r) => r.body.lateRejected)).toBe(false);
    const stored = await db(a.attempt.id);
    expect(stored?.grading).toMatchObject({ status: 'done', score: 2, revision: 1 });
  });

  it('never grades answers that differ from what is stored, even if a save races the submit', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    const [r1, r2] = await Promise.all([
      saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a'), ans(l.qs[1], 'a')] }),
      submitReq(l.student.token, a.attempt.id),
    ]);
    expect([200, 409]).toContain(r1.status); // the save either landed first or was refused as finished
    expect(r2.status).toBe(200);
    const stored = await db(a.attempt.id);
    const expected = gradeAttempt(
      l.qs.map((q) => ({ questionId: q.id, marks: q.id === l.qs[0].id ? 2 : q.id === l.qs[1].id ? 1.5 : 1 })),
      stored?.answerKey ?? {},
      stored?.answers ?? {},
    );
    expect(stored?.grading.score).toBe(expected.score); // the grade always matches exactly what was stored at finalization
  });

  it('blocks everything after submit, and shows only the final status on resume', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await submitReq(l.student.token, a.attempt.id);
    const save = await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a')] });
    expect(save.status).toBe(409);
    expect(save.body.error.code).toBe('ATTEMPT_FINISHED');
    const view = await getReq(l.student.token, a.attempt.id);
    expect(view.body.attempt.status).toBe('submitted');
    expect(view.body.questions).toBeUndefined();
  });

  it('honours a submit made exactly at endsAt + grace, and treats a later one as an auto-submit with the last saved answers', async () => {
    const onTime = await liveQuiz();
    const a = await begin(onTime);
    const endsAt = Date.parse(a.attempt.endsAt);
    const ok = await atTime(endsAt + GRACE, () => submitReq(onTime.student.token, a.attempt.id, { seq: 1, answers: [ans(onTime.qs[0], 'a')] }));
    expect(ok.body).toMatchObject({ attempt: { status: 'submitted' }, lateRejected: false });
    expect((await db(a.attempt.id))?.grading.score).toBe(2);

    const tooLate = await liveQuiz();
    const b = await begin(tooLate);
    await saveReq(tooLate.student.token, b.attempt.id, { seq: 1, answers: [ans(tooLate.qs[1], 'a')] });
    const late = await atTime(Date.parse(b.attempt.endsAt) + GRACE + 1, () => submitReq(tooLate.student.token, b.attempt.id, { seq: 2, answers: [ans(tooLate.qs[0], 'a')] }));
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ attempt: { status: 'auto_submitted' }, lateRejected: true });
    const stored = await db(b.attempt.id);
    expect(stored?.answers[tooLate.qs[0].id]).toBeUndefined(); // the late payload was ignored
    expect(stored?.grading.score).toBe(1.5); // only the earlier acknowledged answer counts
  });
});

// ================================================================= SWEEPER
describe('the deadline sweeper', () => {
  // The sweeper is global: close everything left running by the tests above so the counts below are exact.
  beforeAll(async () => {
    await atTime(ctx.clock.now + 400 * 24 * 60 * MIN, async () => {
      while ((await ctx.modules.attempts.finalizeExpired({ limit: 1000 })) > 0) {
        /* keep closing */
      }
    });
  });

  const sweeperWith = (batchSize?: number) => new AttemptSweeper({ attempts: ctx.modules.attempts, logger: createLogger('silent'), batchSize, now: () => new Date(ctx.clock.now) });

  async function threeAbandoned() {
    const l = await liveQuiz();
    const students = [l.student, await enrollStudent(l.s), await enrollStudent(l.s)];
    const attempts = [await begin(l, students[0]), await begin(l, students[1]), await begin(l, students[2])];
    await saveReq(students[0]?.token ?? '', attempts[0]?.attempt.id ?? '', { seq: 1, answers: [ans(l.qs[0], 'a')] }); // 2 marks
    await saveReq(students[2]?.token ?? '', attempts[2]?.attempt.id ?? '', { seq: 1, answers: l.qs.map((q) => ans(q, 'a')) }); // 4.5 marks
    return { l, students, ids: attempts.map((a) => a.attempt.id), endsAt: Date.parse(attempts[0]?.attempt.endsAt ?? '') };
  }

  it('finalizes abandoned attempts with their last acknowledged answers, exactly once, and respects the grace boundary', async () => {
    const { ids, endsAt } = await threeAbandoned();
    const sweeper = sweeperWith();

    const early = await atTime(endsAt + GRACE, () => sweeper.runOnce({ ignoreLease: true }));
    expect(early.finalized).toBe(0); // exactly at the grace limit: still open
    expect((await Attempt.findById(ids[0]))?.status).toBe('in_progress');

    const swept = await atTime(endsAt + GRACE + 1, () => sweeper.runOnce({ ignoreLease: true }));
    expect(swept).toMatchObject({ skipped: false, finalized: 3 });
    const rows = await Promise.all(ids.map((id) => db(id)));
    expect(rows.map((r) => r?.status)).toEqual(['auto_submitted', 'auto_submitted', 'auto_submitted']);
    expect(rows.map((r) => r?.grading.score)).toEqual([2, 0, 4.5]);
    expect(rows.every((r) => r?.grading.status === 'done' && r.grading.revision === 1)).toBe(true);

    const again = await atTime(endsAt + GRACE + 2, () => sweeper.runOnce({ ignoreLease: true }));
    expect(again.finalized).toBe(0); // idempotent
  });

  it('leaves attempts that are still running alone', async () => {
    const { l, ids, endsAt } = await threeAbandoned();
    const late = await enrollStudent(l.s);
    const running = await atTime(endsAt - 10 * MIN, () => startReq(late.token, l.quiz.id)); // started later: its deadline is later
    const swept = await atTime(endsAt + GRACE + 1, () => sweeperWith().runOnce({ ignoreLease: true }));
    expect(swept.finalized).toBe(3);
    expect((await Attempt.findById(running.body.attempt.id))?.status).toBe('in_progress');
    expect(ids).toHaveLength(3);
  });

  it('works in bounded batches', async () => {
    const { ids, endsAt } = await threeAbandoned();
    const sweeper = sweeperWith(2);
    const t = endsAt + GRACE + 1;
    expect((await atTime(t, () => sweeper.runOnce({ ignoreLease: true }))).finalized).toBe(2);
    expect((await atTime(t, () => sweeper.runOnce({ ignoreLease: true }))).finalized).toBe(1);
    expect((await atTime(t, () => sweeper.runOnce({ ignoreLease: true }))).finalized).toBe(0);
    expect((await Promise.all(ids.map((id) => Attempt.findById(id)))).every((a) => a?.status === 'auto_submitted')).toBe(true);
  });

  it('tolerates two sweepers running at the same moment: every attempt is finalized and graded once', async () => {
    const { ids, endsAt } = await threeAbandoned();
    await atTime(endsAt + GRACE + 1, () => Promise.all([sweeperWith().runOnce({ ignoreLease: true }), sweeperWith().runOnce({ ignoreLease: true })]));
    const rows = await Promise.all(ids.map((id) => db(id)));
    expect(rows.map((r) => r?.status)).toEqual(['auto_submitted', 'auto_submitted', 'auto_submitted']);
    expect(rows.map((r) => r?.grading.score)).toEqual([2, 0, 4.5]);
    expect(rows.every((r) => r?.grading.revision === 1 && r.grading.status === 'done')).toBe(true);
  });

  it('uses a database lease so only one instance runs per round, and takes it again when it expires', async () => {
    await JobLease.deleteMany({});
    const a = sweeperWith();
    const b = sweeperWith();
    expect((await a.runOnce()).skipped).toBe(false);
    expect((await b.runOnce()).skipped).toBe(true); // lease held
    await atTime(ctx.clock.now + 26_000, async () => {
      expect((await b.runOnce()).skipped).toBe(false); // 25 s lease expired
    });
  });

  it('also grades attempts that were closed but never graded (a crash between the two steps)', async () => {
    const l = await liveQuiz();
    const a = await begin(l);
    await saveReq(l.student.token, a.attempt.id, { seq: 1, answers: [ans(l.qs[0], 'a'), ans(l.qs[2], 'a')] });
    await Attempt.updateOne({ _id: a.attempt.id }, { $set: { status: 'submitted', submittedAt: new Date(ctx.clock.now) } }); // flipped, never graded
    expect((await db(a.attempt.id))?.grading.status).toBe('pending');
    const res = await sweeperWith().runOnce({ ignoreLease: true });
    expect(res.graded).toBeGreaterThanOrEqual(1);
    expect((await db(a.attempt.id))?.grading).toMatchObject({ status: 'done', score: 3, revision: 1 });
  });

  it("lets a teacher's \"finalize expired attempts\" action close only that quiz's overdue attempts", async () => {
    const mine = await threeAbandoned();
    const other = await threeAbandoned();
    const count = await atTime(mine.endsAt + GRACE + 1, () => ctx.modules.attempts.finalizeExpired({ quizId: mine.l.quiz.id }));
    expect(count).toBe(3);
    expect((await Attempt.findById(mine.ids[0]))?.status).toBe('auto_submitted');
    expect((await Attempt.findById(other.ids[0]))?.status).toBe('in_progress');
  });
});

// ================================================================= LOOKUP + QUIZ LIST
describe('attempts in the quiz list and the quiz rules', () => {
  it('shows the running attempt to resume, counts only finished ones, and blocks unpublishing once someone started', async () => {
    const l = await liveQuiz({ maxAttempts: 1 });
    const row = async () => ((await listReq(l.student.token)).body.items as Array<Record<string, unknown>>).find((q) => q.id === l.quiz.id) as Record<string, unknown>;
    expect(await row()).toMatchObject({ activeAttemptId: null, attemptsUsed: 0, available: true });

    const a = await begin(l);
    expect(await row()).toMatchObject({ activeAttemptId: a.attempt.id, attemptsUsed: 0 }); // in progress: not yet counted

    const blocked = await quizApi('post', `/${l.quiz.id}/unpublish`, l.t.token, { reason: 'Fix a typo' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already started/);

    await quizApi('post', `/${l.quiz.id}/pause`, l.t.token, { reason: 'Fire drill' });
    expect(await row()).toMatchObject({ available: false, reason: 'paused', activeAttemptId: a.attempt.id }); // can still resume
    expect((await startReq(l.student.token, l.quiz.id)).status).toBe(200);

    await submitReq(l.student.token, a.attempt.id);
    expect(await row()).toMatchObject({ activeAttemptId: null, attemptsUsed: 1, attemptsLeft: 0 });
  });
});

// ================================================================= BACKGROUND JOBS WAIT FOR EXAMS
describe('imports wait while an exam is running', () => {
  it('holds the import worker during an exam window and releases it afterwards', async () => {
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const s = await setupSubject();
    const csv = `loginId,name,rollNo,departmentCode,classCode,divisionName\npaused${++n}x,Wait Student,1,${s.dept.code},${s.cls.code},A`;
    const up = await request(ctx.app).post(`/api/v1/imports/students?academicYearId=${s.year.id}`).set(bearer(tokenFor(ctx, admin))).set('Content-Type', 'text/csv').send(csv);
    expect(up.status).toBe(201);
    const jobId: string = up.body.job.id;
    await request(ctx.app).post(`/api/v1/imports/${jobId}/confirm`).set(bearer(tokenFor(ctx, admin))).send({});

    // Several live quizzes and running attempts exist from the tests above.
    expect(await ctx.modules.attempts.examWindowOpen()).toBe(true);
    await ctx.modules.importWorker.drain();
    expect((await request(ctx.app).get(`/api/v1/imports/${jobId}`).set(bearer(tokenFor(ctx, admin)))).body.status).toBe('queued');

    // Far in the future every window is over; close what is left, and the worker is released.
    const farFuture = ctx.clock.now + 400 * 24 * 60 * MIN;
    await atTime(farFuture, async () => {
      while ((await ctx.modules.attempts.finalizeExpired({ limit: 1000 })) > 0) {
        /* keep closing */
      }
      expect(await ctx.modules.attempts.examWindowOpen()).toBe(false);
      await ctx.modules.importWorker.drain();
    });
    expect((await request(ctx.app).get(`/api/v1/imports/${jobId}`).set(bearer(tokenFor(ctx, admin)))).body.status).toBe('completed');
  });
});

// ================================================================= NOTHING LEAKS
describe('student exam responses never contain secrets', () => {
  it('scans every success and error response for keys, scores and grading data', async () => {
    const l = await liveQuiz({ accessMode: 'code' });
    const forbidden = [...FORBIDDEN_KEYS, 'score', 'awarded', 'isCorrect', 'correct', 'createdBy', 'codeHash', 'accessCode'];
    const bodies: unknown[] = [];
    const collect = (r: { body: unknown }) => bodies.push(r.body);

    collect(await startReq(l.student.token, l.quiz.id)); // 403: code required
    collect(await startReq(l.student.token, l.quiz.id, { accessCode: 'AAAA-AAAA' })); // 403: wrong code
    const started = await startReq(l.student.token, l.quiz.id, { accessCode: l.quiz.accessCode });
    collect(started);
    collect(await startReq(l.student.token, l.quiz.id)); // resumed
    const id = started.body.attempt.id as string;
    collect(await getReq(l.student.token, id));
    collect(await saveReq(l.student.token, id, { seq: 1, answers: [ans(l.qs[0], 'a')] }));
    collect(await saveReq(l.student.token, id, { seq: 1, answers: [ans(l.qs[0], 'a')] })); // stale
    collect(await saveReq(l.student.token, id, { seq: 2, answers: [{ questionId: oid(), selectedOptionId: null }] })); // 400
    collect(await getReq(l.student.token, oid())); // 404
    collect(await submitReq(l.student.token, id));
    collect(await submitReq(l.student.token, id)); // repeat
    collect(await saveReq(l.student.token, id, { seq: 3, answers: [ans(l.qs[0], 'a')] })); // 409 finished
    collect(await getReq(l.student.token, id)); // final status
    collect(await startReq(l.student.token, l.quiz.id, { accessCode: l.quiz.accessCode })); // 409 no attempts

    expect(bodies).toHaveLength(14);
    for (const body of bodies) {
      const keys = collectKeys(body);
      for (const k of forbidden) expect(keys.has(k), `${k} in ${JSON.stringify(body).slice(0, 120)}`).toBe(false);
    }
    expect(JSON.stringify(bodies)).not.toContain(l.quiz.accessCode ?? 'x');
  });
});

// ================================================================= PERMISSIONS
describe('permission matrix: student exam endpoints', () => {
  const ZERO = '0'.repeat(24);
  const endpoints: Array<{ label: string; call: (token: string) => Promise<{ status: number }>; unauth: () => Promise<{ status: number }> }> = [
    { label: 'POST /student/quizzes/:id/start', call: (t) => startReq(t, ZERO), unauth: () => request(ctx.app).post(`/api/v1/student/quizzes/${ZERO}/start`) },
    { label: 'GET /student/attempts/:id', call: (t) => getReq(t, ZERO), unauth: () => request(ctx.app).get(`/api/v1/student/attempts/${ZERO}`) },
    { label: 'PUT /student/attempts/:id/answers', call: (t) => saveReq(t, ZERO, { seq: 1, answers: [{ questionId: ZERO, selectedOptionId: null }] }), unauth: () => request(ctx.app).put(`/api/v1/student/attempts/${ZERO}/answers`).send({}) },
    { label: 'POST /student/attempts/:id/submit', call: (t) => submitReq(t, ZERO), unauth: () => request(ctx.app).post(`/api/v1/student/attempts/${ZERO}/submit`) },
  ];
  let deptId: Types.ObjectId;
  beforeAll(async () => {
    deptId = (await setupSubject()).dept._id;
  });
  for (const ep of endpoints) {
    describe(ep.label, () => {
      it('401 without a token', async () => expect((await ep.unauth()).status).toBe(401));
      for (const role of ROLES as readonly Role[]) {
        it(`${role}: ${role === 'STUDENT' ? 'allowed (404 for an unknown id)' : '403'}`, async () => {
          const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD', ...(role === 'HOD' ? { departmentId: deptId } : {}) });
          const res = await ep.call(tokenFor(ctx, user));
          if (role === 'STUDENT') expect(res.status).toBe(404);
          else expect(res.status).toBe(403);
        });
      }
    });
  }
});
