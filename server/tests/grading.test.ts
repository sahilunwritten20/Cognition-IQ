import { describe, expect, it } from 'vitest';
import { gradeAttempt } from '../src/modules/attempts/grading';

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
      { questionId: 'q1', awarded: 2, answered: true, correct: true },
      { questionId: 'q2', awarded: 0, answered: true, correct: false },
      { questionId: 'q3', awarded: 1, answered: true, correct: true },
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
