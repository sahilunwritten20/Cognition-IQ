import type { AttemptStatus } from '../attempts/attempt.model';

export type MonitorStatus = 'not_started' | 'in_progress' | 'submitted' | 'auto_submitted';

/** Where a student stands right now. A running attempt wins; otherwise the latest finished attempt; otherwise not started. */
export function monitorStatus(attempts: Array<{ status: AttemptStatus; attemptNo: number }>): MonitorStatus {
  if (attempts.some((a) => a.status === 'in_progress')) return 'in_progress';
  const finished = attempts.filter((a) => a.status === 'submitted' || a.status === 'auto_submitted').sort((x, y) => y.attemptNo - x.attemptNo);
  return finished[0] ? (finished[0].status as 'submitted' | 'auto_submitted') : 'not_started'; // invalidated-only counts as not started
}

/**
 * "Stalled": still has time left, but the server has accepted no save for longer than the threshold (about four missed
 * autosaves). A hint for the teacher (the student may simply be reading), never an automatic action.
 */
export function isStalled(a: { status: AttemptStatus; endsAt: Date; lastActivityAt: Date }, now: Date, stallMs: number): boolean {
  return a.status === 'in_progress' && now.getTime() <= a.endsAt.getTime() && now.getTime() - a.lastActivityAt.getTime() > stallMs;
}

export const remainingSeconds = (endsAt: Date, now: Date): number => Math.max(0, Math.floor((endsAt.getTime() - now.getTime()) / 1000));

export const extendedMinutes = (extensions: Array<{ minutes: number }> | undefined): number => (extensions ?? []).reduce((sum, e) => sum + e.minutes, 0);

/** Teachers need the problems first: stalled, then running, then not started, then finished. */
export function rowRank(status: MonitorStatus, stalled: boolean): number {
  if (stalled) return 0;
  return { in_progress: 1, not_started: 2, auto_submitted: 3, submitted: 4 }[status];
}

/** Upper bound on the total time added to ONE attempt by extensions (a guard against runaway or mistaken extensions). */
export const MAX_TOTAL_EXTENSION_MINUTES = 240;
