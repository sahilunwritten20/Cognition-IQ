import { roundMarks } from '../quizzes/quiz.rules';

export interface GradedQuestion {
  questionId: string;
  awarded: number;
  answered: boolean;
  correct: boolean;
  /** True when a quiz-level correction (e.g. "award everyone") changed this question's outcome. */
  adjusted: boolean;
}

/** One audited correction applied on top of every attempt's own snapshot key (guide Runbook B, D-03). */
export interface QuizCorrection {
  revision: number;
  changes: Array<{ questionId: string; action: 'set_key' | 'award_all'; correctOptionId?: string }>;
}

/**
 * The effective answer key of an attempt: its own snapshot key, overridden by the quiz's corrections in revision order.
 * - `set_key` replaces the key, but only if that option exists in THIS attempt's snapshot of the question (a student who saw a
 *   different version of the question is left on their own key rather than being graded against an option they never saw).
 * - `award_all` gives every student the marks for a faulty question. A later `set_key` on the same question cancels it.
 * The attempt's stored key is never modified: corrections live on the quiz, so the original grading stays reproducible.
 */
export function applyCorrections(
  baseKey: Record<string, string>,
  optionsByQuestion: Record<string, string[]>,
  corrections: QuizCorrection[],
): { key: Record<string, string>; awardAll: Set<string> } {
  const key: Record<string, string> = { ...baseKey };
  const awardAll = new Set<string>();
  for (const c of [...corrections].sort((a, b) => a.revision - b.revision)) {
    for (const ch of c.changes) {
      if (ch.action === 'award_all') {
        awardAll.add(ch.questionId);
      } else if (ch.correctOptionId && optionsByQuestion[ch.questionId]?.includes(ch.correctOptionId)) {
        key[ch.questionId] = ch.correctOptionId;
        awardAll.delete(ch.questionId);
      }
    }
  }
  return { key, awardAll };
}

/**
 * Objective grading (R1, T-03), pure and deterministic, so running it twice gives the same result (idempotent).
 * Policy D-04 (PROPOSED defaults): no negative marking, no grace marks, round half-up to 2 decimals.
 * `key` maps questionId -> correct optionId and comes from the attempt's own protected snapshot (plus audited corrections),
 * never from the live question.
 */
export function gradeAttempt(
  questions: Array<{ questionId: string; marks: number }>,
  key: Record<string, string>,
  answers: Record<string, { selectedOptionId: string | null }>,
  awardAll: ReadonlySet<string> = new Set(),
): { score: number; totalMarks: number; items: GradedQuestion[] } {
  const items: GradedQuestion[] = questions.map((q) => {
    const selected = answers[q.questionId]?.selectedOptionId ?? null;
    const answered = selected !== null;
    if (awardAll.has(q.questionId)) return { questionId: q.questionId, awarded: q.marks, answered, correct: true, adjusted: true };
    const correct = answered && key[q.questionId] === selected;
    return { questionId: q.questionId, awarded: correct ? q.marks : 0, answered, correct, adjusted: false };
  });
  return {
    score: roundMarks(items.reduce((sum, i) => sum + i.awarded, 0)),
    totalMarks: roundMarks(questions.reduce((sum, q) => sum + q.marks, 0)),
    items,
  };
}
