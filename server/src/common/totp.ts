import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto';

// RFC 4226 (HOTP) / RFC 6238 (TOTP), SHA-1, 6 digits, 30 s: compatible with Google Authenticator,
// Microsoft Authenticator, Authy, etc.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 input');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = (h[h.length - 1] as number) & 0x0f;
  const code =
    (((h[offset] as number) & 0x7f) << 24) |
    (((h[offset + 1] as number) & 0xff) << 16) |
    (((h[offset + 2] as number) & 0xff) << 8) |
    ((h[offset + 3] as number) & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** Code for a given instant (used by tests and tooling). */
export const totpCode = (secretBase32: string, nowMs: number): string =>
  hotp(base32Decode(secretBase32), totpStep(nowMs));

/**
 * Returns the matched time step, or null. Accepts +/- `window` steps for clock drift.
 * The caller MUST reject a step <= the last accepted step to prevent code replay.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let w = -window; w <= window; w++) {
    // Evaluate every candidate (no early exit) so timing does not reveal which step matched.
    if (safeEqual(hotp(secret, current + w), code)) matched = current + w;
  }
  return matched;
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export function buildOtpauthUrl(secretBase32: string, account: string, issuer = 'Cognition IQ'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
