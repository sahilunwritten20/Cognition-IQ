import type { IQuestionOption, QuestionDoc, QuestionType } from './question.model';

/** Teacher-facing shape. Includes the answer key, so it must NEVER be returned by a student endpoint. */
export const toAuthoringDto = (q: QuestionDoc, actorId: string) => ({
  id: q.id as string,
  subjectId: q.subjectId.toString(),
  departmentId: q.departmentId.toString(),
  topic: q.topic ?? null,
  type: q.type,
  text: q.text,
  options: q.options.map((o) => ({ optionId: o.optionId, text: o.text })),
  correctOptionId: q.correctOptionId,
  marks: q.marks,
  difficulty: q.difficulty,
  status: q.status,
  createdBy: q.createdBy.toString(),
  mine: q.createdBy.toString() === actorId,
  revision: q.revision,
  archivedAt: q.archivedAt ? q.archivedAt.toISOString() : null,
  createdAt: q.createdAt.toISOString(),
  updatedAt: q.updatedAt.toISOString(),
});

/**
 * The ONLY shape a student may ever receive for a question (guide Section 6):
 * StudentQuestionDTO = { questionId, type, text, options[{ optionId, text }], marks, sequence }.
 * It is an explicit allow-list: fields are copied one by one, so a new field added to the model (an answer
 * key, an internal note, a grading detail) can never leak by accident. The parameter type is structural so
 * attempt snapshots (Step 8) can use the same function.
 */
export interface StudentQuestionDTO {
  questionId: string;
  type: QuestionType;
  text: string;
  options: Array<{ optionId: string; text: string }>;
  marks: number;
  sequence: number;
}

export function toStudentQuestionDto(
  q: { id: string; type: QuestionType; text: string; options: IQuestionOption[]; marks: number },
  sequence: number,
): StudentQuestionDTO {
  return {
    questionId: q.id,
    type: q.type,
    text: q.text,
    options: q.options.map((o) => ({ optionId: o.optionId, text: o.text })),
    marks: q.marks,
    sequence,
  };
}
