import { describe, expect, it } from 'vitest';
import { formatLocal, isPassed, percentage, pickCounted, studentStatus, summarize, type AttemptRow } from '../src/modules/results/results.rules';

const done = (attemptNo: number, score: number, status: AttemptRow['status'] = 'submitted'): AttemptRow => ({ attemptNo, status, gradingStatus: 'done', score, totalMarks: 10 });

describe('the official result (D-17: best score, ties to the earliest attempt)', () => {
  it('picks the best finished, graded attempt', () => {
    expect(pickCounted([done(1, 4), done(2, 9), done(3, 7)])?.attemptNo).toBe(2);
    expect(pickCounted([done(1, 6), done(2, 6)])?.attemptNo).toBe(1);
  });
  it('ignores attempts in progress, invalidated, or not graded', () => {
    const running: AttemptRow = { attemptNo: 2, status: 'in_progress', gradingStatus: 'pending' };
    const voided: AttemptRow = { attemptNo: 3, status: 'invalidated', gradingStatus: 'done', score: 10 };
    const ungraded: AttemptRow = { attemptNo: 4, status: 'submitted', gradingStatus: 'pending' };
    expect(pickCounted([done(1, 3), running, voided, ungraded])?.attemptNo).toBe(1);
    expect(pickCounted([running, voided, ungraded])).toBeNull();
    expect(pickCounted([])).toBeNull();
  });
  it('treats a zero score as a real result', () => {
    expect(pickCounted([done(1, 0)])?.score).toBe(0);
  });
});

describe('roster reconciliation status', () => {
  it('reports where each enrolled student is', () => {
    expect(studentStatus([])).toBe('not_started');
    expect(studentStatus([{ attemptNo: 1, status: 'invalidated', gradingStatus: 'done', score: 5 }])).toBe('not_started');
    expect(studentStatus([{ attemptNo: 1, status: 'in_progress', gradingStatus: 'pending' }])).toBe('in_progress');
    expect(studentStatus([{ attemptNo: 1, status: 'submitted', gradingStatus: 'pending' }])).toBe('grading_pending');
    expect(studentStatus([{ attemptNo: 1, status: 'auto_submitted', gradingStatus: 'failed' }])).toBe('grading_pending');
    expect(studentStatus([done(1, 5)])).toBe('submitted');
    expect(studentStatus([done(1, 5, 'auto_submitted')])).toBe('auto_submitted');
  });
  it('keeps the official result when a second attempt is running', () => {
    expect(studentStatus([done(1, 5), { attemptNo: 2, status: 'in_progress', gradingStatus: 'pending' }])).toBe('submitted');
  });
});

describe('percentages, pass/fail and the summary', () => {
  it('rounds percentages half-up and survives a zero total', () => {
    expect(percentage(7, 9)).toBe(77.78);
    expect(percentage(1, 3)).toBe(33.33);
    expect(percentage(5, 0)).toBe(0);
  });
  it('pass/fail needs both a result and a pass mark; the pass mark itself passes', () => {
    expect(isPassed(4, 4)).toBe(true);
    expect(isPassed(3.99, 4)).toBe(false);
    expect(isPassed(null, 4)).toBeNull();
    expect(isPassed(9, undefined)).toBeNull();
  });
  it('summarizes the whole class, not just a page', () => {
    const rows = [
      { status: 'submitted' as const, score: 8, passed: true },
      { status: 'auto_submitted' as const, score: 3, passed: false },
      { status: 'not_started' as const, score: null, passed: null },
      { status: 'in_progress' as const, score: null, passed: null },
      { status: 'grading_pending' as const, score: null, passed: null },
    ];
    expect(summarize(rows, true)).toEqual({ enrolled: 5, notStarted: 1, inProgress: 1, gradingPending: 1, completed: 2, average: 5.5, highest: 8, lowest: 3, passed: 1, failed: 1 });
    expect(summarize(rows, false)).toMatchObject({ passed: null, failed: null });
    expect(summarize([], false)).toMatchObject({ enrolled: 0, completed: 0, average: null, highest: null, lowest: null });
  });
});

describe('display time zone (storage stays UTC)', () => {
  it('formats in Asia/Kolkata (UTC+5:30, no daylight saving)', () => {
    expect(formatLocal(new Date('2026-11-06T10:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-06 15:30:00');
    expect(formatLocal(new Date('2026-12-31T20:00:00Z'), 'Asia/Kolkata')).toBe('2027-01-01 01:30:00');
    expect(formatLocal(new Date('2026-11-06T00:00:00Z'), 'UTC')).toBe('2026-11-06 00:00:00');
  });
});
