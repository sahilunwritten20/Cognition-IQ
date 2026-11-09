import type { QuizStatus } from './quiz.model';

/** Marks are rounded half-up to 2 decimals (D-04). */
export const roundMarks = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export type DisplayState = 'draft' | 'scheduled' | 'live' | 'ended' | 'paused' | 'closed';

interface Timed {
  status: QuizStatus;
  startAt?: Date;
  endAt?: Date;
}

/** What a teacher sees: derived from the stored status and the clock. Never stored. */
export function displayState(q: Timed, now: Date): DisplayState {
  if (q.status === 'draft') return 'draft';
  if (q.status === 'closed') return 'closed';
  if (q.status === 'paused') return 'paused';
  if (!q.startAt || !q.endAt) return 'draft';
  if (now < q.startAt) return 'scheduled';
  if (now >= q.endAt) return 'ended';
  return 'live';
}

export type UnavailableReason = 'not_published' | 'not_scheduled' | 'not_started' | 'ended' | 'paused' | 'closed' | 'no_attempts_left';

export const REASON_TEXT: Record<UnavailableReason, string> = {
  not_published: 'This quiz is not published yet.',
  not_scheduled: 'This quiz has no schedule yet.',
  not_started: 'This quiz has not started yet.',
  ended: 'This quiz has ended.',
  paused: 'This quiz is paused by your teacher. Please wait.',
  closed: 'This quiz is closed.',
  no_attempts_left: 'You have used all your attempts.',
};

/**
 * The single rule for "may this student start this quiz right now?" (eligibility is checked separately).
 * The window is [startAt, endAt): available exactly at startAt, NOT available exactly at endAt.
 * The exam-start endpoint (Step 7) must use this same function.
 */
export function evaluateAvailability(
  q: Timed & { maxAttempts: number },
  now: Date,
  attemptsUsed: number,
): { available: true } | { available: false; reason: UnavailableReason } {
  if (q.status === 'draft') return { available: false, reason: 'not_published' };
  if (q.status === 'closed') return { available: false, reason: 'closed' };
  if (q.status === 'paused') return { available: false, reason: 'paused' };
  if (!q.startAt || !q.endAt) return { available: false, reason: 'not_scheduled' };
  if (now < q.startAt) return { available: false, reason: 'not_started' };
  if (now >= q.endAt) return { available: false, reason: 'ended' };
  if (attemptsUsed >= q.maxAttempts) return { available: false, reason: 'no_attempts_left' };
  return { available: true };
}

/**
 * Hook to the exam engine. Until attempts exist (Steps 7-8) the default reports none; the engine then
 * provides the real implementation so these rules start counting finished attempts automatically.
 */
export interface AttemptLookup {
  /** Finalized attempts (submitted / auto_submitted) per quiz id, for one student. */
  countsForStudent(studentId: string, quizIds: string[]): Promise<Map<string, number>>;
  /** True if any attempt exists for the quiz (blocks unpublishing). */
  quizHasAttempts(quizId: string): Promise<boolean>;
}
export const noAttempts: AttemptLookup = {
  countsForStudent: async () => new Map(),
  quizHasAttempts: async () => false,
};
