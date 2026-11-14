import { z } from 'zod';
import { objectIdSchema as id } from '../../common/validate';
import { RESULT_VISIBILITIES } from '../quizzes/quiz.model';

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25), // bounded
};

export const tableQuery = z
  .object({ ...paging, status: z.enum(['not_started', 'in_progress', 'grading_pending', 'submitted', 'auto_submitted']).optional() })
  .strict();
export const pagingQuery = z.object(paging).strict();

const reason = z.string().trim().min(3, 'please give a reason (at least 3 characters)').max(500);
export const reasonBody = z.object({ reason }).strict();
// After publication a visibility change needs a reason (D-01); before publication it is optional.
export const visibilityBody = z.object({ visibility: z.enum(RESULT_VISIBILITIES), reason: reason.optional() }).strict();

const optionId = z.string().regex(/^[A-Za-z0-9_-]{4,40}$/, 'invalid option id');
const change = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_key'), questionId: id, correctOptionId: optionId }).strict(), // the answer key was wrong
  z.object({ action: z.literal('award_all'), questionId: id }).strict(), // the question was faulty: everyone gets the marks
]);

/** An audited correction (guide Runbook B, D-03, D-05). The reason is mandatory; `approvedBy` is mandatory once results are published. */
export const regradeBody = z
  .object({
    reason,
    approvedBy: z.string().trim().min(2).max(120).optional(),
    changes: z.array(change).min(1, 'at least one change').max(20),
  })
  .strict()
  .refine((v) => new Set(v.changes.map((c) => c.questionId.toLowerCase())).size === v.changes.length, {
    message: 'a question may appear only once per correction',
    path: ['changes'],
  });
export type RegradeInput = z.output<typeof regradeBody>;
