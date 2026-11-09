import { describe, expect, it } from 'vitest';
import { deriveKey } from '../src/common/crypto';
import { CODE_LENGTH, formatQuizCode, generateQuizCode, hashQuizCode, verifyQuizCode } from '../src/modules/quizzes/quiz.code';
import { displayState, evaluateAvailability, REASON_TEXT, roundMarks, type UnavailableReason } from '../src/modules/quizzes/quiz.rules';
import type { QuizStatus } from '../src/modules/quizzes/quiz.model';

describe('roundMarks (D-04: half-up, 2 decimals)', () => {
  it('removes floating-point noise and rounds half-up', () => {
    expect(roundMarks(0.1 + 0.2)).toBe(0.3);
    expect(roundMarks(33 * 0.33)).toBe(10.89);
    expect(roundMarks(2.5)).toBe(2.5);
    expect(roundMarks(1 / 3)).toBe(0.33);
    expect(roundMarks(2 / 3)).toBe(0.67);
    expect(roundMarks(0.125)).toBe(0.13);
    expect(roundMarks(0.375)).toBe(0.38);
    expect(roundMarks(0)).toBe(0);
  });
});

describe('displayState and evaluateAvailability: window boundaries', () => {
  const start = new Date('2026-11-20T09:00:00.000Z');
  const end = new Date('2026-11-20T11:00:00.000Z');
  const quiz = (status: QuizStatus, extra: object = {}) => ({ status, startAt: start, endAt: end, maxAttempts: 1, ...extra });
  const at = (d: Date, ms: number) => new Date(d.getTime() + ms);

  it('the window is [startAt, endAt): open exactly at start, closed exactly at end', () => {
    const q = quiz('published');
    expect(evaluateAvailability(q, at(start, -1), 0)).toEqual({ available: false, reason: 'not_started' });
    expect(evaluateAvailability(q, start, 0)).toEqual({ available: true });
    expect(evaluateAvailability(q, at(end, -1), 0)).toEqual({ available: true });
    expect(evaluateAvailability(q, end, 0)).toEqual({ available: false, reason: 'ended' });
    expect(evaluateAvailability(q, at(end, 1), 0)).toEqual({ available: false, reason: 'ended' });
  });

  it('derives the display state from status and the clock', () => {
    expect(displayState(quiz('draft'), start)).toBe('draft');
    expect(displayState(quiz('published'), at(start, -1))).toBe('scheduled');
    expect(displayState(quiz('published'), start)).toBe('live');
    expect(displayState(quiz('published'), end)).toBe('ended');
    expect(displayState(quiz('paused'), start)).toBe('paused');
    expect(displayState(quiz('closed'), start)).toBe('closed');
    expect(displayState({ status: 'published', maxAttempts: 1 } as never, start)).toBe('draft'); // no window yet
  });

  it('status beats the clock: draft, closed and paused are never available', () => {
    expect(evaluateAvailability(quiz('draft'), at(start, 1), 0)).toEqual({ available: false, reason: 'not_published' });
    expect(evaluateAvailability(quiz('closed'), at(start, 1), 0)).toEqual({ available: false, reason: 'closed' });
    expect(evaluateAvailability(quiz('paused'), at(start, 1), 0)).toEqual({ available: false, reason: 'paused' });
    expect(evaluateAvailability({ status: 'published', maxAttempts: 1 }, start, 0)).toEqual({ available: false, reason: 'not_scheduled' });
  });

  it('attempts: available while attemptsUsed < maxAttempts, blocked at the limit', () => {
    const q = quiz('published', { maxAttempts: 2 });
    expect(evaluateAvailability(q, at(start, 1), 0)).toEqual({ available: true });
    expect(evaluateAvailability(q, at(start, 1), 1)).toEqual({ available: true });
    expect(evaluateAvailability(q, at(start, 1), 2)).toEqual({ available: false, reason: 'no_attempts_left' });
    expect(evaluateAvailability(q, at(start, 1), 3)).toEqual({ available: false, reason: 'no_attempts_left' });
    // The time window is reported first: an ended quiz says "ended", not "no attempts".
    expect(evaluateAvailability(q, end, 2)).toEqual({ available: false, reason: 'ended' });
  });

  it('every reason has a student-readable message', () => {
    const reasons: UnavailableReason[] = ['not_published', 'not_scheduled', 'not_started', 'ended', 'paused', 'closed', 'no_attempts_left'];
    for (const r of reasons) expect(REASON_TEXT[r].length).toBeGreaterThan(5);
  });
});

describe('access codes', () => {
  const key = deriveKey('ab'.repeat(32), 'quiz-codes-v1');

  it('are 8 unambiguous characters and effectively unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = generateQuizCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      seen.add(c);
    }
    expect(CODE_LENGTH).toBe(8);
    expect(seen.size).toBe(2000);
    expect(formatQuizCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('are stored as a keyed hash: never the code, different per key, tolerant of case, hyphen and spaces', () => {
    const code = 'K7M2QX9P';
    const h = hashQuizCode(code, key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);
    expect(hashQuizCode(code, deriveKey('cd'.repeat(32), 'quiz-codes-v1'))).not.toBe(h);
    for (const typed of ['K7M2QX9P', 'k7m2qx9p', 'K7M2-QX9P', ' k7m2 qx9p ']) expect(verifyQuizCode(h, typed, key)).toBe(true);
  });

  it('reject wrong, truncated and padded codes (constant-time comparison of hashes)', () => {
    const h = hashQuizCode('K7M2QX9P', key);
    for (const typed of ['K7M2QX9Q', 'K7M2QX9', 'K7M2QX9PP', '', 'AAAAAAAA']) expect(verifyQuizCode(h, typed, key)).toBe(false);
  });
});
