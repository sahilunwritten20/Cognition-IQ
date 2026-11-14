import type { AttemptStatus, GradingStatus } from '../attempts/attempt.model';
import { roundMarks } from '../quizzes/quiz.rules';

/** One attempt as the results table sees it (no answers, no keys). */
export interface AttemptRow {
  attemptNo: number;
  status: AttemptStatus;
  gradingStatus: GradingStatus;
  score?: number;
  totalMarks?: number;
  submittedAt?: Date;
}

export type StudentResultStatus = 'not_started' | 'in_progress' | 'grading_pending' | 'submitted' | 'auto_submitted';

const FINISHED: AttemptStatus[] = ['submitted', 'auto_submitted'];

/**
 * D-17 (PROPOSED): a student's OFFICIAL result is their BEST score among submitted / auto-submitted attempts that are graded;
 * ties go to the earliest attempt. Every attempt stays on record. (Alternatives: first, last.)
 */
export function pickCounted(attempts: AttemptRow[]): AttemptRow | null {
  let best: AttemptRow | null = null;
  for (const a of attempts) {
    if (!FINISHED.includes(a.status) || a.gradingStatus !== 'done' || a.score === undefined) continue;
    if (!best || a.score > (best.score ?? 0) || (a.score === best.score && a.attemptNo < best.attemptNo)) best = a;
  }
  return best;
}

/** Roster reconciliation: where is this enrolled student? */
export function studentStatus(attempts: AttemptRow[]): StudentResultStatus {
  const counted = pickCounted(attempts);
  if (counted) return counted.status === 'auto_submitted' ? 'auto_submitted' : 'submitted';
  if (attempts.some((a) => FINISHED.includes(a.status))) return 'grading_pending'; // finished but not graded (yet)
  if (attempts.some((a) => a.status === 'in_progress')) return 'in_progress';
  return 'not_started';
}

export const percentage = (score: number, total: number): number => (total > 0 ? roundMarks((score / total) * 100) : 0);

export const isPassed = (score: number | null, passMarks: number | undefined): boolean | null =>
  score === null || passMarks === undefined ? null : score >= passMarks;

export interface Summary {
  enrolled: number;
  notStarted: number;
  inProgress: number;
  gradingPending: number;
  completed: number; // students with an official result
  average: number | null;
  highest: number | null;
  lowest: number | null;
  passed: number | null;
  failed: number | null;
}

export function summarize(rows: Array<{ status: StudentResultStatus; score: number | null; passed: boolean | null }>, hasPassMarks: boolean): Summary {
  const scores = rows.flatMap((r) => (r.score === null ? [] : [r.score]));
  return {
    enrolled: rows.length,
    notStarted: rows.filter((r) => r.status === 'not_started').length,
    inProgress: rows.filter((r) => r.status === 'in_progress').length,
    gradingPending: rows.filter((r) => r.status === 'grading_pending').length,
    completed: scores.length,
    average: scores.length ? roundMarks(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
    highest: scores.length ? Math.max(...scores) : null,
    lowest: scores.length ? Math.min(...scores) : null,
    passed: hasPassMarks ? rows.filter((r) => r.passed === true).length : null,
    failed: hasPassMarks ? rows.filter((r) => r.passed === false).length : null,
  };
}

/** "2026-11-20 14:35:10" in the college's display time zone (storage stays UTC). */
export function formatLocal(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
