import { z } from 'zod';

// .strict() everywhere: unknown fields (e.g. a client-supplied "role") are rejected, not ignored.
const loginId = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .transform((s) => s.toLowerCase());

// Min 10 chars; max 128 so nobody can make the server hash megabytes of input.
const newPassword = z.string().min(10, 'must be at least 10 characters').max(128);
const totpCode = z.string().regex(/^\d{6}$/, 'must be a 6-digit code');

export const registerSchema = z
  .object({ name: z.string().trim().min(2).max(120), loginId, password: newPassword })
  .strict();

export const loginSchema = z.object({ loginId, password: z.string().min(1).max(128) }).strict();

export const verify2faSchema = z
  .object({ challengeToken: z.string().min(10).max(2000), code: totpCode })
  .strict();

export const enable2faSchema = z.object({ code: totpCode }).strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword })
  .strict();
