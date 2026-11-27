import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Attempt } from '../modules/attempts/attempt.model';
import { AuditLog } from '../modules/audit/audit.model';
import { Enrollment, TeachingAssignment } from '../modules/academics/academics.models';
import { Question } from '../modules/questions/question.model';
import { Quiz } from '../modules/quizzes/quiz.model';
import { User } from '../modules/users/user.model';

/**
 * Integrity check for a RESTORED database (backup drill, guide Phase 12 / Runbook). Point MONGODB_URI at the restored copy, NEVER at
 * production, and run:
 *   npm run restore:check -w server -- [--incident 2026-11-20T10:30:00Z] [--restore-started ...] [--restore-finished ...] [--report docs/operations/restore-drills]
 * It is READ-ONLY. It reports counts, required indexes, referential and state integrity, and (with the timestamps you note during the drill)
 * the measured RPO (data-loss window) and RTO (time to restore). Exit code 1 if any integrity check fails.
 */
const env = z.object({ MONGODB_URI: z.string().min(1) }).parse(process.env);
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

interface IndexInfo { key: Record<string, number>; unique?: boolean; partialFilterExpression?: unknown }
const REQUIRED_INDEXES: Array<{ model: { collection: { indexes(): Promise<unknown[]> }; modelName: string }; key: Record<string, number>; unique: boolean; partial?: boolean }> = [
  { model: User, key: { collegeId: 1, loginId: 1 }, unique: true },
  { model: Attempt, key: { quizId: 1, studentId: 1 }, unique: true, partial: true }, // one in-progress attempt per student per quiz
  { model: Attempt, key: { quizId: 1, studentId: 1, attemptNo: 1 }, unique: true },
  { model: Enrollment, key: { studentId: 1, academicYearId: 1 }, unique: true },
  { model: TeachingAssignment, key: { teacherId: 1, subjectId: 1, classId: 1, divisionId: 1, academicYearId: 1 }, unique: true, partial: true },
];

async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');
  try {
    // ---- counts
    const counts: Record<string, number> = {};
    for (const c of await db.listCollections().toArray()) counts[c.name] = await db.collection(c.name).estimatedDocumentCount();
    add('database has data', Object.values(counts).some((n) => n > 0), JSON.stringify(counts));

    // ---- indexes (a restore that loses an index silently loses a safety guarantee)
    for (const r of REQUIRED_INDEXES) {
      const found = ((await r.model.collection.indexes()) as IndexInfo[]).some((i) => JSON.stringify(i.key) === JSON.stringify(r.key) && Boolean(i.unique) === r.unique && (r.partial ? Boolean(i.partialFilterExpression) : true));
      add(`index on ${r.model.modelName} ${JSON.stringify(r.key)}${r.partial ? ' (partial)' : ''}`, found, found ? 'present' : 'MISSING: rebuild with the application (autoIndex) before going live');
    }

    // ---- integrity
    const dupActive = await Attempt.aggregate([{ $match: { status: 'in_progress' } }, { $group: { _id: { q: '$quizId', s: '$studentId' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'n' }]);
    add('at most one in-progress attempt per student per quiz', (dupActive[0]?.n ?? 0) === 0, `violations: ${dupActive[0]?.n ?? 0}`);

    const orphanAttempts = await Attempt.aggregate([{ $lookup: { from: Quiz.collection.name, localField: 'quizId', foreignField: '_id', as: 'q' } }, { $match: { q: { $size: 0 } } }, { $count: 'n' }]);
    add('every attempt belongs to an existing quiz', (orphanAttempts[0]?.n ?? 0) === 0, `orphans: ${orphanAttempts[0]?.n ?? 0}`);

    const orphanEnrollments = await Enrollment.aggregate([{ $lookup: { from: User.collection.name, localField: 'studentId', foreignField: '_id', as: 'u' } }, { $match: { u: { $size: 0 } } }, { $count: 'n' }]);
    add('every enrollment belongs to an existing student', (orphanEnrollments[0]?.n ?? 0) === 0, `orphans: ${orphanEnrollments[0]?.n ?? 0}`);

    const quizQuestionIds = await Quiz.aggregate([{ $match: { status: { $in: ['published', 'paused', 'closed'] } } }, { $unwind: '$items' }, { $lookup: { from: Question.collection.name, localField: 'items.questionId', foreignField: '_id', as: 'q' } }, { $match: { q: { $size: 0 } } }, { $count: 'n' }]);
    add('every question of a published quiz exists', (quizQuestionIds[0]?.n ?? 0) === 0, `missing: ${quizQuestionIds[0]?.n ?? 0}`);

    const noKey = await Attempt.countDocuments({ answerKey: { $exists: false } });
    add('every attempt still has its answer key (needed for grading and regrade)', noKey === 0, `attempts without a key: ${noKey}`);

    const ungraded = await Attempt.countDocuments({ status: { $in: ['submitted', 'auto_submitted'] }, 'grading.status': { $ne: 'done' } });
    add('no finished attempt is left ungraded (the sweeper grades them after start)', ungraded === 0, `ungraded: ${ungraded}`);

    const stuck = await Attempt.countDocuments({ status: 'in_progress', endsAt: { $lt: new Date(Date.now() - 3_600_000) } });
    add('no attempt is stuck in progress for over an hour (the sweeper finalizes them after start)', stuck === 0, `stuck: ${stuck}`);

    const users = await User.countDocuments({});
    const admins = await User.countDocuments({ role: 'SUPER_ADMIN', status: 'active', deletedAt: null });
    add('at least one active SUPER_ADMIN (two recommended)', admins >= 1, `users=${users}, active super admins=${admins}`);

    // ---- RPO / RTO
    const lastAttempt = await Attempt.findOne().sort({ updatedAt: -1 }).select('updatedAt');
    const lastAudit = await AuditLog.findOne().sort({ at: -1 }).select('at');
    const newest = [lastAttempt?.updatedAt, lastAudit?.at].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];
    const incident = arg('incident') ? new Date(arg('incident') as string) : undefined;
    const rpoMinutes = newest && incident ? Math.round(((incident.getTime() - newest.getTime()) / 60_000) * 10) / 10 : null;
    const started = arg('restore-started') ? new Date(arg('restore-started') as string) : undefined;
    const finished = arg('restore-finished') ? new Date(arg('restore-finished') as string) : undefined;
    const rtoMinutes = started && finished ? Math.round(((finished.getTime() - started.getTime()) / 60_000) * 10) / 10 : null;
    add('measured data-loss window (RPO) is within the 15-minute goal', rpoMinutes === null ? true : rpoMinutes <= 15, rpoMinutes === null ? 'pass --incident <ISO time> to measure' : `${rpoMinutes} min between the newest restored record and the incident`);
    add('measured time to restore (RTO) is within the 60-minute goal', rtoMinutes === null ? true : rtoMinutes <= 60, rtoMinutes === null ? 'pass --restore-started and --restore-finished to measure' : `${rtoMinutes} min`);

    const failed = checks.filter((c) => !c.ok);
    const report = { checkedAt: new Date().toISOString(), newestRestoredRecord: newest?.toISOString() ?? null, counts, rpoMinutes, rtoMinutes, PASS: failed.length === 0, checks };
    console.log(JSON.stringify(report, null, 2));
    const dir = arg('report');
    if (dir) {
      await mkdir(path.resolve(dir), { recursive: true });
      const file = path.join(path.resolve(dir), `restore-drill-${report.checkedAt.slice(0, 10)}.md`);
      await writeFile(
        file,
        [`# Restore drill ${report.checkedAt}`, '', `Result: **${report.PASS ? 'PASS' : 'FAIL'}**`, `Newest restored record: ${report.newestRestoredRecord}`, `RPO: ${rpoMinutes ?? 'not measured'} min (goal 15)  RTO: ${rtoMinutes ?? 'not measured'} min (goal 60)`, '', '| Check | Result | Detail |', '|---|---|---|', ...checks.map((c) => `| ${c.name} | ${c.ok ? 'ok' : '**FAIL**'} | ${c.detail} |`), ''].join('\n'),
      );
      console.log(`Report written to ${file}`);
    }
    process.exitCode = report.PASS ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
