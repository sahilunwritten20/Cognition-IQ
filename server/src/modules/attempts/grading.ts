import { roundMarks } from '../quizzes/quiz.rules';

export interface GradedQuestion {
  questionId: string;
  awarded: number;
  answered: boolean;
  correct: boolean;
}

/**
 * Objective grading (R1, T-03), pure and deterministic, so running it twice gives the same result (idempotent).
 * Policy D-04 (PROPOSED defaults): no negative marking, no grace marks, round half-up to 2 decimals.
 * `key` maps questionId -> correct optionId and comes from the attempt's own protected snapshot, never from the
 * live question (a later key edit cannot change a finished attempt except through an audited regrade).
 */
export function gradeAttempt(
  questions: Array<{ questionId: string; marks: number }>,
  key: Record<string, string>,
  answers: Record<string, { selectedOptionId: string | null }>,
): { score: number; totalMarks: number; items: GradedQuestion[] } {
  const items: GradedQuestion[] = questions.map((q) => {
    const selected = answers[q.questionId]?.selectedOptionId ?? null;
    const answered = selected !== null;
    const correct = answered && key[q.questionId] === selected;
    return { questionId: q.questionId, awarded: correct ? q.marks : 0, answered, correct };
  });
  return {
    score: roundMarks(items.reduce((sum, i) => sum + i.awarded, 0)),
    totalMarks: roundMarks(questions.reduce((sum, q) => sum + q.marks, 0)),
    items,
  };
}
