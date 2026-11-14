import { Types, type FilterQuery } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { AppError, Errors } from '../../common/errors';
import { toCsv } from '../../common/csv';
import type { RequestMeta } from '../../common/request';
import { Division, Enrollment, SchoolClass, Subject, type IEnrollment } from '../academics/academics.models';
import { Attempt, COUNTED_STATUSES, type AttemptDoc } from '../attempts/attempt.model';
import { correctionsOf, optionsOf, type AttemptService } from '../attempts/attempt.service';
import { applyCorrections } from '../attempts/grading';
import type { AuditService } from '../audit/audit.service';
import { Quiz, type IQuiz, type QuizDoc } from '../quizzes/quiz.model';
import { User } from '../users/user.model';
import type { RegradeInput } from './results.schemas';
import {
  formatLocal,
  isPassed,
  percentage,
  pickCounted,
  studentStatus,
  summarize,
  type AttemptRow,
  type StudentResultStatus,
} from './results.rules';

const MAX_ROWS = 5000;
const iso = (d?: Date) => (d ? d.toISOString() : null);
const bad = (path: string, message: string) => Errors.validation([{ path, message }]);

export interface ResultsDeps {
  audit: AuditService;
  attempts: AttemptService;
  timeZone: string;
  now?: () => Date;
}

const toRow = (a: AttemptDoc): AttemptRow => ({
  attemptNo: a.attemptNo,
  status: a.status,
  gradingStatus: a.grading.status,
  score: a.grading.score,
  totalMarks: a.grading.totalMarks,
  submittedAt: a.submittedAt,
});

/**
 * Results, publication and regrade (guide Phase 9). Teachers see and run only their own quizzes; HOD reads their department;
 * SUPER_ADMIN reads everything (audited). Students see a result only after the teacher publishes it, and only as much as the
 * quiz's `resultVisibility` allows.
 */
export class ResultsService {
  constructor(private readonly d: ResultsDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private log(actor: AuthContext, meta: RequestMeta, action: string, targetId: string, summary?: Record<string, unknown>) {
    // Never put student names, marks per student, answers or keys in an audit record.
    return this.d.audit.record({ collegeId: actor.collegeId, actorId: actor.userId, action, targetType: 'quiz', targetId, summary, requestId: meta.requestId, ip: meta.ip });
  }

  private async quizFor(actor: AuthContext, id: string, access: 'read' | 'write'): Promise<QuizDoc> {
    const filter: FilterQuery<IQuiz> = { _id: id, collegeId: actor.collegeId };
    if (actor.role === 'TEACHER') {
      filter.createdBy = actor.userId;
    } else if (access === 'read' && actor.role === 'HOD') {
      if (!actor.departmentId) throw Errors.forbidden();
      filter.departmentId = new Types.ObjectId(actor.departmentId);
    } else if (!(access === 'read' && actor.role === 'SUPER_ADMIN')) {
      throw Errors.forbidden();
    }
    const quiz = await Quiz.findOne(filter);
    if (!quiz) throw Errors.notFound(); // not yours or does not exist: indistinguishable
    return quiz;
  }

  // ------------------------------------------------------------------ the results table
  /** Every enrolled student with where they stand: the roster reconciliation (not started / in progress / submitted). */
  private async collect(quiz: QuizDoc) {
    const filter: FilterQuery<IEnrollment> = {
      collegeId: quiz.collegeId,
      academicYearId: quiz.academicYearId,
      $or: quiz.targets.map((t) => ({ classId: t.classId, divisionId: t.divisionId })),
    };
    const enrollments = await Enrollment.find(filter).limit(MAX_ROWS + 1);
    if (enrollments.length > MAX_ROWS) throw Errors.conflict(`Too many students to list at once (maximum ${MAX_ROWS})`);
    const studentIds = enrollments.map((e) => e.studentId);

    const [users, attempts, classes, divisions] = await Promise.all([
      User.find({ _id: { $in: studentIds }, collegeId: quiz.collegeId }).select('name loginId'),
      Attempt.find({ quizId: quiz._id, studentId: { $in: studentIds } }).select('studentId attemptNo status submittedAt grading.status grading.score grading.totalMarks'),
      SchoolClass.find({ _id: { $in: quiz.targets.map((t) => t.classId) } }),
      Division.find({ _id: { $in: quiz.targets.map((t) => t.divisionId) } }),
    ]);
    const userById = new Map(users.map((u): [string, typeof u] => [u.id as string, u]));
    const classById = new Map(classes.map((c): [string, { code: string; name: string }] => [c.id as string, { code: c.code, name: c.name }]));
    const divisionById = new Map(divisions.map((v): [string, { name: string }] => [v.id as string, { name: v.name }]));
    const byStudent = new Map<string, AttemptDoc[]>();
    for (const a of attempts) {
      const key = a.studentId.toString();
      byStudent.set(key, [...(byStudent.get(key) ?? []), a]);
    }

    const rows = enrollments.map((e) => {
      const mine = (byStudent.get(e.studentId.toString()) ?? []).sort((x, y) => x.attemptNo - y.attemptNo);
      const attemptRows = mine.map(toRow);
      const counted = pickCounted(attemptRows);
      const score = counted?.score ?? null;
      const total = counted?.totalMarks ?? quiz.totalMarks;
      const u = userById.get(e.studentId.toString());
      return {
        student: u ? { id: u.id as string, name: u.name, loginId: u.loginId } : null,
        rollNo: e.rollNo,
        class: classById.get(e.classId.toString()) ?? null,
        division: divisionById.get(e.divisionId.toString()) ?? null,
        status: studentStatus(attemptRows) as StudentResultStatus,
        running: attemptRows.some((a) => a.status === 'in_progress'),
        attemptsCount: attemptRows.length,
        attempts: attemptRows.map((a) => ({
          attemptNo: a.attemptNo,
          status: a.status,
          gradingStatus: a.gradingStatus,
          score: a.score ?? null,
          totalMarks: a.totalMarks ?? null,
          submittedAt: iso(a.submittedAt),
        })),
        counted: counted ? { attemptNo: counted.attemptNo, score: counted.score ?? 0, totalMarks: total, submittedAt: iso(counted.submittedAt) } : null,
        score,
        totalMarks: total,
        percentage: score === null ? null : percentage(score, total),
        passed: isPassed(score, quiz.passMarks),
      };
    });
    rows.sort(
      (x, y) =>
        (x.class?.code ?? '').localeCompare(y.class?.code ?? '') ||
        (x.division?.name ?? '').localeCompare(y.division?.name ?? '') ||
        x.rollNo.localeCompare(y.rollNo, undefined, { numeric: true }),
    );
    return { rows, summary: summarize(rows.map((r) => ({ status: r.status, score: r.score, passed: r.passed })), quiz.passMarks !== undefined) };
  }

  async table(actor: AuthContext, id: string, q: { page: number; pageSize: number; status?: StudentResultStatus }, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'read');
    const { rows, summary } = await this.collect(quiz);
    const filtered = q.status ? rows.filter((r) => r.status === q.status) : rows;
    if (actor.role === 'SUPER_ADMIN') await this.log(actor, meta, 'results.support_access', quiz.id as string, { scope: 'table' });
    return {
      quiz: {
        id: quiz.id as string,
        title: quiz.title,
        status: quiz.status,
        totalMarks: quiz.totalMarks,
        passMarks: quiz.passMarks ?? null,
        resultVisibility: quiz.resultVisibility,
        resultsPublished: Boolean(quiz.resultsPublishedAt),
        resultsPublishedAt: iso(quiz.resultsPublishedAt),
        gradingRevision: quiz.gradingRevision,
      },
      summary, // computed over the WHOLE class, not just this page
      items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      page: q.page,
      pageSize: q.pageSize,
      total: filtered.length,
    };
  }

  /** CSV: escaped, formula-injection-neutralized, bounded, scoped by role, times in the display time zone. Audited. */
  async exportCsv(actor: AuthContext, id: string, meta: RequestMeta): Promise<{ csv: string; fileName: string }> {
    const quiz = await this.quizFor(actor, id, 'read');
    const { rows } = await this.collect(quiz);
    const csv =
      '\uFEFF' + // lets Excel open Marathi/Hindi names correctly
      toCsv([
        ['rollNo', 'loginId', 'name', 'class', 'division', 'status', 'attempts', 'score', 'totalMarks', 'percentage', 'result', 'countedAttempt', `submittedAt (${this.d.timeZone})`],
        ...rows.map((r) => [
          r.rollNo,
          r.student?.loginId ?? '',
          r.student?.name ?? '',
          r.class?.code ?? '',
          r.division?.name ?? '',
          r.status,
          String(r.attemptsCount),
          r.score === null ? '' : String(r.score),
          String(r.totalMarks),
          r.percentage === null ? '' : String(r.percentage),
          r.passed === null ? '' : r.passed ? 'PASS' : 'FAIL',
          r.counted ? String(r.counted.attemptNo) : '',
          r.counted?.submittedAt ? formatLocal(new Date(r.counted.submittedAt), this.d.timeZone) : '',
        ]),
      ]);
    await this.log(actor, meta, 'results.exported', quiz.id as string, { rows: rows.length, role: actor.role });
    return { csv, fileName: `results-${quiz.id as string}.csv` };
  }

  /** One attempt in detail, for the quiz's own teacher (answers next to the effective key, plus every earlier grading). */
  async attemptDetail(actor: AuthContext, quizId: string, attemptId: string) {
    const quiz = await this.quizFor(actor, quizId, 'write');
    const a = await Attempt.findOne({ _id: attemptId, quizId: quiz._id, collegeId: actor.collegeId }).select('+answerKey');
    if (!a) throw Errors.notFound();
    const student = await User.findById(a.studentId).select('name loginId');
    const effective = applyCorrections(a.answerKey ?? {}, optionsOf(a), correctionsOf(quiz));
    const items = new Map((a.grading.items ?? []).map((i): [string, typeof i] => [i.questionId.toString(), i]));
    return {
      attempt: {
        id: a.id as string,
        attemptNo: a.attemptNo,
        status: a.status,
        startedAt: iso(a.startedAt),
        endsAt: iso(a.endsAt),
        submittedAt: iso(a.submittedAt),
        lastSeq: a.lastSeq,
        student: student ? { id: student.id as string, name: student.name, loginId: student.loginId } : null,
      },
      grading: {
        status: a.grading.status,
        score: a.grading.score ?? null,
        totalMarks: a.grading.totalMarks ?? null,
        revision: a.grading.revision,
        quizRevision: a.grading.quizRevision ?? null,
        gradedAt: iso(a.grading.gradedAt),
        history: (a.grading.history ?? []).map((h) => ({ revision: h.revision, quizRevision: h.quizRevision, score: h.score, totalMarks: h.totalMarks, gradedAt: iso(h.gradedAt) })),
      },
      questions: [...a.snapshot.questions]
        .sort((x, y) => x.sequence - y.sequence)
        .map((q) => {
          const id = q.questionId.toString();
          const item = items.get(id);
          return {
            questionId: id,
            sequence: q.sequence,
            type: q.type,
            text: q.text,
            options: q.options.map((o) => ({ optionId: o.optionId, text: o.text })),
            marks: q.marks,
            selectedOptionId: a.answers?.[id]?.selectedOptionId ?? null,
            correctOptionId: effective.key[id] ?? null,
            awarded: item?.awarded ?? null,
            correct: item?.correct ?? null,
            adjusted: item?.adjusted ?? false,
          };
        }),
    };
  }

  // ------------------------------------------------------------------ before publishing
  /** The teacher's "finalize expired attempts" action: closes overdue attempts of THIS quiz (guide Section 8). */
  async finalizeExpired(actor: AuthContext, id: string, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'write');
    const finalized = await this.d.attempts.finalizeExpired({ quizId: quiz.id as string, limit: 1000 });
    const stillRunning = await Attempt.countDocuments({ quizId: quiz._id, status: 'in_progress' });
    await this.log(actor, meta, 'results.attempts_finalized', quiz.id as string, { finalized, stillRunning });
    return { finalized, stillRunning };
  }

  // ------------------------------------------------------------------ publication (D-01)
  async publish(actor: AuthContext, id: string, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'write');
    if (quiz.status === 'draft') throw Errors.conflict('Publish the quiz first');
    if (quiz.resultsPublishedAt) throw Errors.conflict('The results are already published');
    const now = this.now();
    if (quiz.status !== 'closed' && !(quiz.endAt && now >= quiz.endAt)) {
      throw Errors.conflict('The quiz is still open. Close it, or wait until it ends, before publishing results.');
    }
    const running = await Attempt.countDocuments({ quizId: quiz._id, status: 'in_progress' });
    if (running > 0) {
      throw new AppError(409, 'ATTEMPTS_IN_PROGRESS', `${running} student(s) are still taking the quiz. Wait, or use "finalize expired attempts".`, { running });
    }
    const ungraded = await Attempt.countDocuments({
      quizId: quiz._id,
      status: { $in: COUNTED_STATUSES },
      $or: [{ 'grading.status': { $ne: 'done' } }, { 'grading.quizRevision': { $lt: quiz.gradingRevision } }, { 'grading.quizRevision': { $exists: false } }],
    });
    if (ungraded > 0) {
      throw new AppError(409, 'GRADING_INCOMPLETE', `${ungraded} attempt(s) are not graded against the latest corrections yet. Resume the regrade or wait for grading.`, { ungraded });
    }
    const updated = await Quiz.findOneAndUpdate(
      { _id: quiz._id, resultsPublishedAt: null },
      { $set: { resultsPublishedAt: now, resultsPublishedBy: actor.userId }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) throw Errors.conflict('The results were just published by another request');
    await this.log(actor, meta, 'results.published', quiz.id as string, { visibility: updated.resultVisibility, gradingRevision: updated.gradingRevision });
    return { quizId: updated.id as string, resultsPublished: true, resultsPublishedAt: iso(updated.resultsPublishedAt), resultVisibility: updated.resultVisibility };
  }

  async unpublish(actor: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'write');
    const updated = await Quiz.findOneAndUpdate(
      { _id: quiz._id, resultsPublishedAt: { $ne: null } },
      { $unset: { resultsPublishedAt: '', resultsPublishedBy: '' }, $inc: { revision: 1 } },
      { new: true },
    );
    if (!updated) throw Errors.conflict('The results are not published');
    await this.log(actor, meta, 'results.unpublished', quiz.id as string, { reason });
    return { quizId: updated.id as string, resultsPublished: false };
  }

  /** What students may see once published. After publication a change needs a reason (D-01); it is always audited. */
  async setVisibility(actor: AuthContext, id: string, input: { visibility: IQuiz['resultVisibility']; reason?: string }, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'write');
    if (quiz.status === 'draft') throw Errors.conflict('This quiz is still a draft: change the visibility by editing it');
    if (quiz.resultsPublishedAt && !input.reason) throw bad('reason', 'The results are published: a reason is required to change what students can see.');
    const updated = await Quiz.findOneAndUpdate({ _id: quiz._id }, { $set: { resultVisibility: input.visibility }, $inc: { revision: 1 } }, { new: true });
    if (!updated) throw Errors.notFound();
    await this.log(actor, meta, 'results.visibility_changed', quiz.id as string, { from: quiz.resultVisibility, to: input.visibility, published: Boolean(quiz.resultsPublishedAt), reason: input.reason ?? null });
    return { quizId: updated.id as string, resultVisibility: updated.resultVisibility, resultsPublished: Boolean(updated.resultsPublishedAt) };
  }

  // ------------------------------------------------------------------ audited regrade (Runbook B)
  /**
   * Records an answer-key correction on the quiz and regrades every finished attempt against it. The original grade is kept on
   * each attempt (`grading.history`), the correction is kept on the quiz, and nothing is ever edited silently.
   * After publication the person who approved it must be named (D-05). Safe to repeat or resume.
   */
  async regrade(actor: AuthContext, id: string, input: RegradeInput, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'write');
    if (quiz.status === 'draft') throw Errors.conflict('This quiz has no attempts to regrade');
    const published = Boolean(quiz.resultsPublishedAt);
    if (published && !input.approvedBy) throw bad('approvedBy', 'The results are published: name the person who approved this correction (exam controller).');

    const inQuiz = new Set(quiz.items.map((i) => i.questionId.toString()));
    const problems: Array<{ path: string; message: string }> = [];
    for (const [i, c] of input.changes.entries()) {
      const qid = c.questionId.toLowerCase();
      if (!inQuiz.has(qid)) {
        problems.push({ path: `changes.${i}.questionId`, message: 'not a question of this quiz' });
      } else if (c.action === 'set_key') {
        const known = await Attempt.exists({
          quizId: quiz._id,
          status: { $in: COUNTED_STATUSES },
          'snapshot.questions': { $elemMatch: { questionId: new Types.ObjectId(qid), 'options.optionId': c.correctOptionId } },
        });
        if (!known) problems.push({ path: `changes.${i}.correctOptionId`, message: 'not an option of this question in any finished attempt' });
      }
    }
    if (problems.length > 0) throw Errors.validation(problems);
    if ((await Attempt.exists({ quizId: quiz._id, status: { $in: COUNTED_STATUSES } })) === null) {
      throw Errors.conflict('There are no finished attempts to regrade yet. Fix the question in your bank instead.');
    }

    const revision = quiz.gradingRevision + 1;
    const updated = await Quiz.findOneAndUpdate(
      { _id: quiz._id, gradingRevision: quiz.gradingRevision },
      {
        $push: {
          corrections: {
            revision,
            at: this.now(),
            by: actor.userId,
            reason: input.reason,
            ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
            changes: input.changes.map((c) => ({ questionId: new Types.ObjectId(c.questionId), action: c.action, ...(c.action === 'set_key' ? { correctOptionId: c.correctOptionId } : {}) })),
          },
        },
        $set: { gradingRevision: revision },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (!updated) throw Errors.conflict('Another correction was recorded at the same moment. Reload and try again');

    await this.log(actor, meta, 'results.regrade_requested', quiz.id as string, {
      revision,
      reason: input.reason,
      approvedBy: input.approvedBy ?? null,
      published,
      changes: input.changes.map((c) => ({ action: c.action })), // never the key itself
    });
    const stats = await this.d.attempts.applyPendingCorrections(quiz._id);
    await this.log(actor, meta, 'results.regraded', quiz.id as string, { revision, ...stats });
    return { revision, ...stats, resultsPublished: published };
  }

  /** If a regrade was interrupted, finish it. */
  async resumeRegrade(actor: AuthContext, id: string, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'write');
    const stats = await this.d.attempts.applyPendingCorrections(quiz._id);
    await this.log(actor, meta, 'results.regrade_resumed', quiz.id as string, { revision: quiz.gradingRevision, ...stats });
    return { revision: quiz.gradingRevision, ...stats };
  }

  // ------------------------------------------------------------------ what a student may see
  private async studentQuiz(actor: AuthContext, quizId: string): Promise<QuizDoc> {
    if (actor.role !== 'STUDENT') throw Errors.forbidden();
    const quiz = await Quiz.findOne({ _id: quizId, collegeId: actor.collegeId, status: { $in: ['published', 'paused', 'closed'] } });
    if (!quiz) throw Errors.notFound();
    const enrolled = await Enrollment.exists({
      collegeId: actor.collegeId,
      studentId: actor.userId,
      academicYearId: quiz.academicYearId,
      $or: quiz.targets.map((t) => ({ classId: t.classId, divisionId: t.divisionId })),
    });
    if (!enrolled) throw Errors.notFound();
    return quiz;
  }

  /**
   * A released result. Nothing is returned until the teacher has published it AND chosen a visibility other than `hidden`.
   * `score_only`: the score. `score_and_answers`: additionally a per-question review, which is the ONLY student response that
   * carries the correct option, and only for the student's own official attempt after release.
   */
  async studentResult(actor: AuthContext, quizId: string) {
    const quiz = await this.studentQuiz(actor, quizId);
    if (!quiz.resultsPublishedAt || quiz.resultVisibility === 'hidden') {
      throw new AppError(409, 'RESULT_NOT_RELEASED', 'Your result has not been released yet.');
    }
    const withKey = quiz.resultVisibility === 'score_and_answers';
    const find = Attempt.find({ quizId: quiz._id, studentId: actor.userId, status: { $in: COUNTED_STATUSES } }).sort({ attemptNo: 1 });
    const attempts = await (withKey ? find.select('+answerKey') : find);
    if (attempts.length === 0) throw Errors.notFound(); // they did not take this quiz
    const counted = pickCounted(attempts.map(toRow));
    const doc = counted ? attempts.find((a) => a.attemptNo === counted.attemptNo) : undefined;
    if (!counted || !doc) throw new AppError(409, 'RESULT_NOT_READY', 'Your result is still being processed. Please check again shortly.');

    const total = counted.totalMarks ?? quiz.totalMarks;
    const score = counted.score ?? 0;
    const base = {
      quiz: { id: quiz.id as string, title: quiz.title, totalMarks: total, passMarks: quiz.passMarks ?? null },
      visibility: quiz.resultVisibility,
      releasedAt: iso(quiz.resultsPublishedAt),
      result: { attemptNo: counted.attemptNo, status: counted.status, score, totalMarks: total, percentage: percentage(score, total), passed: isPassed(score, quiz.passMarks), submittedAt: iso(counted.submittedAt) },
      attempts: attempts.map((a) => ({ attemptNo: a.attemptNo, status: a.status, score: a.grading.status === 'done' ? (a.grading.score ?? 0) : null, submittedAt: iso(a.submittedAt) })),
    };
    if (!withKey) return base;

    const effective = applyCorrections(doc.answerKey ?? {}, optionsOf(doc), correctionsOf(quiz));
    const items = new Map((doc.grading.items ?? []).map((i): [string, typeof i] => [i.questionId.toString(), i]));
    return {
      ...base,
      review: [...doc.snapshot.questions]
        .sort((x, y) => x.sequence - y.sequence)
        .map((q) => {
          const id = q.questionId.toString();
          return {
            questionId: id,
            sequence: q.sequence,
            text: q.text,
            options: q.options.map((o) => ({ optionId: o.optionId, text: o.text })),
            marks: q.marks,
            selectedOptionId: doc.answers?.[id]?.selectedOptionId ?? null,
            correctOptionId: effective.key[id] ?? null,
            awarded: items.get(id)?.awarded ?? 0,
            isCorrect: items.get(id)?.correct ?? false,
          };
        }),
    };
  }

  /** The student's released results, newest first. Hidden or unpublished quizzes never appear. */
  async studentResults(actor: AuthContext, q: { page: number; pageSize: number }) {
    if (actor.role !== 'STUDENT') throw Errors.forbidden();
    const attempts = await Attempt.find({ collegeId: actor.collegeId, studentId: actor.userId, status: { $in: COUNTED_STATUSES }, 'grading.status': 'done' })
      .select('quizId attemptNo status submittedAt grading.status grading.score grading.totalMarks')
      .limit(500);
    const byQuiz = new Map<string, AttemptDoc[]>();
    for (const a of attempts) byQuiz.set(a.quizId.toString(), [...(byQuiz.get(a.quizId.toString()) ?? []), a]);

    const quizzes = await Quiz.find({
      _id: { $in: [...byQuiz.keys()] },
      collegeId: actor.collegeId,
      resultsPublishedAt: { $ne: null },
      resultVisibility: { $ne: 'hidden' },
    });
    const subjects = await Subject.find({ _id: { $in: quizzes.map((z) => z.subjectId) } });
    const subjectById = new Map(subjects.map((s): [string, { code: string; name: string }] => [s.id as string, { code: s.code, name: s.name }]));

    const items = quizzes
      .map((z) => {
        const counted = pickCounted((byQuiz.get(z.id as string) ?? []).map(toRow));
        if (!counted) return null;
        const total = counted.totalMarks ?? z.totalMarks;
        const score = counted.score ?? 0;
        return {
          quizId: z.id as string,
          title: z.title,
          subject: subjectById.get(z.subjectId.toString()) ?? null,
          visibility: z.resultVisibility,
          releasedAt: iso(z.resultsPublishedAt),
          attemptNo: counted.attemptNo,
          score,
          totalMarks: total,
          percentage: percentage(score, total),
          passed: isPassed(score, z.passMarks),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((x, y) => (y.releasedAt ?? '').localeCompare(x.releasedAt ?? ''));
    return { items: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), page: q.page, pageSize: q.pageSize, total: items.length };
  }
}
