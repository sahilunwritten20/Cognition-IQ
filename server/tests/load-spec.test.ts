import { describe, expect, it } from 'vitest';
import { expectedAnswers, optionIndex, questionIndexOf, userIndexOf } from '../src/scripts/load-spec';

describe('load-test answer pattern', () => {
  it('walks the questions round-robin, starting at question 0', () => {
    expect([1, 2, 3, 4, 5].map((s) => questionIndexOf(s, 3))).toEqual([0, 1, 2, 0, 1]);
  });

  it('always chooses one of the two first options, and varies by user, question and sequence number', () => {
    for (let u = 0; u < 5; u++) for (let q = 0; q < 4; q++) for (let s = 1; s < 8; s++) expect([0, 1]).toContain(optionIndex(u, q, s));
    expect(optionIndex(1, 0, 1)).toBe(0);
    expect(optionIndex(2, 0, 1)).toBe(1);
  });

  it('after seq L the latest change per question wins, and untouched questions are null', () => {
    expect(expectedAnswers(7, 3, 0)).toEqual([null, null, null]);
    expect(expectedAnswers(7, 3, 2)).toEqual([optionIndex(7, 0, 1), optionIndex(7, 1, 2), null]);
    // seq 4 overwrites question 0 (written by seq 1)
    expect(expectedAnswers(7, 3, 4)).toEqual([optionIndex(7, 0, 4), optionIndex(7, 1, 2), optionIndex(7, 2, 3)]);
  });

  it('is cumulative: the state after L equals applying 1..L in order', () => {
    const q = 5;
    const manual: Array<number | null> = Array.from({ length: q }, () => null);
    for (let s = 1; s <= 12; s++) {
      manual[questionIndexOf(s, q)] = optionIndex(42, questionIndexOf(s, q), s);
      expect(expectedAnswers(42, q, s)).toEqual(manual);
    }
  });

  it('recognises only load-test student logins', () => {
    expect(userIndexOf('load.17')).toBe(17);
    expect(userIndexOf('load.1500')).toBe(1500);
    for (const no of ['load.teacher', 'asha.patil', 'load.', 'load.1x', 'xload.5', 'load.5.6']) expect(userIndexOf(no), no).toBeNull();
  });
});
