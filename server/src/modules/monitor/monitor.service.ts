import { Types, type FilterQuery } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { AppError, Errors } from '../../common/errors';
import { duplicateKey } from '../../common/mongo';
import type { RequestMeta } from '../../common/request';
import { Division, Enrollment, SchoolClass, type IEnrollment } from '../academics/academics.models';
import { Attempt, type AttemptDoc, type IAttempt } from '../attempts/attempt.model';
import type { AttemptService } from '../attempts/attempt.service';
import type { AuditService } from '../audit/audit.service';
import { Quiz, type IQuiz, type QuizDoc } from '../quizzes/quiz.model';
import { displayState } from '../quizzes/quiz.rules';
import { User } from '../users/user.model';
import type { ExtendInput } from './monitor.schemas';
import { extendedMinutes, isStalled, MAX_TOTAL_EXTENSION_MINUTES, monitorStatus, remainingSeconds, rowRank, type MonitorStatus } from './monitor.rules';

const MAX_ROWS = 5000;
const POLL_SECONDS = 10;
const iso = (d?: Date) => (d ? d.toISOString() : null);

export interface MonitorDeps {
  audit: AuditService;
  attempts: AttemptService;
  graceMs: number;
  stallMs: number;
  now?: () => Date;
}

type Mode = 'read' | 'teacher' | 'teacher_or_admin';

/**
 * Live monitor and recovery controls (guide Phase 10, Section 8). Every control needs a reason and is audited; none of them edits
 * the database by hand. Teachers act on their own quizzes; HOD can only watch; SUPER_ADMIN can watch and, in an emergency,
 * extend time or close an exam (D-02, D-15).
 */
export class MonitorService {
  constructor(private readonly d: MonitorDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private log(actor: AuthContext, meta: RequestMeta, action: string, targetId: string, summary?: Record<string, unknown>) {
    // Never put student names, answers or keys in an audit record.
    return this.d.audit.record({ collegeId: actor.collegeId, actorId: actor.userId, action, targetType: 'quiz', targetId, summary: { ...summary, role: actor.role }, requestId: meta.requestId, ip: meta.ip });
  }

  private async quizFor(actor: AuthContext, id: string, mode: Mode): Promise<QuizDoc> {
    const filter: FilterQuery<IQuiz> = { _id: id, collegeId: actor.collegeId };
    if (actor.role === 'TEACHER') {
      filter.createdBy = actor.userId;
    } else if (mode === 'read' && actor.role === 'HOD') {
      if (!actor.departmentId) throw Errors.forbidden();
      filter.departmentId = new Types.ObjectId(actor.departmentId);
    } else if (actor.role === 'SUPER_ADMIN' && (mode === 'read' || mode === 'teacher_or_admin')) {
      // college-wide
    } else {
      throw Errors.forbidden();
    }
    const quiz = await Quiz.findOne(filter);
    if (!quiz) throw Errors.notFound(); // not yours or does not exist: indistinguishable
    return quiz;
  }

  // ------------------------------------------------------------------ the live view
  /**
   * Everyone who should sit this quiz, and where they are right now. Built for polling every ~10 s: it never loads answers or
   * snapshots, only small progress fields. `view=summary` returns just the counts.
   */
  async monitor(actor: AuthContext, id: string, q: { page: number; pageSize: number; status?: MonitorStatus | 'stalled'; view: 'full' | 'summary' }) {
    const quiz = await this.quizFor(actor, id, 'read');
    const now = this.now();
    const filter: FilterQuery<IEnrollment> = {
      collegeId: quiz.collegeId,
      academicYearId: quiz.academicYearId,
      $or: quiz.targets.map((t) => ({ classId: t.classId, divisionId: t.divisionId })),
    };
    const enrollments = await Enrollment.find(filter).limit(MAX_ROWS + 1);
    if (enrollments.length > MAX_ROWS) throw Errors.conflict(`Too many students to monitor at once (maximum ${MAX_ROWS})`);
    const studentIds = enrollments.map((e) => e.studentId);

    const [users, attempts, classes, divisions] = await Promise.all([
      User.find({ _id: { $in: studentIds }, collegeId: quiz.collegeId }).select('name loginId'),
      Attempt.find({ quizId: quiz._id, studentId: { $in: studentIds } }).select('studentId attemptNo status startedAt endsAt submittedAt lastSeq lastActivityAt extensions grading.status'),
      SchoolClass.find({ _id: { $in: quiz.targets.map((t) => t.classId) } }),
      Division.find({ _id: { $in: quiz.targets.map((t) => t.divisionId) } }),
    ]);
    const userById = new Map(users.map((u): [string, typeof u] => [u.id as string, u]));
    const classById = new Map(classes.map((c): [string, { code: string; name: string }] => [c.id as string, { code: c.code, name: c.name }]));
    const divisionById = new Map(divisions.map((v): [string, { name: string }] => [v.id as string, { name: v.name }]));
    const byStudent = new Map<string, AttemptDoc[]>();
    for (const a of attempts) byStudent.set(a.studentId.toString(), [...(byStudent.get(a.studentId.toString()) ?? []), a]);

    const rows = enrollments.map((e) => {
      const mine = (byStudent.get(e.studentId.toString()) ?? []).sort((x, y) => x.attemptNo - y.attemptNo);
      const status = monitorStatus(mine.map((a) => ({ status: a.status, attemptNo: a.attemptNo })));
      const running = mine.find((a) => a.status === 'in_progress');
      const stalled = running ? isStalled(running, now, this.d.stallMs) : false;
      const cur = running ?? mine[mine.length - 1];
      const u = userById.get(e.studentId.toString());
      return {
        student: u ? { id: u.id as string, name: u.name, loginId: u.loginId } : null,
        rollNo: e.rollNo,
        class: classById.get(e.classId.toString()) ?? null,
        division: divisionById.get(e.divisionId.toString()) ?? null,
        status,
        stalled,
        attemptsCount: mine.length,
        attempt: cur
          ? {
              id: cur.id as string,
              attemptNo: cur.attemptNo,
              status: cur.status,
              startedAt: iso(cur.startedAt),
              endsAt: iso(cur.endsAt),
              submittedAt: iso(cur.submittedAt),
              remainingSeconds: cur.status === 'in_progress' ? remainingSeconds(cur.endsAt, now) : null,
              lastSeq: cur.lastSeq,
              lastSavedAt: cur.status === 'in_progress' ? iso(cur.lastActivityAt) : null,
              extendedMinutes: extendedMinutes(cur.extensions),
            }
          : null,
      };
    });

    const counts = {
      eligible: rows.length,
      notStarted: rows.filter((r) => r.status === 'not_started').length,
      inProgress: rows.filter((r) => r.status === 'in_progress').length,
      stalled: rows.filter((r) => r.stalled).length,
      submitted: rows.filter((r) => r.status === 'submitted').length,
      autoSubmitted: rows.filter((r) => r.status === 'auto_submitted').length,
      // finished attempts that are not graded (yet): publication waits for these
      ungraded: attempts.filter((a) => (a.status === 'submitted' || a.status === 'auto_submitted') && a.grading.status !== 'done').length,
    };

    const base = {
      quiz: {
        id: quiz.id as string,
        title: quiz.title,
        status: quiz.status,
        state: displayState(quiz, now),
        startAt: iso(quiz.startAt),
        endAt: iso(quiz.endAt),
        durationMinutes: quiz.durationMinutes ?? null,
        resultsPublished: Boolean(quiz.resultsPublishedAt),
      },
      serverNow: now.toISOString(),
      lastUpdated: now.toISOString(),
      pollAfterSeconds: POLL_SECONDS, // sensible polling: the page asks again after this long, not continuously
      counts,
    };
    if (q.view === 'summary') return base;

    rows.sort(
      (x, y) =>
        rowRank(x.status, x.stalled) - rowRank(y.status, y.stalled) ||
        (x.attempt?.remainingSeconds ?? Number.MAX_SAFE_INTEGER) - (y.attempt?.remainingSeconds ?? Number.MAX_SAFE_INTEGER) ||
        (x.class?.code ?? '').localeCompare(y.class?.code ?? '') ||
        (x.division?.name ?? '').localeCompare(y.division?.name ?? '') ||
        x.rollNo.localeCompare(y.rollNo, undefined, { numeric: true }),
    );
    const filtered = q.status ? rows.filter((r) => (q.status === 'stalled' ? r.stalled : r.status === q.status)) : rows;
    return { ...base, items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), page: q.page, pageSize: q.pageSize, total: filtered.length };
  }

  // ------------------------------------------------------------------ extend time
  /**
   * Adds minutes to running attempts. The new deadline is the old one plus the minutes; before/after are recorded on each attempt.
   * The attempt's deadline may exceed the quiz window (guide Section 8). Expired attempts are NOT revived (use reopen), and the
   * total added to one attempt is capped. Students see the new deadline at their next save or sync.
   */
  async extend(actor: AuthContext, id: string, input: ExtendInput, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'teacher_or_admin');
    if (quiz.status === 'draft') throw Errors.conflict('This quiz has not started');
    const now = this.now();

    const filter: FilterQuery<IAttempt> = { quizId: quiz._id, status: 'in_progress' };
    if (input.scope === 'students') filter.studentId = { $in: input.studentIds };
    else if (input.scope === 'attempts') filter._id = { $in: input.attemptIds };
    const targets = await Attempt.find(filter).limit(MAX_ROWS + 1).select('studentId endsAt extensions');
    if (targets.length > MAX_ROWS) throw Errors.conflict('Too many attempts to extend at once');
    if (targets.length === 0 && input.scope !== 'all') {
      throw new AppError(409, 'NO_MATCHING_ATTEMPTS', 'None of the selected students has an attempt in progress.');
    }

    const stats = { extended: 0, expired: 0, capped: 0, skipped: 0 };
    const affected: Array<{ attemptId: string; studentId: string; beforeEndsAt: string; afterEndsAt: string }> = [];
    const apply = async (a: (typeof targets)[number]) => {
      if (now.getTime() > a.endsAt.getTime() + this.d.graceMs) return void stats.expired++; // already out of time
      if (extendedMinutes(a.extensions) + input.minutes > MAX_TOTAL_EXTENSION_MINUTES) return void stats.capped++;
      const after = new Date(a.endsAt.getTime() + input.minutes * 60_000);
      // Conditional on the deadline we read: a concurrent change makes this a no-op instead of a lost update.
      const res = await Attempt.updateOne(
        { _id: a._id, status: 'in_progress', endsAt: a.endsAt },
        { $set: { endsAt: after }, $push: { extensions: { at: now, by: new Types.ObjectId(actor.userId), minutes: input.minutes, reason: input.reason, beforeEndsAt: a.endsAt, afterEndsAt: after } } },
      );
      if (res.matchedCount !== 1) return void stats.skipped++;
      stats.extended++;
      if (affected.length < 50) affected.push({ attemptId: a.id as string, studentId: a.studentId.toString(), beforeEndsAt: a.endsAt.toISOString(), afterEndsAt: after.toISOString() });
    };
    for (let i = 0; i < targets.length; i += 25) await Promise.all(targets.slice(i, i + 25).map(apply));

    await this.log(actor, meta, 'quizzes.time_extended', quiz.id as string, {
      scope: input.scope,
      minutes: input.minutes,
      reason: input.reason,
      ...stats,
      ...(input.scope === 'students' ? { studentIds: input.studentIds } : {}),
      ...(input.scope === 'attempts' ? { attemptIds: input.attemptIds } : {}),
    });
    return { scope: input.scope, minutes: input.minutes, ...stats, affected };
  }

  // ------------------------------------------------------------------ reopen
  /**
   * Returns a FINISHED attempt to in_progress with a new deadline (now + minutes): for example an accidental submit or a student
   * auto-submitted by a network failure. The student's answers are kept, the previous grade is kept in the grading history, grading
   * resets to pending and is redone (as a new revision) when the attempt ends again. It does not use up another attempt.
   */
  async reopen(actor: AuthContext, quizId: string, attemptId: string, input: { minutes: number; reason: string }, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, quizId, 'teacher');
    if (quiz.status === 'draft') throw Errors.conflict('This quiz has not started');
    if (quiz.resultsPublishedAt) throw Errors.conflict('The results are published. Unpublish them before reopening an attempt.');

    const a = await Attempt.findOne({ _id: attemptId, quizId: quiz._id, collegeId: actor.collegeId });
    if (!a) throw Errors.notFound();
    if (a.status !== 'submitted' && a.status !== 'auto_submitted') throw Errors.conflict(`Only a submitted attempt can be reopened (this one is ${a.status})`);
    if ((await Attempt.exists({ quizId: quiz._id, studentId: a.studentId, status: 'in_progress' })) !== null) {
      throw Errors.conflict('This student already has an attempt in progress');
    }

    const now = this.now();
    const newEndsAt = new Date(now.getTime() + input.minutes * 60_000);
    const previous = a.grading.status === 'done' && a.grading.score !== undefined
      ? { revision: a.grading.revision, quizRevision: a.grading.quizRevision ?? 0, score: a.grading.score, totalMarks: a.grading.totalMarks ?? 0, gradedAt: a.grading.gradedAt ?? now }
      : undefined;
    try {
      const updated = await Attempt.findOneAndUpdate(
        { _id: a._id, status: { $in: ['submitted', 'auto_submitted'] } },
        {
          $set: { status: 'in_progress', endsAt: newEndsAt, lastActivityAt: now, 'grading.status': 'pending' },
          $unset: { submittedAt: '' },
          $push: {
            extensions: { at: now, by: new Types.ObjectId(actor.userId), minutes: input.minutes, reason: input.reason, beforeEndsAt: a.endsAt, afterEndsAt: newEndsAt },
            ...(previous ? { 'grading.history': previous } : {}),
          },
        },
        { new: true },
      );
      if (!updated) throw Errors.conflict('The attempt changed; reload and try again');
      await this.log(actor, meta, 'attempts.reopened', quiz.id as string, { attemptId: a.id as string, attemptNo: a.attemptNo, from: a.status, minutes: input.minutes, reason: input.reason });
      return {
        attempt: { id: updated.id as string, attemptNo: updated.attemptNo, status: updated.status, endsAt: updated.endsAt.toISOString() },
        serverNow: now.toISOString(),
      };
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('This student already has an attempt in progress'); // the one-active-attempt index
      throw err;
    }
  }

  // ------------------------------------------------------------------ emergency close
  /**
   * Stops the exam: no new starts, and every running attempt is finalized as auto_submitted with its last acknowledged answers.
   * Idempotent (a second call finds nothing left). For teachers (own quiz) and SUPER_ADMIN; the reason is mandatory.
   */
  async emergencyClose(actor: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const quiz = await this.quizFor(actor, id, 'teacher_or_admin');
    if (quiz.status === 'draft') throw Errors.conflict('This quiz has not started');
    const now = this.now();

    // 1. Close the quiz first, so nobody can start while the attempts are being closed.
    const closed = await Quiz.updateOne(
      { _id: quiz._id, status: { $in: ['published', 'paused'] } },
      { $set: { status: 'closed', closedAt: now, statusReason: reason }, $inc: { revision: 1 } },
    );
    // 2. Finalize every running attempt (repeat until none is left: a start that was in flight can still land).
    let finalized = 0;
    for (let round = 0; round < 10; round++) {
      const rows = await Attempt.find({ quizId: quiz._id, status: 'in_progress' }).limit(500).select('_id');
      if (rows.length === 0) break;
      for (const r of rows) await this.d.attempts.finalize(r._id, 'auto_submitted', now);
      finalized += rows.length;
    }
    await this.log(actor, meta, 'quizzes.emergency_closed', quiz.id as string, { reason, finalized, wasStatus: quiz.status, quizClosedNow: closed.modifiedCount === 1 });
    return { finalized, quizStatus: 'closed' as const };
  }
}
