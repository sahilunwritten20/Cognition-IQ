import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { Attempt } from '../modules/attempts/attempt.model';
import { User } from '../modules/users/user.model';
import { expectedAnswers, userIndexOf } from './load-spec';

/**
 * Proves "no loss of server-acknowledged answers" after a load run (guide Section 12).
 *   npm run load:verify -w server -- --quiz <quizId> --acks <file written by k6 --console-output>
 * For every student k6 logged the last autosave the SERVER acknowledged (`ack`). This checks, against the database, that:
 *   1. the server's lastSeq is >= that acknowledged number (nothing acknowledged was lost),
 *   2. the stored answers equal exactly what the deterministic pattern says they must be for that lastSeq (nothing corrupted/reordered),
 *   3. there is at most one attempt per student, and every attempt has been finalized and graded once.
 * Exit code 0 = all good, 1 = a problem (details are printed).
 */
const env = z.object({ MONGODB_URI: z.string().min(1) }).parse(process.env);
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Problem { kind: string; user: number | string; detail: string }

async function main() {
  const quizId = arg('quiz');
  const acksFile = arg('acks');
  if (!quizId || !/^[a-f0-9]{24}$/i.test(quizId)) throw new Error('Pass --quiz <24-hex quiz id>');
  if (!acksFile) throw new Error('Pass --acks <file>');

  const acks = new Map<number, number>();
  for (const line of (await readFile(acksFile, 'utf8')).split(/\r?\n/)) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start < 0 || end < start) continue;
    try {
      // k6 may log the message raw, or quoted with escaped quotes and a trailing " source=console": take {...} and unescape.
      const j = JSON.parse(line.slice(start, end + 1).replace(/\\"/g, '"')) as { ack?: boolean; user?: number; seq?: number };
      if (j.ack && typeof j.user === 'number' && typeof j.seq === 'number') acks.set(j.user, Math.max(acks.get(j.user) ?? 0, j.seq));
    } catch {
      /* not an ack line */
    }
  }

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const attempts = await Attempt.find({ quizId: new Types.ObjectId(quizId) }).select('studentId attemptNo status lastSeq answers snapshot.questions grading.status grading.revision');
    const users = await User.find({ _id: { $in: attempts.map((a) => a.studentId) } }).select('loginId');
    const loginById = new Map(users.map((u): [string, string] => [u.id as string, u.loginId]));

    const problems: Problem[] = [];
    const perStudent = new Map<string, number>();
    const statuses: Record<string, number> = {};
    let graded = 0;
    for (const a of attempts) {
      const loginId = loginById.get(a.studentId.toString()) ?? '?';
      const userIndex = userIndexOf(loginId);
      perStudent.set(loginId, (perStudent.get(loginId) ?? 0) + 1);
      statuses[a.status] = (statuses[a.status] ?? 0) + 1;
      if (a.status === 'in_progress') problems.push({ kind: 'still_running', user: loginId, detail: 'attempt is still in progress (run after the deadline, or finalize expired attempts)' });
      if (a.status !== 'in_progress') {
        if (a.grading.status === 'done' && a.grading.revision === 1) graded++;
        else problems.push({ kind: 'grading', user: loginId, detail: `grading status=${a.grading.status} revision=${a.grading.revision}` });
      }
      if (userIndex === null) continue;
      const ack = acks.get(userIndex);
      if (ack !== undefined && a.lastSeq < ack) problems.push({ kind: 'LOST_ACKNOWLEDGED_ANSWER', user: loginId, detail: `server lastSeq=${a.lastSeq} < acknowledged ${ack}` });

      const questions = [...a.snapshot.questions].sort((x, y) => x.sequence - y.sequence);
      const expected = expectedAnswers(userIndex, questions.length, a.lastSeq);
      questions.forEach((q, qi) => {
        const want = expected[qi];
        const wantId = want === null || want === undefined ? null : (q.options[want]?.optionId ?? null);
        const got = (a.answers?.[q.questionId.toString()]?.selectedOptionId ?? null) as string | null;
        if (got !== wantId) problems.push({ kind: 'WRONG_STORED_ANSWER', user: loginId, detail: `question ${qi + 1}: stored ${got} but lastSeq=${a.lastSeq} implies ${wantId}` });
      });
    }
    for (const [loginId, count] of perStudent) if (count > 1) problems.push({ kind: 'DUPLICATE_ATTEMPTS', user: loginId, detail: `${count} attempts` });
    for (const user of acks.keys()) {
      if (![...perStudent.keys()].includes(`load.${user}`)) problems.push({ kind: 'MISSING_ATTEMPT', user, detail: 'k6 saw an acknowledged save but there is no attempt' });
    }

    const summary = {
      quizId,
      attempts: attempts.length,
      studentsWithAcks: acks.size,
      statuses,
      gradedOnce: graded,
      acknowledgedSavesChecked: [...acks.values()].reduce((s, v) => s + v, 0),
      problemCount: problems.length,
      problemsByKind: problems.reduce<Record<string, number>>((m, p) => ({ ...m, [p.kind]: (m[p.kind] ?? 0) + 1 }), {}),
      firstProblems: problems.slice(0, 20),
      PASS: problems.length === 0,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.PASS ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
