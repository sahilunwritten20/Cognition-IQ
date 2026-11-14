import { Types, type FilterQuery } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { AppError, Errors } from '../../common/errors';
import type { Logger } from '../../common/logger';
import { duplicateKey } from '../../common/mongo';
import type { CounterStore } from '../../common/rateLimit';
import type { RequestMeta } from '../../common/request';
import { Enrollment } from '../academics/academics.models';
import { toStudentQuestionDto } from '../questions/question.dto';
import { Question } from '../questions/question.model';
import { verifyQuizCode } from '../quizzes/quiz.code';
import { Quiz } from '../quizzes/quiz.model';
import { evaluateAvailability, REASON_TEXT } from '../quizzes/quiz.rules';
import { Attempt, COUNTED_STATUSES, type AttemptDoc, type IAttempt, type IAttemptQuestion } from './attempt.model';
import type { SaveInput, SubmitInput } from './attempt.schemas';
import { applyCorrections, gradeAttempt, type QuizCorrection } from './grading';

// Per-user limits on exam endpoints (never per IP: a whole classroom shares one NAT address). Starting values.
const LIMITS = { start: 30, autosave: 90, submit: 30, read: 60 }; // requests per user per minute
const CODE_FAILURES = 10; // wrong access codes per student per quiz per 15 minutes

const iso = (d: Date) => d.toISOString();

export const optionsOf = (a: AttemptDoc): Record<string, string[]> =>
  Object.fromEntries(a.snapshot.questions.map((q): [string, string[]] => [q.questionId.toString(), q.options.map((o) => o.optionId)]));

export const correctionsOf = (quiz: { corrections?: Array<{ revision: number; changes: Array<{ questionId: Types.ObjectId; action: 'set_key' | 'award_all'; correctOptionId?: string }> }> } | null): QuizCorrection[] =>
  (quiz?.corrections ?? []).map((c) => ({
    revision: c.revision,
    changes: c.changes.map((ch) => ({ questionId: ch.questionId.toString(), action: ch.action, correctOptionId: ch.correctOptionId })),
  }));

export interface AttemptServiceDeps {
  store: CounterStore;
  codeKey: string;
  graceMs: number; // D-12: the server still accepts saves/submits up to endsAt + grace
  logger: Logger;
  now?: () => Date;
}

type AnswerInput = SaveInput['answers'];
type ApplyResult = { outcome: 'applied' | 'stale' | 'closed'; lastSeq: number };

/**
 * The exam engine. The SERVER owns every rule: eligibility, attempt limits, deadlines, answer acceptance, grading.
 * The browser only displays (guide Section 0). Every mutation is a single conditional atomic update, so
 * double clicks, retries, two tabs, out-of-order requests and duplicate sweeper runs all converge on one result.
 */
export class AttemptService {
  constructor(private readonly d: AttemptServiceDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private async rate(actor: AuthContext, name: keyof typeof LIMITS): Promise<void> {
    const n = await this.d.store.incr(`exam:${name}:${actor.userId}`, 60);
    if (n > LIMITS[name]) throw Errors.rateLimited();
  }

  private pastGrace(a: { endsAt: Date }, now: Date): boolean {
    return now.getTime() > a.endsAt.getTime() + this.d.graceMs;
  }

  // ------------------------------------------------------------------ response shapes (explicit allow-lists)
  private attemptDto(a: AttemptDoc) {
    return {
      id: a.id as string,
      quizId: a.quizId.toString(),
      attemptNo: a.attemptNo,
      status: a.status,
      startedAt: iso(a.startedAt),
      endsAt: iso(a.endsAt),
      submittedAt: a.submittedAt ? iso(a.submittedAt) : null,
      lastSeq: a.lastSeq,
    };
  }

  /** A finished attempt: status only. No score, no grading, no answers (those are released by the teacher later). */
  private finalDto(a: AttemptDoc, now: Date) {
    return { attempt: this.attemptDto(a), serverNow: iso(now) };
  }

  /** An attempt in progress: what the exam screen needs, built ONLY from the snapshot (which has no answer key). */
  private liveDto(a: AttemptDoc, now: Date) {
    const questions = [...a.snapshot.questions]
      .sort((x, y) => x.sequence - y.sequence)
      .map((q) => toStudentQuestionDto({ id: q.questionId.toString(), type: q.type, text: q.text, options: q.options, marks: q.marks }, q.sequence));
    const answers = Object.entries(a.answers ?? {})
      .filter(([, v]) => v.selectedOptionId !== null)
      .map(([questionId, v]) => ({ questionId, selectedOptionId: v.selectedOptionId }));
    return {
      attempt: this.attemptDto(a),
      quiz: { title: a.snapshot.title, instructions: a.snapshot.instructions ?? null, totalMarks: a.snapshot.totalMarks, questionCount: questions.length },
      questions,
      answers,
      serverNow: iso(now), // the browser timer is display-only; it syncs to this and to attempt.endsAt
    };
  }

  private finished(a: AttemptDoc) {
    return new AppError(409, 'ATTEMPT_FINISHED', 'This attempt has already been submitted.', { status: a.status, submittedAt: a.submittedAt ? iso(a.submittedAt) : null });
  }

  private async loadOwn(actor: AuthContext, id: string): Promise<AttemptDoc> {
    if (actor.role !== 'STUDENT') throw Errors.forbidden();
    const a = await Attempt.findOne({ _id: id, collegeId: actor.collegeId, studentId: actor.userId });
    if (!a) throw Errors.notFound(); // not yours or does not exist: indistinguishable
    return a;
  }

  // ------------------------------------------------------------------ finalize + grade (idempotent, shared with the sweeper)
  /**
   * Closes an attempt exactly once (in_progress -> submitted | auto_submitted) and grades it. Safe to call any number of
   * times, from any number of requests or sweepers at once: only one call flips the status, the rest see the final state.
   * Auto-submit uses the answers last acknowledged by the server.
   */
  async finalize(attemptId: Types.ObjectId | string, mode: 'submitted' | 'auto_submitted', at: Date): Promise<AttemptDoc | null> {
    const flipped = await Attempt.findOneAndUpdate({ _id: attemptId, status: 'in_progress' }, { $set: { status: mode, submittedAt: at } }, { new: true });
    const attempt = flipped ?? (await Attempt.findById(attemptId));
    if (!attempt) return null;
    if (attempt.status !== 'in_progress' && attempt.grading.status === 'pending') await this.grade(attempt._id);
    return attempt;
  }

  /** Objective grading from the attempt's own snapshot and protected key. Idempotent: only a `pending` attempt is graded. */
  async grade(attemptId: Types.ObjectId): Promise<void> {
    const a = await Attempt.findById(attemptId).select('+answerKey');
    if (!a || a.status === 'in_progress' || a.grading.status !== 'pending') return;
    try {
      // The quiz's audited corrections apply to EVERY attempt, including ones graded late, so grading is always consistent.
      const quiz = await Quiz.findById(a.quizId).select('corrections gradingRevision');
      const effective = applyCorrections(a.answerKey ?? {}, optionsOf(a), correctionsOf(quiz));
      const result = gradeAttempt(
        a.snapshot.questions.map((q) => ({ questionId: q.questionId.toString(), marks: q.marks })),
        effective.key,
        a.answers ?? {},
        effective.awardAll,
      );
      await Attempt.updateOne(
        { _id: a._id, 'grading.status': 'pending' },
        {
          $set: {
            'grading.status': 'done',
            'grading.score': result.score,
            'grading.totalMarks': result.totalMarks,
            'grading.revision': 1,
            'grading.quizRevision': quiz?.gradingRevision ?? 0,
            'grading.gradedAt': this.now(),
            'grading.items': result.items,
          },
        },
      );
    } catch (err) {
      // The submission is already durable. Mark the grading failed so it is visible and can be retried by a regrade.
      this.d.logger.error({ err, attemptId: a.id }, 'grading_failed');
      await Attempt.updateOne({ _id: a._id, 'grading.status': 'pending' }, { $set: { 'grading.status': 'failed' } });
    }
  }

  /** Lazy finalization: any request touching an attempt past endsAt + grace closes it. Returns the attempt if still open. */
  private async liveOrFinalize(a: AttemptDoc, now: Date): Promise<AttemptDoc | null> {
    if (a.status !== 'in_progress') return null;
    if (!this.pastGrace(a, now)) return a;
    await this.finalize(a._id, 'auto_submitted', now);
    return null;
  }

  // ------------------------------------------------------------------ start (atomic, race-safe)
  async start(actor: AuthContext, quizId: string, input: { accessCode?: string }, _meta: RequestMeta) {
    if (actor.role !== 'STUDENT') throw Errors.forbidden();
    await this.rate(actor, 'start');
    const now = this.now();

    const quiz = await Quiz.findOne({ _id: quizId, collegeId: actor.collegeId, status: { $in: ['published', 'paused', 'closed'] } });
    if (!quiz) throw Errors.notFound(); // drafts and unknown ids look the same

    // Eligibility: enrolled, in the quiz's academic year, in one of its class+divisions. Otherwise it does not exist for you.
    const eligible = await Enrollment.exists({
      collegeId: actor.collegeId,
      studentId: actor.userId,
      academicYearId: quiz.academicYearId,
      $or: quiz.targets.map((t) => ({ classId: t.classId, divisionId: t.divisionId })),
    });
    if (!eligible) throw Errors.notFound();

    // Resume first: a running attempt continues even if the quiz was paused or closed since (pause blocks NEW starts only).
    const active = await Attempt.findOne({ quizId: quiz._id, studentId: actor.userId, status: 'in_progress' });
    if (active) {
      const live = await this.liveOrFinalize(active, now);
      if (live) return { ...this.liveDto(live, now), resumed: true };
      // It had just expired and was finalized: continue as a fresh start decision below.
    }

    const used = await Attempt.countDocuments({ quizId: quiz._id, studentId: actor.userId, status: { $in: COUNTED_STATUSES } });
    const availability = evaluateAvailability(quiz, now, used);
    if (!availability.available) {
      throw new AppError(409, 'QUIZ_UNAVAILABLE', REASON_TEXT[availability.reason], { reason: availability.reason });
    }

    // The access code is an ADDITIONAL condition, checked only after every other rule passed. Rate-limited per student per quiz.
    if (quiz.accessMode !== 'scheduled') {
      const key = `quizcode:${actor.userId}:${quiz.id as string}`;
      if ((await this.d.store.get(key)) >= CODE_FAILURES) throw Errors.rateLimited();
      if (!input.accessCode) throw new AppError(403, 'ACCESS_CODE_REQUIRED', 'Enter the access code your teacher gave you.');
      const withHash = await Quiz.findById(quiz._id).select('+codeHash');
      const ok = Boolean(withHash?.codeHash) && verifyQuizCode(withHash?.codeHash ?? '', input.accessCode, this.d.codeKey); // constant-time
      if (!ok) {
        await this.d.store.incr(key, 15 * 60);
        throw new AppError(403, 'INVALID_ACCESS_CODE', 'That access code is not correct.');
      }
      await this.d.store.reset(key);
    }

    // Snapshot (ADR-001): copy the questions AS THEY ARE NOW, with their keys kept apart from the student-visible part.
    const found = await Question.find({ _id: { $in: quiz.items.map((i) => i.questionId) }, collegeId: actor.collegeId }).select('+correctOptionId');
    const byId = new Map(found.map((q): [string, typeof q] => [q.id as string, q]));
    const questions: IAttemptQuestion[] = [];
    const answerKey: Record<string, string> = {};
    for (const [index, item] of quiz.items.entries()) {
      const q = byId.get(item.questionId.toString());
      if (!q) throw new AppError(409, 'QUIZ_CONTENT_UNAVAILABLE', 'This quiz cannot be started right now. Please tell your teacher.');
      questions.push({
        questionId: q._id,
        type: q.type,
        text: q.text,
        options: q.options.map((o) => ({ optionId: o.optionId, text: o.text })),
        marks: item.marks, // marks in THIS quiz
        sequence: index + 1,
      });
      answerKey[q.id as string] = q.correctOptionId;
    }
    // D-11: endsAt = min(startedAt + duration, window end), on the server clock. Client time is never used.
    const endsAt = new Date(Math.min(now.getTime() + (quiz.durationMinutes ?? 0) * 60_000, (quiz.endAt ?? now).getTime()));

    for (let attemptsTried = 0; attemptsTried < 3; attemptsTried++) {
      const last = await Attempt.findOne({ quizId: quiz._id, studentId: actor.userId }).sort({ attemptNo: -1 }).select('attemptNo');
      try {
        const created = await Attempt.create({
          collegeId: actor.collegeId,
          quizId: quiz._id,
          studentId: actor.userId,
          attemptNo: (last?.attemptNo ?? 0) + 1,
          status: 'in_progress',
          snapshot: { quizRevision: quiz.revision, title: quiz.title, instructions: quiz.instructions, totalMarks: quiz.totalMarks, questions },
          answerKey,
          answers: {},
          lastSeq: 0,
          startedAt: now,
          endsAt,
          grading: { status: 'pending', revision: 0 },
        });
        return { ...this.liveDto(created, now), resumed: false };
      } catch (err) {
        if (!duplicateKey(err)) throw err;
        // Lost a race: another request created the attempt first. Return THAT one (idempotent start).
        const existing = await Attempt.findOne({ quizId: quiz._id, studentId: actor.userId, status: 'in_progress' });
        if (existing) {
          const live = await this.liveOrFinalize(existing, now);
          if (live) return { ...this.liveDto(live, now), resumed: true };
        }
        // Otherwise an attempt-number collision: recompute the number and try again.
      }
    }
    throw Errors.conflict('Could not start the quiz right now. Please try again');
  }

  // ------------------------------------------------------------------ resume
  async get(actor: AuthContext, id: string) {
    await this.rate(actor, 'read');
    const now = this.now();
    const a = await this.loadOwn(actor, id);
    if (a.status === 'in_progress') {
      const live = await this.liveOrFinalize(a, now);
      if (live) return this.liveDto(live, now);
      return this.finalDto((await Attempt.findById(a._id)) ?? a, now);
    }
    return this.finalDto(a, now);
  }

  // ------------------------------------------------------------------ autosave
  /** Validates against the snapshot, then applies ALL answers in one conditional update. */
  private async applyAnswers(a: AttemptDoc, seq: number, answers: AnswerInput, now: Date): Promise<ApplyResult> {
    const allowed = new Map(a.snapshot.questions.map((q): [string, Set<string>] => [q.questionId.toString(), new Set(q.options.map((o) => o.optionId))]));
    const problems: Array<{ path: string; message: string }> = [];
    answers.forEach((an, i) => {
      const options = allowed.get(an.questionId.toLowerCase());
      if (!options) problems.push({ path: `answers.${i}.questionId`, message: 'not a question of this quiz' });
      else if (an.selectedOptionId !== null && !options.has(an.selectedOptionId)) problems.push({ path: `answers.${i}.selectedOptionId`, message: 'not an option of this question' });
    });
    if (problems.length > 0) throw Errors.validation(problems); // nothing is applied

    const set: Record<string, unknown> = { lastSeq: seq };
    for (const an of answers) set[`answers.${an.questionId.toLowerCase()}`] = { selectedOptionId: an.selectedOptionId, savedAt: now }; // server time only

    // ONE conditional atomic update: owner, still in progress, deadline + grace not passed, and seq strictly newer.
    const res = await Attempt.updateOne(
      { _id: a._id, studentId: a.studentId, status: 'in_progress', endsAt: { $gte: new Date(now.getTime() - this.d.graceMs) }, lastSeq: { $lt: seq } },
      { $set: set },
    );
    if (res.matchedCount === 1) return { outcome: 'applied', lastSeq: seq };

    const fresh = await Attempt.findById(a._id).select('status lastSeq endsAt');
    if (!fresh || fresh.status !== 'in_progress' || this.pastGrace(fresh, now)) return { outcome: 'closed', lastSeq: fresh?.lastSeq ?? a.lastSeq };
    return { outcome: 'stale', lastSeq: fresh.lastSeq }; // an equal or newer seq was already applied
  }

  async saveAnswers(actor: AuthContext, id: string, input: SaveInput) {
    await this.rate(actor, 'autosave');
    const now = this.now();
    const a = await this.loadOwn(actor, id);
    if (a.status !== 'in_progress') throw this.finished(a);
    if (this.pastGrace(a, now)) {
      await this.finalize(a._id, 'auto_submitted', now);
      throw new AppError(409, 'TIME_UP', 'Time is up. Your attempt was submitted with your last saved answers.');
    }

    const r = await this.applyAnswers(a, input.seq, input.answers, now);
    if (r.outcome === 'closed') {
      const fresh = await Attempt.findById(a._id);
      if (fresh && fresh.status !== 'in_progress') throw this.finished(fresh);
      await this.finalize(a._id, 'auto_submitted', now);
      throw new AppError(409, 'TIME_UP', 'Time is up. Your attempt was submitted with your last saved answers.');
    }
    // A stale request is answered with success: it was already covered by a newer cumulative save, nothing is lost.
    return { ok: true, lastSeq: r.lastSeq, stale: r.outcome === 'stale', serverNow: iso(now), endsAt: iso(a.endsAt) };
  }

  // ------------------------------------------------------------------ submit (idempotent)
  async submit(actor: AuthContext, id: string, input: SubmitInput) {
    await this.rate(actor, 'submit');
    const now = this.now();
    const a = await this.loadOwn(actor, id);
    if (a.status !== 'in_progress') return { ...this.finalDto(a, now), lateRejected: false }; // repeat submit: the same final state

    let late = this.pastGrace(a, now);
    if (!late && input.answers && input.seq !== undefined) {
      const r = await this.applyAnswers(a, input.seq, input.answers, now);
      if (r.outcome === 'closed') {
        const fresh = await Attempt.findById(a._id);
        if (fresh && fresh.status !== 'in_progress') return { ...this.finalDto(fresh, now), lateRejected: false }; // a concurrent submit won
        late = true;
      }
    }
    // After the deadline + grace the request is NOT honoured: the server auto-submits with the last acknowledged answers.
    const done = await this.finalize(a._id, late ? 'auto_submitted' : 'submitted', now);
    return { ...this.finalDto(done ?? a, now), lateRejected: late };
  }

  // ------------------------------------------------------------------ regrade (audited key corrections, Runbook B)
  /**
   * Brings ONE finished attempt up to the quiz's latest correction revision. The previous grading is pushed onto
   * `grading.history`, so the original and every corrected grade stay on record. Safe to repeat: it is conditional on the
   * attempt's own grading revision, and an attempt already at the target revision is left alone.
   */
  async regradeAttempt(attemptId: Types.ObjectId, rev: number, corrections: QuizCorrection[]): Promise<'revised' | 'synced' | 'skipped'> {
    const a = await Attempt.findById(attemptId).select('+answerKey');
    if (!a || a.status === 'in_progress') return 'skipped';
    if (a.grading.status === 'failed') {
      await Attempt.updateOne({ _id: a._id, 'grading.status': 'failed' }, { $set: { 'grading.status': 'pending' } }); // regrade is the retry for failed grading
      await this.grade(a._id);
      return 'synced';
    }
    if (a.grading.status === 'pending') {
      await this.grade(a._id); // grading already applies every correction
      return 'synced';
    }
    if (a.grading.status !== 'done') return 'skipped';

    const seen = a.grading.quizRevision ?? 0;
    if (seen >= rev) return 'synced';
    const touched = new Set(corrections.filter((c) => c.revision > seen).flatMap((c) => c.changes.map((ch) => ch.questionId)));
    if (!a.snapshot.questions.some((q) => touched.has(q.questionId.toString()))) {
      // The correction concerns questions this student never saw: nothing changes, only the revision marker advances.
      await Attempt.updateOne({ _id: a._id, 'grading.status': 'done', 'grading.revision': a.grading.revision }, { $set: { 'grading.quizRevision': rev } });
      return 'synced';
    }

    const effective = applyCorrections(a.answerKey ?? {}, optionsOf(a), corrections);
    const result = gradeAttempt(
      a.snapshot.questions.map((q) => ({ questionId: q.questionId.toString(), marks: q.marks })),
      effective.key,
      a.answers ?? {},
      effective.awardAll,
    );
    const res = await Attempt.updateOne(
      { _id: a._id, 'grading.status': 'done', 'grading.revision': a.grading.revision },
      {
        $push: { 'grading.history': { revision: a.grading.revision, quizRevision: seen, score: a.grading.score ?? 0, totalMarks: a.grading.totalMarks ?? 0, gradedAt: a.grading.gradedAt ?? this.now() } },
        $set: {
          'grading.score': result.score,
          'grading.totalMarks': result.totalMarks,
          'grading.items': result.items,
          'grading.revision': a.grading.revision + 1,
          'grading.quizRevision': rev,
          'grading.gradedAt': this.now(),
        },
      },
    );
    return res.matchedCount === 1 ? 'revised' : 'skipped';
  }

  /** Regrades every finished attempt of a quiz that is behind the quiz's latest correction. Bounded rounds; safe to run again. */
  async applyPendingCorrections(quizId: Types.ObjectId | string): Promise<{ processed: number; revised: number; skipped: number }> {
    const stats = { processed: 0, revised: 0, skipped: 0 };
    const quiz = await Quiz.findById(quizId).select('corrections gradingRevision');
    if (!quiz) return stats;
    const rev = quiz.gradingRevision;
    const corrections = correctionsOf(quiz);
    for (let round = 0; round < 1000; round++) {
      const rows = await Attempt.find({
        quizId: quiz._id,
        status: { $in: COUNTED_STATUSES },
        $or: [{ 'grading.quizRevision': { $lt: rev } }, { 'grading.quizRevision': { $exists: false } }],
      }).limit(200).select('_id');
      if (rows.length === 0) break;
      let progress = 0;
      for (const r of rows) {
        const outcome = await this.regradeAttempt(r._id, rev, corrections);
        stats.processed++;
        if (outcome === 'revised') stats.revised++;
        if (outcome === 'skipped') stats.skipped++;
        else progress++;
      }
      if (progress === 0) break; // stuck attempts must not cause an endless loop
    }
    return stats;
  }

  // ------------------------------------------------------------------ background duties (sweeper, monitor, import pause)
  /** Closes attempts whose deadline + grace has passed. Used by the sweeper and the teacher's "finalize expired" action. */
  async finalizeExpired(opts: { quizId?: string; limit?: number } = {}): Promise<number> {
    const now = this.now();
    const filter: FilterQuery<IAttempt> = { status: 'in_progress', endsAt: { $lt: new Date(now.getTime() - this.d.graceMs) } };
    if (opts.quizId) filter.quizId = opts.quizId;
    const rows = await Attempt.find(filter).sort({ endsAt: 1 }).limit(opts.limit ?? 200).select('_id');
    for (const r of rows) await this.finalize(r._id, 'auto_submitted', now);
    return rows.length;
  }

  /** Grades attempts that were closed but not yet graded (for example the process died between the two steps). */
  async gradePending(limit = 200): Promise<number> {
    const rows = await Attempt.find({ status: { $in: COUNTED_STATUSES }, 'grading.status': 'pending' }).limit(limit).select('_id');
    for (const r of rows) await this.grade(r._id);
    return rows.length;
  }

  /** True while an exam is running or open: background jobs that burn CPU (imports) wait. */
  async examWindowOpen(): Promise<boolean> {
    const now = this.now();
    if ((await Attempt.exists({ status: 'in_progress' })) !== null) return true;
    return (await Quiz.exists({ status: 'published', startAt: { $lte: now }, endAt: { $gt: now } })) !== null;
  }
}
