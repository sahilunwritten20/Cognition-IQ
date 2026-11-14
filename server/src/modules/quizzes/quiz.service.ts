import { Types, type FilterQuery, type UpdateQuery } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { Errors } from '../../common/errors';
import type { RequestMeta } from '../../common/request';
import { parse } from '../../common/validate';
import { Division, Enrollment, SchoolClass, Subject, TeachingAssignment, type IEnrollment } from '../academics/academics.models';
import type { AuditService } from '../audit/audit.service';
import { Question } from '../questions/question.model';
import { User } from '../users/user.model';
import { formatQuizCode, generateQuizCode, hashQuizCode } from './quiz.code';
import { toQuizDto, toStudentQuizDto, type QuizRefs } from './quiz.dto';
import { Quiz, type IQuiz, type IQuizItem, type IQuizTarget, type QuizDoc, type QuizStatus } from './quiz.model';
import { roundMarks, type AttemptLookup } from './quiz.rules';
import { updateQuizBody, type CreateQuizInput } from './quiz.schemas';

const bad = (path: string, message: string) => Errors.validation([{ path, message }]);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuizServiceDeps {
  audit: AuditService;
  codeKey: string; // sub-key for access-code hashing
  attempts: AttemptLookup; // wired to the real attempts in Steps 7-8
  now?: () => Date; // injectable clock
}

/**
 * Quiz rules (guide Sections 5, 6, 8). Teachers create and run ONLY their own quizzes, only for class/divisions they are
 * currently assigned to; HOD reads their department; SUPER_ADMIN reads everything (emergency actions arrive with the monitor).
 * Everything the server owns (totals, year, department, status, code) is computed here, never taken from the client.
 */
export class QuizService {
  constructor(private readonly d: QuizServiceDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private log(actor: AuthContext, meta: RequestMeta, action: string, targetId: string, summary?: Record<string, unknown>) {
    // Never log the access code, its hash, or question content.
    return this.d.audit.record({ collegeId: actor.collegeId, actorId: actor.userId, action, targetType: 'quiz', targetId, summary, requestId: meta.requestId, ip: meta.ip });
  }

  // ------------------------------------------------------------------ scope
  private readScope(actor: AuthContext): FilterQuery<IQuiz> {
    if (actor.role === 'SUPER_ADMIN') return { collegeId: actor.collegeId };
    if (actor.role === 'HOD' && actor.departmentId) return { collegeId: actor.collegeId, departmentId: new Types.ObjectId(actor.departmentId) };
    if (actor.role === 'TEACHER') return { collegeId: actor.collegeId, createdBy: actor.userId };
    throw Errors.forbidden(); // HOD without a department, or any other role
  }

  private async ownQuiz(actor: AuthContext, id: string): Promise<QuizDoc> {
    if (actor.role !== 'TEACHER') throw Errors.forbidden();
    const quiz = await Quiz.findOne({ _id: id, collegeId: actor.collegeId, createdBy: actor.userId });
    if (!quiz) throw Errors.notFound(); // not yours or does not exist: indistinguishable
    return quiz;
  }

  /** Every target must be a class+division the teacher CURRENTLY teaches this subject in. Unassigned = 403 (no existence hints). */
  private async resolveScope(actor: AuthContext, subjectId: string, targets: Array<{ classId: string; divisionId: string }>) {
    const assignments = await TeachingAssignment.find({ collegeId: actor.collegeId, teacherId: actor.userId, subjectId, active: true });
    if (assignments.length === 0) throw Errors.forbidden();
    const byKey = new Map(assignments.map((a): [string, typeof a] => [`${a.classId.toString()}:${a.divisionId.toString()}`, a]));
    const picked: typeof assignments = [];
    const seen = new Set<string>();
    for (const t of targets) {
      const key = `${t.classId.toLowerCase()}:${t.divisionId.toLowerCase()}`;
      if (seen.has(key)) continue; // a repeated class/division is ignored
      seen.add(key);
      const a = byKey.get(key);
      if (!a) throw Errors.forbidden();
      picked.push(a);
    }
    const first = picked[0];
    if (!first) throw bad('targets', 'at least one class and division is required');
    if (picked.some((a) => !a.academicYearId.equals(first.academicYearId))) throw bad('targets', 'all classes must belong to the same academic year');
    return {
      subjectId: first.subjectId,
      departmentId: first.departmentId,
      academicYearId: first.academicYearId,
      targets: picked.map((a): IQuizTarget => ({ classId: a.classId, divisionId: a.divisionId })),
    };
  }

  /** Only the teacher's own, active questions of THIS subject. Marks default to the question's marks; the total is computed here. */
  private async resolveItems(actor: AuthContext, subjectId: Types.ObjectId, items: Array<{ questionId: string; marks?: number }>) {
    const ids = items.map((i) => i.questionId.toLowerCase());
    if (new Set(ids).size !== ids.length) throw bad('items', 'a question can be added only once');
    const found = await Question.find({ _id: { $in: ids }, collegeId: actor.collegeId, createdBy: actor.userId, subjectId, status: 'active' }).select('marks'); // the answer key is never selected
    const marksById = new Map(found.map((q): [string, number] => [q.id as string, q.marks]));
    const missing = ids.filter((id) => !marksById.has(id));
    if (missing.length > 0) throw bad('items', `${missing.length} question(s) are unknown, archived, or not yours in this subject`);
    const resolved: IQuizItem[] = items.map((it) => {
      const questionId = it.questionId.toLowerCase();
      return { questionId: new Types.ObjectId(questionId), marks: it.marks ?? (marksById.get(questionId) as number) };
    });
    return { items: resolved, totalMarks: roundMarks(resolved.reduce((sum, i) => sum + i.marks, 0)) };
  }

  private newCode(): { accessCode: string; codeHash: string; codeSetAt: Date } {
    const code = generateQuizCode();
    return { accessCode: formatQuizCode(code), codeHash: hashQuizCode(code, this.d.codeKey), codeSetAt: this.now() };
  }

  private async refsFor(docs: QuizDoc[]): Promise<QuizRefs> {
    const uniq = (pick: (d: QuizDoc) => string[]) => [...new Set(docs.flatMap(pick))];
    const [subjects, classes, divisions] = await Promise.all([
      Subject.find({ _id: { $in: uniq((d) => [d.subjectId.toString()]) } }),
      SchoolClass.find({ _id: { $in: uniq((d) => d.targets.map((t) => t.classId.toString())) } }),
      Division.find({ _id: { $in: uniq((d) => d.targets.map((t) => t.divisionId.toString())) } }),
    ]);
    return {
      subjects: new Map(subjects.map((x): [string, { id: string; code: string; name: string }] => [x.id as string, { id: x.id as string, code: x.code, name: x.name }])),
      classes: new Map(classes.map((x): [string, { id: string; code: string; name: string }] => [x.id as string, { id: x.id as string, code: x.code, name: x.name }])),
      divisions: new Map(divisions.map((x): [string, { id: string; name: string }] => [x.id as string, { id: x.id as string, name: x.name }])),
    };
  }

  private async dto(actor: AuthContext, quiz: QuizDoc, extras: { accessCode?: string } = {}) {
    return toQuizDto(quiz, await this.refsFor([quiz]), actor.userId, this.now(), extras);
  }

  // ------------------------------------------------------------------ read
  async list(actor: AuthContext, q: { page: number; pageSize: number; status: QuizStatus | 'all'; subjectId?: string }) {
    const filter = this.readScope(actor);
    if (q.status !== 'all') filter.status = q.status;
    if (q.subjectId) filter.subjectId = q.subjectId;
    const [docs, total] = await Promise.all([
      Quiz.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      Quiz.countDocuments(filter),
    ]);
    const refs = await this.refsFor(docs);
    const now = this.now();
    return { items: docs.map((d) => toQuizDto(d, refs, actor.userId, now)), page: q.page, pageSize: q.pageSize, total };
  }

  private async readable(actor: AuthContext, id: string): Promise<QuizDoc> {
    const quiz = await Quiz.findOne({ ...this.readScope(actor), _id: id });
    if (!quiz) throw Errors.notFound();
    return quiz;
  }

  async get(actor: AuthContext, id: string) {
    return this.dto(actor, await this.readable(actor, id));
  }

  /** Students enrolled (in the quiz's year) in any target class+division. `eligible` also needs an active account. */
  async eligibleStudents(actor: AuthContext, id: string, q: { page: number; pageSize: number }) {
    const quiz = await this.readable(actor, id);
    const filter: FilterQuery<IEnrollment> = {
      collegeId: actor.collegeId,
      academicYearId: quiz.academicYearId,
      $or: quiz.targets.map((t) => ({ classId: t.classId, divisionId: t.divisionId })),
    };
    const [enrollments, total] = await Promise.all([
      Enrollment.find(filter).sort({ classId: 1, divisionId: 1, rollNo: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      Enrollment.countDocuments(filter),
    ]);
    const users = await User.find({ _id: { $in: enrollments.map((e) => e.studentId) }, collegeId: actor.collegeId }).select('name loginId status deletedAt');
    const byId = new Map(users.map((u): [string, typeof u] => [u.id as string, u]));
    const items = enrollments.map((e) => {
      const u = byId.get(e.studentId.toString());
      const accountStatus = !u ? 'missing' : u.deletedAt ? 'removed' : u.status;
      return {
        student: u ? { id: u.id as string, name: u.name, loginId: u.loginId } : null,
        rollNo: e.rollNo,
        classId: e.classId.toString(),
        divisionId: e.divisionId.toString(),
        accountStatus,
        eligible: accountStatus === 'active',
      };
    });
    return { items, page: q.page, pageSize: q.pageSize, total };
  }

  // ------------------------------------------------------------------ student discovery
  /**
   * What a student sees: published or paused quizzes for THEIR enrolled class+division and year, with the reason when
   * one cannot be started. Drafts and closed quizzes are never listed; a quiz that ended over 24 h ago drops off.
   */
  async studentQuizzes(actor: AuthContext, q: { page: number; pageSize: number }) {
    const now = this.now();
    const enrollments = await Enrollment.find({ collegeId: actor.collegeId, studentId: actor.userId }).select('academicYearId classId divisionId');
    if (enrollments.length === 0) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };

    const filter: FilterQuery<IQuiz> = {
      collegeId: actor.collegeId,
      status: { $in: ['published', 'paused'] },
      endAt: { $gt: new Date(now.getTime() - DAY_MS) },
      $or: enrollments.map((e) => ({ academicYearId: e.academicYearId, targets: { $elemMatch: { classId: e.classId, divisionId: e.divisionId } } })),
    };
    const [docs, total] = await Promise.all([
      Quiz.find(filter).sort({ startAt: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      Quiz.countDocuments(filter),
    ]);
    const refs = await this.refsFor(docs);
    const ids = docs.map((d) => d.id as string);
    const used = await this.d.attempts.countsForStudent(actor.userId, ids);
    const active = (await this.d.attempts.activeAttemptIds?.(actor.userId, ids)) ?? new Map<string, string>();
    return {
      items: docs.map((d) => toStudentQuizDto(d, refs.subjects.get(d.subjectId.toString()) ?? null, used.get(d.id as string) ?? 0, now, active.get(d.id as string) ?? null)),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  // ------------------------------------------------------------------ draft
  async create(actor: AuthContext, input: CreateQuizInput, meta: RequestMeta) {
    if (actor.role !== 'TEACHER') throw Errors.forbidden();
    const scope = await this.resolveScope(actor, input.subjectId, input.targets);
    const resolved = await this.resolveItems(actor, scope.subjectId, input.items ?? []);
    const code = input.accessMode !== 'scheduled' ? this.newCode() : undefined;

    const doc = await Quiz.create({
      collegeId: actor.collegeId,
      departmentId: scope.departmentId,
      academicYearId: scope.academicYearId,
      subjectId: scope.subjectId,
      createdBy: actor.userId,
      title: input.title,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      items: resolved.items,
      totalMarks: resolved.totalMarks,
      targets: scope.targets,
      startAt: input.startAt,
      endAt: input.endAt,
      durationMinutes: input.durationMinutes,
      maxAttempts: input.maxAttempts,
      ...(input.passMarks !== undefined ? { passMarks: input.passMarks } : {}),
      accessMode: input.accessMode,
      ...(code ? { codeHash: code.codeHash, codeSetAt: code.codeSetAt } : {}),
      resultVisibility: input.resultVisibility,
      status: 'draft',
      revision: 1,
    });
    await this.log(actor, meta, 'quizzes.created', doc.id as string, { questions: doc.items.length, totalMarks: doc.totalMarks, accessMode: doc.accessMode });
    return this.dto(actor, doc, code ? { accessCode: code.accessCode } : {});
  }

  /** Drafts only, with optimistic concurrency (`revision`). The subject cannot change. */
  async update(actor: AuthContext, id: string, body: unknown, meta: RequestMeta) {
    const quiz = await this.ownQuiz(actor, id);
    if (quiz.status !== 'draft') throw Errors.conflict('Only a draft can be edited. Unpublish it first (possible only before any student has started).');
    const p = parse(updateQuizBody, body);

    const set: Partial<IQuiz> = {};
    const unset: Record<string, ''> = {};
    let code: { accessCode: string; codeHash: string; codeSetAt: Date } | undefined;

    if (p.title !== undefined) set.title = p.title;
    if (p.instructions !== undefined) {
      if (p.instructions === '') unset.instructions = '';
      else set.instructions = p.instructions;
    }
    if (p.targets) {
      const scope = await this.resolveScope(actor, quiz.subjectId.toString(), p.targets);
      set.targets = scope.targets;
      set.departmentId = scope.departmentId;
      set.academicYearId = scope.academicYearId;
    }
    if (p.items) {
      const resolved = await this.resolveItems(actor, quiz.subjectId, p.items);
      set.items = resolved.items;
      set.totalMarks = resolved.totalMarks;
    }
    if (p.startAt !== undefined) {
      if (p.startAt === null) unset.startAt = '';
      else set.startAt = p.startAt;
    }
    if (p.endAt !== undefined) {
      if (p.endAt === null) unset.endAt = '';
      else set.endAt = p.endAt;
    }
    if (p.durationMinutes !== undefined) {
      if (p.durationMinutes === null) unset.durationMinutes = '';
      else set.durationMinutes = p.durationMinutes;
    }
    if (p.maxAttempts !== undefined) set.maxAttempts = p.maxAttempts;
    if (p.passMarks !== undefined) {
      if (p.passMarks === null) unset.passMarks = '';
      else set.passMarks = p.passMarks;
    }
    if (p.resultVisibility !== undefined) set.resultVisibility = p.resultVisibility;
    if (p.accessMode !== undefined) {
      set.accessMode = p.accessMode;
      if (p.accessMode === 'scheduled') {
        unset.codeHash = '';
        unset.codeSetAt = '';
      } else if (!quiz.codeSetAt) {
        code = this.newCode();
        set.codeHash = code.codeHash;
        set.codeSetAt = code.codeSetAt;
      }
    }

    // The final window must still be ordered, whichever side the request changed.
    const start = p.startAt === undefined ? quiz.startAt : p.startAt ?? undefined;
    const end = p.endAt === undefined ? quiz.endAt : p.endAt ?? undefined;
    if (start && end && end <= start) throw bad('endAt', 'endAt must be after startAt');

    const update: UpdateQuery<IQuiz> = { $inc: { revision: 1 } };
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const updated = await Quiz.findOneAndUpdate({ _id: quiz._id, status: 'draft', revision: p.revision }, update, { new: true });
    if (!updated) throw Errors.conflict('This quiz was changed by someone else or is no longer a draft. Reload it and try again');

    await this.log(actor, meta, 'quizzes.updated', updated.id as string, { revision: updated.revision, fields: [...Object.keys(set).filter((k) => k !== 'codeHash'), ...Object.keys(unset)] });
    return this.dto(actor, updated, code ? { accessCode: code.accessCode } : {});
  }

  // ------------------------------------------------------------------ publish and lifecycle
  /** Everything that must be true to publish, collected so the teacher sees ALL problems at once. */
  private async publishProblems(quiz: QuizDoc): Promise<Array<{ path: string; message: string }>> {
    const problems: Array<{ path: string; message: string }> = [];
    const now = this.now();

    if (quiz.items.length === 0) {
      problems.push({ path: 'items', message: 'Add at least one question.' });
    } else {
      const ids = quiz.items.map((i) => i.questionId);
      const ok = await Question.countDocuments({ _id: { $in: ids }, collegeId: quiz.collegeId, createdBy: quiz.createdBy, subjectId: quiz.subjectId, status: 'active' });
      if (ok !== ids.length) problems.push({ path: 'items', message: `${ids.length - ok} question(s) were archived or are no longer available. Remove them and try again.` });
    }
    const total = roundMarks(quiz.items.reduce((s, i) => s + i.marks, 0));
    if (!(total > 0)) problems.push({ path: 'totalMarks', message: 'The total marks must be greater than 0.' });
    if (quiz.passMarks !== undefined && quiz.passMarks > total) problems.push({ path: 'passMarks', message: 'The pass marks cannot be more than the total marks.' });

    if (!quiz.startAt) problems.push({ path: 'startAt', message: 'Set the start time.' });
    if (!quiz.endAt) problems.push({ path: 'endAt', message: 'Set the end time.' });
    if (quiz.startAt && quiz.endAt) {
      if (quiz.endAt <= quiz.startAt) problems.push({ path: 'endAt', message: 'The end time must be after the start time.' });
      else if (quiz.endAt <= now) problems.push({ path: 'endAt', message: 'The end time has already passed.' });
    }
    if (!quiz.durationMinutes) problems.push({ path: 'durationMinutes', message: 'Set the duration in minutes.' });
    else if (quiz.startAt && quiz.endAt && quiz.durationMinutes * 60_000 > quiz.endAt.getTime() - quiz.startAt.getTime()) {
      problems.push({ path: 'durationMinutes', message: 'The duration is longer than the time window between start and end.' });
    }

    const assignments = await TeachingAssignment.find({ collegeId: quiz.collegeId, teacherId: quiz.createdBy, subjectId: quiz.subjectId, active: true });
    const keys = new Set(assignments.map((a) => `${a.classId.toString()}:${a.divisionId.toString()}`));
    quiz.targets.forEach((t, i) => {
      if (!keys.has(`${t.classId.toString()}:${t.divisionId.toString()}`)) problems.push({ path: `targets.${i}`, message: 'You are no longer assigned to this class and division for this subject.' });
    });
    return problems;
  }

  async publish(actor: AuthContext, id: string, meta: RequestMeta) {
    const quiz = await this.ownQuiz(actor, id);
    if (quiz.status !== 'draft') throw Errors.conflict(`Only a draft can be published (current status: ${quiz.status})`);
    const problems = await this.publishProblems(quiz);
    if (problems.length > 0) throw Errors.validation(problems);

    const now = this.now();
    const code = quiz.accessMode !== 'scheduled' && !quiz.codeSetAt ? this.newCode() : undefined;
    const set: Partial<IQuiz> = {
      status: 'published',
      publishedAt: now,
      totalMarks: roundMarks(quiz.items.reduce((s, i) => s + i.marks, 0)), // recomputed on the server one last time
      ...(code ? { codeHash: code.codeHash, codeSetAt: code.codeSetAt } : {}),
    };
    const updated = await Quiz.findOneAndUpdate(
      { _id: quiz._id, status: 'draft', revision: quiz.revision },
      { $set: set, $inc: { revision: 1 }, $unset: { statusReason: '' } },
      { new: true },
    );
    if (!updated) throw Errors.conflict('The quiz changed while publishing. Reload it and try again');
    await this.log(actor, meta, 'quizzes.published', updated.id as string, { questions: updated.items.length, totalMarks: updated.totalMarks, accessMode: updated.accessMode });
    return this.dto(actor, updated, code ? { accessCode: code.accessCode } : {});
  }

  private async transition(
    actor: AuthContext,
    id: string,
    meta: RequestMeta,
    t: { from: QuizStatus[]; to: QuizStatus; action: string; reason?: string; set?: Partial<IQuiz>; unset?: Record<string, ''> },
  ) {
    const quiz = await this.ownQuiz(actor, id);
    const set: Partial<IQuiz> = { status: t.to, ...(t.set ?? {}), ...(t.reason ? { statusReason: t.reason } : {}) };
    const update: UpdateQuery<IQuiz> = { $set: set, $inc: { revision: 1 } };
    if (t.unset) update.$unset = t.unset;
    const updated = await Quiz.findOneAndUpdate({ _id: quiz._id, status: { $in: t.from } }, update, { new: true });
    if (!updated) throw Errors.conflict(`A quiz in status "${quiz.status}" cannot do that`);
    await this.log(actor, meta, t.action, updated.id as string, { from: quiz.status, to: t.to, reason: t.reason ?? null });
    return this.dto(actor, updated);
  }

  /** Blocks NEW starts only; running attempts continue and their deadlines do not change (guide Section 8). */
  pause(actor: AuthContext, id: string, reason: string, meta: RequestMeta) {
    return this.transition(actor, id, meta, { from: ['published'], to: 'paused', action: 'quizzes.paused', reason, set: { pausedAt: this.now() } });
  }
  resume(actor: AuthContext, id: string, meta: RequestMeta) {
    return this.transition(actor, id, meta, { from: ['paused'], to: 'published', action: 'quizzes.resumed', unset: { pausedAt: '' } });
  }
  /** Ends the quiz for good: no new starts. Finalizing running attempts is the monitor's emergency-close (Step 10). */
  close(actor: AuthContext, id: string, reason: string, meta: RequestMeta) {
    return this.transition(actor, id, meta, { from: ['draft', 'published', 'paused'], to: 'closed', action: 'quizzes.closed', reason, set: { closedAt: this.now() } });
  }
  async unpublish(actor: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const quiz = await this.ownQuiz(actor, id);
    if (await this.d.attempts.quizHasAttempts(quiz.id as string)) {
      throw Errors.conflict('Students have already started this quiz, so it cannot go back to draft. Pause or close it instead.');
    }
    return this.transition(actor, id, meta, { from: ['published', 'paused'], to: 'draft', action: 'quizzes.unpublished', reason, unset: { publishedAt: '', pausedAt: '' } });
  }

  /** New code, shown once; the old code stops working immediately. */
  async regenerateCode(actor: AuthContext, id: string, meta: RequestMeta) {
    const quiz = await this.ownQuiz(actor, id);
    if (quiz.status === 'closed') throw Errors.conflict('A closed quiz cannot be changed');
    if (quiz.accessMode === 'scheduled') throw Errors.conflict('This quiz does not use an access code. Change its access mode first');
    const code = this.newCode();
    const updated = await Quiz.findOneAndUpdate(
      { _id: quiz._id, status: { $ne: 'closed' } },
      { $set: { codeHash: code.codeHash, codeSetAt: code.codeSetAt }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) throw Errors.conflict('The quiz changed; reload it and try again');
    await this.log(actor, meta, 'quizzes.code_regenerated', updated.id as string);
    return { accessCode: code.accessCode, revision: updated.revision };
  }
}
