import { z } from 'zod';
import { objectIdSchema as id } from '../../common/validate';
import { ACCESS_MODES, RESULT_VISIBILITIES } from './quiz.model';

const isClean = (s: string) =>
  ![...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
  });

const title = z.string().trim().min(3, 'at least 3 characters').max(200).refine(isClean, 'contains control characters');
const instructions = z.string().trim().max(5000).refine(isClean, 'contains control characters');
// Dates must be full ISO 8601 WITH a UTC offset ("2026-11-20T09:00:00+05:30" or "...Z"). Stored in UTC.
const isoDate = z.string().datetime({ offset: true, message: 'use an ISO 8601 date-time with offset, e.g. 2026-11-20T09:00:00+05:30' }).transform((s) => new Date(s));
const marks = z
  .number()
  .positive('must be greater than 0')
  .max(100, 'at most 100')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'at most 2 decimal places');
const item = z.object({ questionId: id, marks: marks.optional() }).strict();
const target = z.object({ classId: id, divisionId: id }).strict();
const duration = z.number().int().min(1).max(480);
const attempts = z.number().int().min(1).max(5);

const windowOk = (v: { startAt?: Date | null; endAt?: Date | null }) => !v.startAt || !v.endAt || v.endAt > v.startAt;
const windowIssue = { message: 'endAt must be after startAt', path: ['endAt'] };

// totalMarks, status, department, year, createdBy, codeHash... are all server-owned: .strict() rejects them.
export const createQuizBody = z
  .object({
    title,
    instructions: instructions.optional(),
    subjectId: id,
    targets: z.array(target).min(1, 'at least 1 class/division').max(10, 'at most 10 class/divisions'),
    items: z.array(item).max(200, 'at most 200 questions').optional(),
    startAt: isoDate.optional(),
    endAt: isoDate.optional(),
    durationMinutes: duration.optional(),
    maxAttempts: attempts.default(1),
    passMarks: marks.optional(), // optional per quiz (D-04); checked against the total at publish time
    accessMode: z.enum(ACCESS_MODES).default('scheduled'),
    resultVisibility: z.enum(RESULT_VISIBILITIES).default('hidden'),
  })
  .strict()
  .refine(windowOk, windowIssue);
export type CreateQuizInput = z.output<typeof createQuizBody>;

// The subject of a quiz never changes (create a new quiz instead). Sending subjectId is a 400.
export const updateQuizBody = z
  .object({
    revision: z.number().int().min(1),
    title: title.optional(),
    instructions: instructions.optional(), // '' clears it
    targets: z.array(target).min(1).max(10).optional(),
    items: z.array(item).max(200).optional(),
    startAt: isoDate.nullable().optional(), // null clears it
    endAt: isoDate.nullable().optional(),
    durationMinutes: duration.nullable().optional(),
    maxAttempts: attempts.optional(),
    passMarks: marks.nullable().optional(), // null clears it
    accessMode: z.enum(ACCESS_MODES).optional(),
    resultVisibility: z.enum(RESULT_VISIBILITIES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'revision'), { message: 'nothing to update' })
  .refine(windowOk, windowIssue);
export type UpdateQuizInput = z.output<typeof updateQuizBody>;

export const reasonBody = z.object({ reason: z.string().trim().min(3, 'please give a reason (at least 3 characters)').max(500) }).strict();

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
export const listQuery = z
  .object({ ...paging, status: z.enum(['draft', 'published', 'paused', 'closed', 'all']).default('all'), subjectId: id.optional() })
  .strict();
export const pagingQuery = z.object(paging).strict();
