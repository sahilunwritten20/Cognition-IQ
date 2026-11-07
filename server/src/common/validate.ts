import { z, type ZodTypeAny } from 'zod';
import { Errors } from './errors';

/** Parse untrusted input; throws the standard 400 envelope with field-level details. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.validation(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** A 24-hex MongoDB ObjectId in string form (rejects operator objects and arbitrary strings). */
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a valid id');
