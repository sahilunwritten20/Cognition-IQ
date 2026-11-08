import { z } from 'zod';
import { objectIdSchema as id } from '../../common/validate';
import { DIFFICULTIES, QUESTION_TYPES } from './question.model';

// Unicode is welcome (Marathi/Hindi, D-08). Only control characters (except tab/newline) are refused.
const isClean = (s: string) =>
  ![...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
  });
const clean = (max: number) =>
  z.string().trim().min(1, 'required').max(max, `at most ${max} characters`).refine(isClean, 'contains control characters').transform((s) => s.normalize('NFC'));

const text = clean(2000);
const optionText = clean(500);
const topic = z.string().trim().max(100).refine(isClean, 'contains control characters');
const difficulty = z.enum(DIFFICULTIES);
// Positive, at most 100, at most 2 decimals (D-04: rounding to 2 decimals).
const marks = z
  .number()
  .positive('must be greater than 0')
  .max(100, 'at most 100')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'at most 2 decimal places');

// Create: option ids are assigned by the server, so any id in the request is rejected (strict).
const newOption = z.object({ text: optionText, correct: z.boolean().default(false) }).strict();
// Update: an existing option keeps its id so references (snapshots, regrades) stay stable.
const editedOption = z
  .object({ id: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/).optional(), text: optionText, correct: z.boolean().default(false) })
  .strict();

const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
function checkOptions(options: Array<{ text: string; correct: boolean }>, ctx: z.RefinementCtx): void {
  if (options.filter((o) => o.correct).length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'exactly one option must be marked correct' });
  }
  if (new Set(options.map((o) => norm(o.text))).size !== options.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'option texts must be different from each other' });
  }
}

const baseCreate = { subjectId: id, topic: topic.optional(), text, marks, difficulty: difficulty.default('medium') };

export const createQuestionBody = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('mcq'), ...baseCreate, options: z.array(newOption).min(2, 'at least 2 options').max(6, 'at most 6 options') }).strict(),
    z.object({ type: z.literal('true_false'), ...baseCreate, correct: z.boolean() }).strict(),
  ])
  .superRefine((v, ctx) => {
    if (v.type === 'mcq') checkOptions(v.options, ctx);
  });
export type CreateQuestionInput = z.output<typeof createQuestionBody>;

// A question's type never changes after creation. Sending `type` is rejected by .strict().
const baseUpdate = { revision: z.number().int().min(1), topic: topic.optional(), text: text.optional(), marks: marks.optional(), difficulty: difficulty.optional() };
const hasChange = (v: object) => Object.keys(v).some((k) => k !== 'revision');

export const updateMcqBody = z
  .object({ ...baseUpdate, options: z.array(editedOption).min(2, 'at least 2 options').max(6, 'at most 6 options').optional() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.options) checkOptions(v.options, ctx);
    if (v.options && new Set(v.options.filter((o) => o.id).map((o) => o.id)).size !== v.options.filter((o) => o.id).length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'an option id may appear only once' });
    }
    if (!hasChange(v)) ctx.addIssue({ code: 'custom', message: 'nothing to update' });
  });

export const updateTfBody = z
  .object({ ...baseUpdate, correct: z.boolean().optional() })
  .strict()
  .refine(hasChange, { message: 'nothing to update' });

export const revisionBody = z.object({ revision: z.number().int().min(1) }).strict();

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25), // bounded
};
export const listQuery = z
  .object({
    ...paging,
    subjectId: id.optional(),
    topic: z.string().trim().min(1).max(100).optional(),
    difficulty: difficulty.optional(),
    type: z.enum(QUESTION_TYPES).optional(),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type ListInput = z.output<typeof listQuery>;
