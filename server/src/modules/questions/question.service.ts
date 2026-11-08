import { randomBytes } from 'node:crypto';
import type { FilterQuery, Types, UpdateQuery } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { Errors } from '../../common/errors';
import type { RequestMeta } from '../../common/request';
import { parse } from '../../common/validate';
import { toSubjectDto } from '../academics/academics.dto';
import { Subject, TeachingAssignment } from '../academics/academics.models';
import type { AuditService } from '../audit/audit.service';
import { toAuthoringDto } from './question.dto';
import { Question, type Difficulty, type IQuestion, type IQuestionOption, type QuestionDoc } from './question.model';
import { updateMcqBody, updateTfBody, type CreateQuestionInput, type ListInput } from './question.schemas';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const newOptionId = () => `o_${randomBytes(5).toString('hex')}`;
const bad = (path: string, message: string) => Errors.validation([{ path, message }]);

function buildNew(input: CreateQuestionInput): { options: IQuestionOption[]; correctOptionId: string } {
  if (input.type === 'true_false') {
    const yes = { optionId: newOptionId(), text: 'True' };
    const no = { optionId: newOptionId(), text: 'False' };
    return { options: [yes, no], correctOptionId: input.correct ? yes.optionId : no.optionId };
  }
  const options = input.options.map((o) => ({ optionId: newOptionId(), text: o.text, correct: o.correct }));
  const correct = options.find((o) => o.correct);
  if (!correct) throw bad('options', 'exactly one option must be marked correct');
  return { options: options.map(({ optionId, text }) => ({ optionId, text })), correctOptionId: correct.optionId };
}

/**
 * Question bank rules (D-13, PRIVATE bank, chosen by the project lead):
 * - TEACHER: sees and changes ONLY their own questions, and only in subjects they are CURRENTLY assigned to.
 *   A colleague teaching the same subject cannot see them or their answer keys.
 * - SUPER_ADMIN: read-only support access to every question; every read is audited.
 * - Everyone else, including HOD and STUDENT, has no access (enforced by the routes).
 * Out-of-scope ids answer 404 (never reveals existence). Authoring responses carry the answer key.
 */
export class QuestionService {
  constructor(private readonly audit: AuditService) {}

  private async teacherSubjects(actor: AuthContext): Promise<Types.ObjectId[]> {
    const ids = await TeachingAssignment.distinct('subjectId', { collegeId: actor.collegeId, teacherId: actor.userId, active: true });
    return ids as Types.ObjectId[];
  }

  private log(actor: AuthContext, meta: RequestMeta, action: string, targetId: string, summary?: Record<string, unknown>) {
    // Never put question text, options or the answer key in an audit record.
    return this.audit.record({ collegeId: actor.collegeId, actorId: actor.userId, action, targetType: 'question', targetId, summary, requestId: meta.requestId, ip: meta.ip });
  }

  // ------------------------------------------------------------------ read
  async mySubjects(actor: AuthContext) {
    const ids = await this.teacherSubjects(actor);
    const subjects = await Subject.find({ _id: { $in: ids }, collegeId: actor.collegeId, archivedAt: null }).sort({ code: 1 });
    return { items: subjects.map(toSubjectDto) };
  }

  async list(actor: AuthContext, q: ListInput, meta: RequestMeta) {
    const filter: FilterQuery<IQuestion> = { collegeId: actor.collegeId };
    if (actor.role === 'TEACHER') {
      const subjects = await this.teacherSubjects(actor);
      const wanted = q.subjectId?.toLowerCase();
      const allowed = wanted ? subjects.filter((s) => s.toString() === wanted) : subjects;
      if (allowed.length === 0) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 }; // out-of-scope filter: empty, no hint
      filter.subjectId = { $in: allowed };
      filter.createdBy = actor.userId; // private bank: a teacher only ever lists their own questions
    } else if (actor.role === 'SUPER_ADMIN') {
      if (q.subjectId) filter.subjectId = q.subjectId;
    } else {
      throw Errors.forbidden();
    }
    if (q.topic) filter.topic = { $regex: `^${escapeRegex(q.topic)}$`, $options: 'i' };
    if (q.difficulty) filter.difficulty = q.difficulty;
    if (q.type) filter.type = q.type;
    if (q.status !== 'all') filter.status = q.status;
    if (q.mine) filter.createdBy = actor.userId; // redundant for teachers (always own); kept so clients can pass it
    if (q.q) {
      const rx = { $regex: escapeRegex(q.q), $options: 'i' }; // user input is escaped: it can never become a pattern
      filter.$or = [{ text: rx }, { topic: rx }];
    }

    const [docs, total] = await Promise.all([
      Question.find(filter).select('+correctOptionId').sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      Question.countDocuments(filter),
    ]);
    if (actor.role === 'SUPER_ADMIN') {
      await this.log(actor, meta, 'questions.support_access', 'list', { scope: 'list', returned: docs.length, subjectId: q.subjectId ?? null });
    }
    return { items: docs.map((d) => toAuthoringDto(d, actor.userId)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(actor: AuthContext, id: string, meta: RequestMeta) {
    const filter: FilterQuery<IQuestion> = { _id: id, collegeId: actor.collegeId };
    if (actor.role === 'TEACHER') {
      filter.subjectId = { $in: await this.teacherSubjects(actor) };
      filter.createdBy = actor.userId; // someone else's question is simply "not found"
    } else if (actor.role !== 'SUPER_ADMIN') {
      throw Errors.forbidden();
    }
    const doc = await Question.findOne(filter).select('+correctOptionId');
    if (!doc) throw Errors.notFound();
    if (actor.role === 'SUPER_ADMIN') await this.log(actor, meta, 'questions.support_access', doc.id as string, { scope: 'single' });
    return toAuthoringDto(doc, actor.userId);
  }

  // ------------------------------------------------------------------ write (teachers, own questions)
  async create(actor: AuthContext, input: CreateQuestionInput, meta: RequestMeta) {
    if (actor.role !== 'TEACHER') throw Errors.forbidden();
    // Scope first, existence second: an unassigned and a non-existent subject both answer 403.
    const subjects = await this.teacherSubjects(actor);
    if (!subjects.some((s) => s.toString() === input.subjectId.toLowerCase())) throw Errors.forbidden();
    const subject = await Subject.findOne({ _id: input.subjectId, collegeId: actor.collegeId, archivedAt: null });
    if (!subject) throw Errors.forbidden();

    const { options, correctOptionId } = buildNew(input);
    const doc = await Question.create({
      collegeId: actor.collegeId,
      departmentId: subject.departmentId, // derived from the subject
      subjectId: subject._id,
      ...(input.topic ? { topic: input.topic } : {}),
      type: input.type,
      text: input.text,
      options,
      correctOptionId,
      marks: input.marks,
      difficulty: input.difficulty,
      status: 'active',
      createdBy: actor.userId,
      revision: 1,
    });
    await this.log(actor, meta, 'questions.created', doc.id as string, { subjectId: subject.id as string, type: doc.type, marks: doc.marks });
    return toAuthoringDto(doc, actor.userId);
  }

  private async loadForWrite(actor: AuthContext, id: string): Promise<QuestionDoc> {
    if (actor.role !== 'TEACHER') throw Errors.forbidden();
    const subjects = await this.teacherSubjects(actor);
    const q = await Question.findOne({ _id: id, collegeId: actor.collegeId, subjectId: { $in: subjects }, createdBy: actor.userId }).select('+correctOptionId');
    if (!q) throw Errors.notFound(); // not yours, not in your subjects, or does not exist: all look the same
    return q;
  }

  /** Optimistic concurrency: the caller sends the revision it read; a stale edit is refused, never merged. */
  async update(actor: AuthContext, id: string, body: unknown, meta: RequestMeta) {
    const q = await this.loadForWrite(actor, id);
    if (q.status === 'archived') throw Errors.conflict('Restore the question before editing it');

    const set: { text?: string; marks?: number; difficulty?: Difficulty; topic?: string; options?: IQuestionOption[]; correctOptionId?: string } = {};
    let unsetTopic = false;
    let expectedRevision: number;

    if (q.type === 'mcq') {
      const p = parse(updateMcqBody, body);
      expectedRevision = p.revision;
      if (p.text !== undefined) set.text = p.text;
      if (p.marks !== undefined) set.marks = p.marks;
      if (p.difficulty !== undefined) set.difficulty = p.difficulty;
      if (p.topic !== undefined) {
        if (p.topic === '') unsetTopic = true;
        else set.topic = p.topic;
      }
      if (p.options) {
        const existing = new Set(q.options.map((o) => o.optionId));
        const options: IQuestionOption[] = [];
        let correctId = '';
        for (const o of p.options) {
          if (o.id !== undefined && !existing.has(o.id)) throw bad('options', `unknown option id "${o.id}"`);
          const optionId = o.id ?? newOptionId(); // existing options keep their id; new ones get a fresh one
          options.push({ optionId, text: o.text });
          if (o.correct) correctId = optionId;
        }
        set.options = options;
        set.correctOptionId = correctId;
      }
    } else {
      const p = parse(updateTfBody, body);
      expectedRevision = p.revision;
      if (p.text !== undefined) set.text = p.text;
      if (p.marks !== undefined) set.marks = p.marks;
      if (p.difficulty !== undefined) set.difficulty = p.difficulty;
      if (p.topic !== undefined) {
        if (p.topic === '') unsetTopic = true;
        else set.topic = p.topic;
      }
      if (p.correct !== undefined) {
        const [yes, no] = q.options;
        if (!yes || !no) throw bad('correct', 'the question has no True/False options');
        set.correctOptionId = p.correct ? yes.optionId : no.optionId;
      }
    }

    const update: UpdateQuery<IQuestion> = { $inc: { revision: 1 } };
    if (Object.keys(set).length > 0) update.$set = set;
    if (unsetTopic) update.$unset = { topic: '' };

    const updated = await Question.findOneAndUpdate({ _id: q._id, revision: expectedRevision, status: 'active' }, update, { new: true }).select('+correctOptionId');
    if (!updated) throw Errors.conflict('This question was changed by someone else (or archived). Reload it and try again');

    const keyChanged = updated.correctOptionId !== q.correctOptionId;
    const fields = [...Object.keys(set), ...(unsetTopic ? ['topic'] : [])];
    await this.log(actor, meta, 'questions.updated', updated.id as string, { revision: updated.revision, fields, keyChanged });
    if (keyChanged) await this.log(actor, meta, 'questions.key_changed', updated.id as string, { revision: updated.revision });
    return toAuthoringDto(updated, actor.userId);
  }

  async archive(actor: AuthContext, id: string, meta: RequestMeta) {
    const q = await this.loadForWrite(actor, id);
    const doc = await Question.findOneAndUpdate({ _id: q._id, status: 'active' }, { $set: { status: 'archived', archivedAt: new Date() } }, { new: true }).select('+correctOptionId');
    if (!doc) throw Errors.conflict('The question is already archived');
    await this.log(actor, meta, 'questions.archived', doc.id as string);
    return toAuthoringDto(doc, actor.userId);
  }

  async restore(actor: AuthContext, id: string, meta: RequestMeta) {
    const q = await this.loadForWrite(actor, id);
    const subject = await Subject.findOne({ _id: q.subjectId, collegeId: actor.collegeId, archivedAt: null });
    if (!subject) throw Errors.conflict('The subject is archived');
    const doc = await Question.findOneAndUpdate({ _id: q._id, status: 'archived' }, { $set: { status: 'active' }, $unset: { archivedAt: '' } }, { new: true }).select('+correctOptionId');
    if (!doc) throw Errors.conflict('The question is not archived');
    await this.log(actor, meta, 'questions.restored', doc.id as string);
    return toAuthoringDto(doc, actor.userId);
  }
}
