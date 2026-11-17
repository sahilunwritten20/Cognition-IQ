import { z } from 'zod';
import { objectIdSchema as id } from '../../common/validate';

const reason = z.string().trim().min(3, 'please give a reason (at least 3 characters)').max(500);
const minutes = z.number().int().min(1, 'at least 1 minute').max(120, 'at most 120 minutes at a time');

/** Extra time (D-02): for ALL running attempts, for selected students, or for selected attempts. A reason is mandatory. */
export const extendBody = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all'), minutes, reason }).strict(),
  z.object({ scope: z.literal('students'), studentIds: z.array(id).min(1).max(200), minutes, reason }).strict(),
  z.object({ scope: z.literal('attempts'), attemptIds: z.array(id).min(1).max(200), minutes, reason }).strict(),
]);
export type ExtendInput = z.output<typeof extendBody>;

/** Gives a finished attempt a new deadline of NOW + minutes. */
export const reopenBody = z.object({ minutes, reason }).strict();
export const emergencyCloseBody = z.object({ reason }).strict();

export const monitorQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(100), // bounded
    status: z.enum(['not_started', 'in_progress', 'submitted', 'auto_submitted', 'stalled']).optional(),
    view: z.enum(['full', 'summary']).default('full'), // "summary" = counts only: the cheapest thing to poll
  })
  .strict();
