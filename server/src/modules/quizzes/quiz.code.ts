import { createHmac, randomInt } from 'node:crypto';
import { safeEqual } from '../../common/crypto';

// 32 symbols, no look-alikes (0/O, 1/I). 8 symbols = 40 bits; guessing is also rate-limited per student per quiz.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export function generateQuizCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET.charAt(randomInt(ALPHABET.length));
  return code;
}

/** Display form for the teacher: ABCD-EFGH. Students may type it with or without the hyphen, in any case. */
export const formatQuizCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalize = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase();

/** Keyed hash (HMAC): a leaked database does not allow offline guessing of codes without the server key. */
export const hashQuizCode = (code: string, keyHex: string): string =>
  createHmac('sha256', Buffer.from(keyHex, 'hex')).update(normalize(code)).digest('hex');

/** Constant-time check, used by the exam-start endpoint (Step 7). */
export const verifyQuizCode = (storedHash: string, submitted: string, keyHex: string): boolean =>
  safeEqual(storedHash, hashQuizCode(submitted, keyHex));
