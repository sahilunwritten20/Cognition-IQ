import { describe, expect, it } from 'vitest';
import { applyCorrections, gradeAttempt, type QuizCorrection } from '../src/modules/attempts/grading';

const questions = [
  { questionId: 'q1', marks: 2 },
  { questionId: 'q2', marks: 1.5 },
  { questionId: 'q3', marks: 1 },
];
const key = { q1: 'a1', q2: 'a2', q3: 'a3' };
const pick = (id: string | null) => ({ selectedOptionId: id });

describe('gradeAttempt (D-04: no negative marking, no grace marks, round half-up 2 decimals)', () => {
  it('awards the quiz marks for correct answers only', () => {
    const r = gradeAttempt(questions, key, { q1: pick('a1'), q2: pick('wrong'), q3: pick('a3') });
    expect(r.score).toBe(3);
    expect(r.totalMarks).toBe(4.5);
    expect(r.items).toEqual([
      { questionId: 'q1', awarded: 2, answered: true, correct: true, adjusted: false },
      { questionId: 'q2', awarded: 0, answered: true, correct: false, adjusted: false },
      { questionId: 'q3', awarded: 1, answered: true, correct: true, adjusted: false },
    ]);
  });

  it('gives full marks when everything is right and zero when nothing is', () => {
    expect(gradeAttempt(questions, key, { q1: pick('a1'), q2: pick('a2'), q3: pick('a3') }).score).toBe(4.5);
    expect(gradeAttempt(questions, key, {}).score).toBe(0);
  });

  it('treats unanswered and cleared (null) answers the same: zero, never negative', () => {
    const r = gradeAttempt(questions, key, { q1: pick(null), q2: pick('wrong') });
    expect(r.score).toBe(0);
    expect(r.items.map((i) => i.answered)).toEqual([false, true, false]);
    expect(r.items.every((i) => i.awarded >= 0)).toBe(true);
  });

  it('ignores answers to questions that are not part of the attempt', () => {
    expect(gradeAttempt(questions, key, { q1: pick('a1'), ghost: pick('a1') }).score).toBe(2);
  });

  it('never awards marks for a question whose key is missing', () => {
    const r = gradeAttempt(questions, { q1: 'a1' }, { q1: pick('a1'), q2: pick('a2'), q3: pick('a3') });
    expect(r.score).toBe(2);
  });

  it('uses the marks of THIS quiz, and rounds the score half-up to 2 decimals', () => {
    const tiny = [{ questionId: 'a', marks: 0.1 }, { questionId: 'b', marks: 0.2 }];
    const r = gradeAttempt(tiny, { a: 'x', b: 'y' }, { a: pick('x'), b: pick('y') });
    expect(r.score).toBe(0.3); // not 0.30000000000000004
    expect(r.totalMarks).toBe(0.3);
    const thirds = Array.from({ length: 33 }, (_, i) => ({ questionId: `q${i}`, marks: 0.33 }));
    const keyAll = Object.fromEntries(thirds.map((q) => [q.questionId, 'k']));
    const allRight = Object.fromEntries(thirds.map((q) => [q.questionId, pick('k')]));
    expect(gradeAttempt(thirds, keyAll, allRight).score).toBe(10.89);
  });

  it('is deterministic and idempotent: the same input always gives the same result', () => {
    const answers = { q1: pick('a1'), q3: pick('nope') };
    expect(gradeAttempt(questions, key, answers)).toEqual(gradeAttempt(questions, key, answers));
  });
});

describe('applyCorrections (audited regrade, guide Runbook B / D-03)', () => {
  const options = { q1: ['a1', 'b1'], q2: ['a2', 'b2'], q3: ['a3', 'b3'] };
  const corr = (revision: number, ...changes: QuizCorrection['changes']): QuizCorrection => ({ revision, changes });

  it('with no corrections the key is the attempt\'s own, untouched', () => {
    const r = applyCorrections(key, options, []);
    expect(r.key).toEqual(key);
    expect(r.awardAll.size).toBe(0);
  });

  it('set_key replaces the key for that question only, and never mutates the stored key', () => {
    const original = { ...key };
    const r = applyCorrections(key, options, [corr(1, { questionId: 'q1', action: 'set_key', correctOptionId: 'b1' })]);
    expect(r.key).toEqual({ q1: 'b1', q2: 'a2', q3: 'a3' });
    expect(key).toEqual(original);
  });

  it('ignores a set_key whose option the attempt never saw (a different version of the question)', () => {
    const r = applyCorrections(key, options, [corr(1, { questionId: 'q1', action: 'set_key', correctOptionId: 'zzz' })]);
    expect(r.key.q1).toBe('a1');
  });

  it('applies corrections in revision order, whatever order they are supplied in', () => {
    const r = applyCorrections(key, options, [
      corr(2, { questionId: 'q1', action: 'set_key', correctOptionId: 'a1' }),
      corr(1, { questionId: 'q1', action: 'set_key', correctOptionId: 'b1' }),
    ]);
    expect(r.key.q1).toBe('a1'); // revision 2 wins
  });

  it('award_all gives everyone the marks, and a later set_key cancels it (and the reverse)', () => {
    const first = applyCorrections(key, options, [corr(1, { questionId: 'q2', action: 'award_all' })]);
    expect([...first.awardAll]).toEqual(['q2']);
    const cancelled = applyCorrections(key, options, [corr(1, { questionId: 'q2', action: 'award_all' }), corr(2, { questionId: 'q2', action: 'set_key', correctOptionId: 'b2' })]);
    expect(cancelled.awardAll.size).toBe(0);
    expect(cancelled.key.q2).toBe('b2');
    const reversed = applyCorrections(key, options, [corr(1, { questionId: 'q2', action: 'set_key', correctOptionId: 'b2' }), corr(2, { questionId: 'q2', action: 'award_all' })]);
    expect([...reversed.awardAll]).toEqual(['q2']);
  });

  it('regrading with a corrected key changes the score; the original grading stays reproducible', () => {
    const answers = { q1: pick('a1'), q2: pick('b2'), q3: pick('a3') };
    const before = gradeAttempt(questions, key, answers);
    expect(before.score).toBe(3); // q1 + q3
    const fixed = applyCorrections(key, options, [corr(1, { questionId: 'q2', action: 'set_key', correctOptionId: 'b2' })]);
    const after = gradeAttempt(questions, fixed.key, answers, fixed.awardAll);
    expect(after.score).toBe(4.5);
    expect(after.items.find((i) => i.questionId === 'q2')).toMatchObject({ awarded: 1.5, correct: true, adjusted: false });
    expect(gradeAttempt(questions, key, answers).score).toBe(3); // the original inputs still give the original grade
  });

  it('award_all marks the item as adjusted, even for an unanswered question', () => {
    const r = gradeAttempt(questions, key, { q1: pick('a1') }, new Set(['q2']));
    expect(r.score).toBe(3.5);
    expect(r.items.find((i) => i.questionId === 'q2')).toEqual({ questionId: 'q2', awarded: 1.5, answered: false, correct: true, adjusted: true });
  });
});
