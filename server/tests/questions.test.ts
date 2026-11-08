import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcademicYear, Department, Division, SchoolClass, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { toStudentQuestionDto } from '../src/modules/questions/question.dto';
import { Question } from '../src/modules/questions/question.model';
import { ROLES, type Role, type UserDoc } from '../src/modules/users/user.model';
import { bearer, collectKeys, FORBIDDEN_KEYS, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;
const oid = () => new Types.ObjectId().toString();

type Method = 'get' | 'post' | 'patch';
const api = (method: Method, path: string, token: string, body?: object) =>
  request(ctx.app)[method](`/api/v1/questions${path}`).set(bearer(token)).send(body);

type S = Awaited<ReturnType<typeof setupSubject>>;
async function setupSubject() {
  const collegeId = ctx.collegeId;
  const dept = await Department.create({ collegeId, name: 'Science', code: uniq('SC') });
  const year = await AcademicYear.create({ collegeId, label: uniq('AY'), startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31'), isCurrent: false });
  const cls = await SchoolClass.create({ collegeId, departmentId: dept._id, academicYearId: year._id, name: 'FY', code: uniq('FY') });
  const div = await Division.create({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: 'A' });
  const subject = await Subject.create({ collegeId, departmentId: dept._id, name: 'Biology', code: uniq('BIO') });
  return { dept, year, cls, div, subject };
}
async function assign(teacher: UserDoc, s: S) {
  return TeachingAssignment.create({ collegeId: ctx.collegeId, teacherId: teacher._id, subjectId: s.subject._id, departmentId: s.dept._id, academicYearId: s.year._id, classId: s.cls._id, divisionId: s.div._id, active: true });
}
async function mkTeacher(...subjects: S[]) {
  const first = subjects[0];
  const { user } = await makeUser(ctx, { role: 'TEACHER', ...(first ? { departmentId: first.dept._id } : {}) });
  for (const s of subjects) await assign(user, s);
  return { user, token: tokenFor(ctx, user) };
}

const mcq = (s: S, over: Record<string, unknown> = {}) => ({
  type: 'mcq',
  subjectId: s.subject.id,
  topic: 'Basics',
  text: 'Capital of India?',
  options: [{ text: 'Mumbai' }, { text: 'New Delhi', correct: true }, { text: 'Kolkata' }, { text: 'Chennai' }],
  marks: 2,
  difficulty: 'easy',
  ...over,
});
const tf = (s: S, over: Record<string, unknown> = {}) => ({ type: 'true_false', subjectId: s.subject.id, text: 'The sun rises in the east.', correct: true, marks: 1, ...over });

interface Opt { optionId: string; text: string }
interface Q { id: string; options: Opt[]; correctOptionId: string; revision: number; [k: string]: unknown }
async function createQ(token: string, body: object): Promise<Q> {
  const res = await api('post', '/', token, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Q;
}

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});

describe('creating questions', () => {
  it('creates an MCQ with server-assigned option ids, keeps the key out of default queries, and audits without secrets', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    expect(q).toMatchObject({ type: 'mcq', revision: 1, mine: true, status: 'active', marks: 2, difficulty: 'easy', topic: 'Basics', departmentId: s.dept.id });
    expect(q.options).toHaveLength(4);
    expect(q.options.every((o) => /^o_[0-9a-f]{10}$/.test(o.optionId))).toBe(true);
    expect(q.options.find((o) => o.optionId === q.correctOptionId)?.text).toBe('New Delhi');

    // The key is protected at the schema level: a plain query never returns it.
    expect((await Question.findById(q.id))?.correctOptionId).toBeUndefined();
    expect((await Question.findById(q.id).select('+correctOptionId'))?.correctOptionId).toBe(q.correctOptionId);

    const audits = await AuditLog.find({ action: /^questions\./ }).lean();
    const dump = JSON.stringify(audits);
    expect(audits.some((a) => a.action === 'questions.created' && a.targetId === q.id)).toBe(true);
    expect(dump).not.toContain(q.correctOptionId);
    expect(dump).not.toContain('Capital of India');
  });

  it('creates True/False with fixed options and a correct mapping', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const yes = await createQ(t.token, tf(s, { correct: true }));
    expect(yes.options.map((o) => o.text)).toEqual(['True', 'False']);
    expect(yes.correctOptionId).toBe(yes.options[0]?.optionId);
    const no = await createQ(t.token, tf(s, { correct: false }));
    expect(no.correctOptionId).toBe(no.options[1]?.optionId);
  });

  it('stores Marathi/Hindi text exactly', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s, { text: 'भारताची राजधानी कोणती?', options: [{ text: 'मुंबई' }, { text: 'नवी दिल्ली', correct: true }] }));
    const fetched = await api('get', `/${q.id}`, t.token);
    expect(fetched.body.text).toBe('भारताची राजधानी कोणती?');
    expect((fetched.body.options as Opt[]).map((o) => o.text)).toEqual(['मुंबई', 'नवी दिल्ली']);
  });

  it('rejects every kind of invalid payload', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const noType: Record<string, unknown> = { ...mcq(s) };
    delete noType.type;
    const bodies: Array<[string, object]> = [
      ['no correct option', mcq(s, { options: [{ text: 'A' }, { text: 'B' }] })],
      ['two correct options', mcq(s, { options: [{ text: 'A', correct: true }, { text: 'B', correct: true }] })],
      ['one option only', mcq(s, { options: [{ text: 'A', correct: true }] })],
      ['seven options', mcq(s, { options: Array.from({ length: 7 }, (_, i) => ({ text: `Option ${i}`, correct: i === 0 })) })],
      ['duplicate option text', mcq(s, { options: [{ text: 'Same', correct: true }, { text: '  same ' }] })],
      ['blank text', mcq(s, { text: '   ' })],
      ['text too long', mcq(s, { text: 'x'.repeat(2001) })],
      ['zero marks', mcq(s, { marks: 0 })],
      ['negative marks', mcq(s, { marks: -1 })],
      ['marks over 100', mcq(s, { marks: 101 })],
      ['three decimals', mcq(s, { marks: 1.234 })],
      ['marks as string', mcq(s, { marks: '2' })],
      ['bad difficulty', mcq(s, { difficulty: 'impossible' })],
      ['unknown type', mcq(s, { type: 'essay' })],
      ['missing type', noType],
      ['control characters', mcq(s, { text: 'bad\u0000text' })],
      ['client sets createdBy', mcq(s, { createdBy: oid() })],
      ['client sets status', mcq(s, { status: 'archived' })],
      ['client sets the key', mcq(s, { correctOptionId: 'o_abcdef' })],
      ['client sets collegeId', mcq(s, { collegeId: oid() })],
      ['client sets departmentId', mcq(s, { departmentId: oid() })],
      ['option id on create', mcq(s, { options: [{ id: 'o_abcdef', text: 'A', correct: true }, { text: 'B' }] })],
      ['true/false with options', tf(s, { options: [] })],
      ['true/false correct not boolean', tf(s, { correct: 'yes' })],
      ['bad subject id', mcq(s, { subjectId: 'nope' })],
      ['operator injection', mcq(s, { subjectId: { $ne: null } })],
    ];
    for (const [label, body] of bodies) {
      expect((await api('post', '/', t.token, body)).status, label).toBe(400);
    }
    expect(await Question.countDocuments({ subjectId: s.subject._id })).toBe(0);
  });
});

describe('scope and ownership', () => {
  it('limits teachers to their assigned subjects without revealing what exists elsewhere', async () => {
    const s1 = await setupSubject();
    const s2 = await setupSubject();
    const a = await mkTeacher(s1);
    const b = await mkTeacher(s2);
    const none = await mkTeacher();
    const q1 = await createQ(a.token, mcq(s1));
    await createQ(b.token, mcq(s2));

    // Cannot create in an unassigned subject; unassigned and non-existent look identical.
    expect((await api('post', '/', b.token, mcq(s1))).status).toBe(403);
    expect((await api('post', '/', none.token, mcq(s1))).status).toBe(403);
    expect((await api('post', '/', a.token, mcq(s1, { subjectId: oid() }))).status).toBe(403);

    // Cannot see, edit or archive another subject's question: 404.
    expect((await api('get', `/${q1.id}`, b.token)).status).toBe(404);
    expect((await api('patch', `/${q1.id}`, b.token, { revision: 1, text: 'Hijack' })).status).toBe(404);
    expect((await api('post', `/${q1.id}/archive`, b.token)).status).toBe(404);

    const listB = await api('get', '/?pageSize=100', b.token);
    expect((listB.body.items as Array<{ subjectId: string }>).every((x) => x.subjectId === s2.subject.id)).toBe(true);
    expect((await api('get', '/', none.token)).body.total).toBe(0);
    expect((await api('get', `/?subjectId=${s2.subject.id}`, a.token)).body.total).toBe(0); // filter outside scope
  });

  it('keeps each teacher\'s bank private, even for a colleague teaching the same subject', async () => {
    const s = await setupSubject();
    const author = await mkTeacher(s);
    const colleague = await mkTeacher(s);
    const q = await createQ(author.token, mcq(s));
    const theirs = await createQ(colleague.token, mcq(s, { text: 'Colleague question' }));

    // The colleague cannot see, edit, archive or restore it: indistinguishable from a question that does not exist.
    expect((await api('get', `/${q.id}`, colleague.token)).status).toBe(404);
    expect((await api('patch', `/${q.id}`, colleague.token, { revision: 1, text: 'Nope' })).status).toBe(404);
    expect((await api('post', `/${q.id}/archive`, colleague.token)).status).toBe(404);
    expect((await api('post', `/${q.id}/restore`, colleague.token)).status).toBe(404);
    expect((await api('get', `/${oid()}`, colleague.token)).status).toBe(404);

    // Lists contain only the caller's own questions (the `mine` flag changes nothing for teachers).
    for (const qs of ['', '?mine=true', '?mine=false']) {
      const own = await api('get', `/${qs}${qs ? '&' : '?'}pageSize=100&subjectId=${s.subject.id}`, colleague.token);
      expect((own.body.items as Q[]).map((x) => x.id)).toEqual([theirs.id]);
    }
    expect(((await api('get', '/?pageSize=100', author.token)).body.items as Q[]).some((x) => x.id === theirs.id)).toBe(false);
    expect((await api('get', `/?q=${encodeURIComponent('Colleague question')}`, author.token)).body.total).toBe(0);

    // The author is unaffected, and the question was never modified by the colleague's attempts.
    expect((await api('get', `/${q.id}`, author.token)).body).toMatchObject({ mine: true, revision: 1, correctOptionId: q.correctOptionId });
    expect((await Question.findById(q.id))?.status).toBe('active');

    // SUPER_ADMIN support access still sees both (audited).
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const all = await api('get', `/?pageSize=100&subjectId=${s.subject.id}`, tokenFor(ctx, admin));
    expect((all.body.items as Q[]).map((x) => x.id).sort()).toEqual([q.id, theirs.id].sort());
  });

  it('removes access immediately when a teaching assignment is revoked', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    expect((await api('get', `/${q.id}`, t.token)).status).toBe(200);
    expect((await api('get', '/my-subjects', t.token)).body.items).toHaveLength(1);

    await TeachingAssignment.updateMany({ teacherId: t.user._id }, { $set: { active: false } });
    expect((await api('get', `/${q.id}`, t.token)).status).toBe(404);
    expect((await api('get', '/', t.token)).body.total).toBe(0);
    expect((await api('post', '/', t.token, mcq(s))).status).toBe(403);
    expect((await api('patch', `/${q.id}`, t.token, { revision: 1, text: 'x' })).status).toBe(404);
    expect((await api('get', '/my-subjects', t.token)).body.items).toHaveLength(0);
  });

  it("lists a teacher's distinct subjects and ignores other colleges", async () => {
    const s1 = await setupSubject();
    const s2 = await setupSubject();
    const t = await mkTeacher(s1, s2);
    const subjects = await api('get', '/my-subjects', t.token);
    expect((subjects.body.items as Array<{ id: string }>).map((x) => x.id).sort()).toEqual([s1.subject.id, s2.subject.id].sort());

    const foreign = await Question.create({
      collegeId: new Types.ObjectId(), departmentId: new Types.ObjectId(), subjectId: s1.subject._id, type: 'true_false', text: 'Foreign college question',
      options: [{ optionId: 'o_aaaaaa', text: 'True' }, { optionId: 'o_bbbbbb', text: 'False' }], correctOptionId: 'o_aaaaaa', marks: 1, createdBy: new Types.ObjectId(),
    });
    expect((await api('get', `/${foreign.id}`, t.token)).status).toBe(404);
    expect(((await api('get', '/?pageSize=100', t.token)).body.items as Q[]).some((x) => x.id === foreign.id)).toBe(false);
  });
});

describe('editing', () => {
  it('keeps option ids stable, assigns new ids to new options, and audits key changes', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    const [mumbai, delhi, kolkata, chennai] = q.options as [Opt, Opt, Opt, Opt];

    const text = await api('patch', `/${q.id}`, t.token, { revision: 1, text: 'What is the capital of India?' });
    expect(text.status).toBe(200);
    expect(text.body).toMatchObject({ revision: 2, text: 'What is the capital of India?', correctOptionId: delhi.optionId });
    expect((text.body.options as Opt[]).map((o) => o.optionId)).toEqual([mumbai, delhi, kolkata, chennai].map((o) => o.optionId));

    // Reorder, rename, drop two, add one: surviving options keep their ids and the key is unchanged.
    const reshaped = await api('patch', `/${q.id}`, t.token, {
      revision: 2,
      options: [{ id: delhi.optionId, text: 'New Delhi', correct: true }, { id: mumbai.optionId, text: 'Mumbai (Maharashtra)' }, { text: 'Delhi NCR' }],
    });
    expect(reshaped.status).toBe(200);
    const ids = (reshaped.body.options as Opt[]).map((o) => o.optionId);
    expect(ids.slice(0, 2)).toEqual([delhi.optionId, mumbai.optionId]);
    expect([mumbai, delhi, kolkata, chennai].map((o) => o.optionId)).not.toContain(ids[2]);
    expect(reshaped.body.correctOptionId).toBe(delhi.optionId);
    expect(await AuditLog.findOne({ action: 'questions.key_changed', targetId: q.id })).toBeNull();

    // Change the key: audited as such, without revealing it.
    const rekey = await api('patch', `/${q.id}`, t.token, { revision: 3, options: [{ id: mumbai.optionId, text: 'Mumbai', correct: true }, { id: delhi.optionId, text: 'New Delhi' }] });
    expect(rekey.status).toBe(200);
    expect(rekey.body).toMatchObject({ revision: 4, correctOptionId: mumbai.optionId });
    const keyAudit = await AuditLog.findOne({ action: 'questions.key_changed', targetId: q.id });
    expect(keyAudit).not.toBeNull();
    expect(JSON.stringify(keyAudit)).not.toContain(mumbai.optionId);
  });

  it('refuses stale edits, type changes, unknown option ids, bad option sets and empty updates', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    expect((await api('patch', `/${q.id}`, t.token, { revision: 1, text: 'First edit' })).status).toBe(200);
    expect((await api('patch', `/${q.id}`, t.token, { revision: 1, text: 'Stale edit' })).status).toBe(409);

    const cases: Array<[string, object]> = [
      ['no revision', { text: 'x' }],
      ['type change', { revision: 2, type: 'true_false' }],
      ['unknown option id', { revision: 2, options: [{ id: 'o_zzzzzzzz', text: 'A', correct: true }, { text: 'B' }] }],
      ['two correct', { revision: 2, options: [{ text: 'A', correct: true }, { text: 'B', correct: true }] }],
      ['same id twice', { revision: 2, options: [{ id: q.options[0]?.optionId, text: 'A', correct: true }, { id: q.options[0]?.optionId, text: 'B' }] }],
      ['nothing to change', { revision: 2 }],
      ['client sets status', { revision: 2, status: 'archived' }],
      ['marks zero', { revision: 2, marks: 0 }],
    ];
    for (const [label, body] of cases) expect((await api('patch', `/${q.id}`, t.token, body)).status, label).toBe(400);
  });

  it('clears the topic, and flips a True/False key without touching its options', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    const cleared = await api('patch', `/${q.id}`, t.token, { revision: 1, topic: '' });
    expect(cleared.body.topic).toBeNull();

    const f = await createQ(t.token, tf(s, { correct: true }));
    const flipped = await api('patch', `/${f.id}`, t.token, { revision: 1, correct: false });
    expect(flipped.status).toBe(200);
    expect(flipped.body.correctOptionId).toBe(f.options[1]?.optionId);
    expect((flipped.body.options as Opt[]).map((o) => o.optionId)).toEqual(f.options.map((o) => o.optionId));
    expect((await api('patch', `/${f.id}`, t.token, { revision: 2, options: [{ text: 'A', correct: true }, { text: 'B' }] })).status).toBe(400);
  });

  it('archives and restores instead of deleting, and blocks editing while archived', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    const archived = await api('post', `/${q.id}/archive`, t.token);
    expect(archived.body).toMatchObject({ status: 'archived' });
    expect(archived.body.archivedAt).not.toBeNull();
    expect((await api('post', `/${q.id}/archive`, t.token)).status).toBe(409);
    expect((await api('patch', `/${q.id}`, t.token, { revision: 1, text: 'Edit while archived' })).status).toBe(409);

    const ids = async (status: string) => ((await api('get', `/?pageSize=100&status=${status}`, t.token)).body.items as Q[]).map((x) => x.id);
    expect(await ids('active')).not.toContain(q.id);
    expect(await ids('archived')).toContain(q.id);
    expect(await ids('all')).toContain(q.id);

    expect((await api('post', `/${q.id}/restore`, t.token)).body.status).toBe('active');
    expect((await api('post', `/${q.id}/restore`, t.token)).status).toBe(409);
    expect(await ids('active')).toContain(q.id);
    expect(await Question.countDocuments({ _id: q.id })).toBe(1); // never deleted
  });
});

describe('listing, filtering and search', () => {
  it('filters by topic, difficulty, type and text; escapes search input; bounds pages', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    await createQ(t.token, mcq(s, { topic: 'Photosynthesis', text: 'Where does photosynthesis occur?', difficulty: 'hard' }));
    await createQ(t.token, mcq(s, { topic: 'Cells', text: 'Compute (a+b)*c carefully', difficulty: 'easy' }));
    await createQ(t.token, tf(s, { topic: 'Cells', text: 'Mitochondria make energy.' }));
    const total = (qs: string) => api('get', `/?subjectId=${s.subject.id}&${qs}`, t.token).then((r) => r.body.total as number);

    expect(await total('topic=cells')).toBe(2);
    expect(await total('difficulty=hard')).toBe(1);
    expect(await total('type=true_false')).toBe(1);
    expect(await total('q=PHOTOSYNTHESIS')).toBe(1);
    expect(await total('q=' + encodeURIComponent('(a+b)*c'))).toBe(1); // regex characters are literal
    expect(await total('q=' + encodeURIComponent('.*'))).toBe(0); // not a pattern
    expect((await api('get', '/?q=(', t.token)).status).toBe(200);

    const paged = await api('get', `/?subjectId=${s.subject.id}&pageSize=2`, t.token);
    expect(paged.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(paged.body.items).toHaveLength(2);

    for (const bad of ['pageSize=101', 'pageSize=0', 'page=0', 'difficulty=extreme', 'type=essay', 'status=deleted', 'subjectId[$ne]=x', 'unknown=1', 'q[]=a']) {
      expect((await api('get', `/?${bad}`, t.token)).status, bad).toBe(400);
    }
  });
});

describe('SUPER_ADMIN support access', () => {
  it('can read questions across subjects, every read is audited, and cannot write', async () => {
    const s = await setupSubject();
    const t = await mkTeacher(s);
    const q = await createQ(t.token, mcq(s));
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const token = tokenFor(ctx, admin);

    const before = await AuditLog.countDocuments({ action: 'questions.support_access', actorId: admin._id });
    const list = await api('get', `/?subjectId=${s.subject.id}`, token);
    expect(list.status).toBe(200);
    expect((list.body.items as Q[]).some((x) => x.id === q.id)).toBe(true);
    expect((await api('get', `/${q.id}`, token)).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'questions.support_access', actorId: admin._id })).toBe(before + 2);

    expect((await api('post', '/', token, mcq(s))).status).toBe(403);
    expect((await api('patch', `/${q.id}`, token, { revision: 1, text: 'x' })).status).toBe(403);
    expect((await api('post', `/${q.id}/archive`, token)).status).toBe(403);
  });
});

describe('student-safe shape', () => {
  it('is an explicit allow-list: nothing extra can leak even if the source object has it', () => {
    const source = {
      id: 'q1',
      type: 'mcq' as const,
      text: 'Capital of India?',
      options: [
        { optionId: 'o1', text: 'Mumbai', isCorrect: false },
        { optionId: 'o2', text: 'New Delhi', isCorrect: true },
      ],
      marks: 2,
      correctOptionId: 'o2',
      answerKey: 'o2',
      internalNotes: 'teacher-only hint',
      grading: { revision: 1 },
      createdBy: 'teacher',
    };
    const dto = toStudentQuestionDto(source, 3);
    expect(Object.keys(dto).sort()).toEqual(['marks', 'options', 'questionId', 'sequence', 'text', 'type']);
    expect(dto.options.every((o) => Object.keys(o).sort().join() === 'optionId,text')).toBe(true);
    expect(dto).toMatchObject({ questionId: 'q1', sequence: 3, marks: 2 });
    const keys = collectKeys(dto);
    for (const k of [...FORBIDDEN_KEYS, 'isCorrect', 'createdBy']) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('teacher-only hint');
  });
});

describe('permission matrix: questions', () => {
  const ZERO = '0'.repeat(24);
  interface Endpoint { method: Method; path: string; body?: object; allowed: Role[] }
  const ENDPOINTS: Endpoint[] = [
    { method: 'get', path: '/', allowed: ['TEACHER', 'SUPER_ADMIN'] },
    { method: 'get', path: '/my-subjects', allowed: ['TEACHER'] },
    { method: 'post', path: '/', body: {}, allowed: ['TEACHER'] }, // empty body: allowed roles reach validation (400)
    { method: 'get', path: `/${ZERO}`, allowed: ['TEACHER', 'SUPER_ADMIN'] },
    { method: 'patch', path: `/${ZERO}`, body: { revision: 1, text: 'x' }, allowed: ['TEACHER'] },
    { method: 'post', path: `/${ZERO}/archive`, allowed: ['TEACHER'] },
    { method: 'post', path: `/${ZERO}/restore`, allowed: ['TEACHER'] },
  ];
  let deptId: Types.ObjectId;
  beforeAll(async () => {
    deptId = (await setupSubject()).dept._id;
  });

  for (const ep of ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} /questions${ep.path === '/' ? '' : ep.path.replace(ZERO, '/:id')}`, () => {
      it('401 without a token', async () => {
        expect((await request(ctx.app)[ep.method](`/api/v1/questions${ep.path}`).send(ep.body)).status).toBe(401);
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
});
