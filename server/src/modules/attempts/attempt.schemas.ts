import { z } from 'zod';
import { objectIdSchema as id } from '../../common/validate';

// Everything the server owns (times, status, score, attempt number...) is absent here: .strict() rejects it.
const answer = z
  .object({
    questionId: id,
    selectedOptionId: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/, 'invalid option id').nullable(), // null clears the answer
  })
  .strict();
const seq = z.number().int().min(1).max(1_000_000);

export const startBody = z.object({ accessCode: z.string().trim().min(1).max(40).optional() }).strict();

/**
 * CUMULATIVE autosave: every request carries ALL answers changed since the last server-acknowledged save, with a
 * strictly increasing seq. A dropped, delayed or reordered request therefore loses nothing.
 */
export const saveBody = z
  .object({ seq, answers: z.array(answer).min(1).max(200) })
  .strict()
  .refine((v) => new Set(v.answers.map((a) => a.questionId.toLowerCase())).size === v.answers.length, {
    message: 'a question may appear only once per request',
    path: ['answers'],
  });
export type SaveInput = z.output<typeof saveBody>;

/** Optionally carries the final cumulative answers (seq and answers go together). */
export const submitBody = z
  .object({ seq: seq.optional(), answers: z.array(answer).max(200).optional() })
  .strict()
  .refine((v) => (v.seq === undefined) === (v.answers === undefined), { message: 'send seq and answers together, or neither', path: ['seq'] })
  .refine((v) => !v.answers || new Set(v.answers.map((a) => a.questionId.toLowerCase())).size === v.answers.length, {
    message: 'a question may appear only once per request',
    path: ['answers'],
  });
export type SubmitInput = z.output<typeof submitBody>;
