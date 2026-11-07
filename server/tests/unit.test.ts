import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, safeEqual } from '../src/common/crypto';
import { MemoryCounterStore } from '../src/common/rateLimit';
import { base32Decode, base32Encode, hotp, totpCode, verifyTotp } from '../src/common/totp';
import { generateTemporaryPassword, PasswordService } from '../src/modules/auth/password.service';
import { TokenService } from '../src/modules/auth/token.service';
import jwt from 'jsonwebtoken';

describe('TOTP (RFC 4226 / 6238)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');

  it('matches the RFC 4226 HOTP test vectors', () => {
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(hotp(secret, 2)).toBe('359152');
    expect(hotp(secret, 9)).toBe('520489');
  });

  it('matches RFC 6238 time-based vectors (6-digit truncation)', () => {
    const b32 = base32Encode(secret);
    expect(totpCode(b32, 59_000)).toBe('287082');
    expect(totpCode(b32, 1111111109_000)).toBe('081804');
    expect(totpCode(b32, 1234567890_000)).toBe('005924');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([1, 2, 3, 250, 251, 252, 0, 77, 99, 100]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('accepts +/-1 step of drift but not more', () => {
    const b32 = base32Encode(secret);
    const now = 1_700_000_000_000;
    const code = totpCode(b32, now);
    expect(verifyTotp(b32, code, now)).not.toBeNull();
    expect(verifyTotp(b32, code, now + 30_000)).not.toBeNull();
    expect(verifyTotp(b32, code, now + 90_000)).toBeNull();
    expect(verifyTotp(b32, 'abcdef', now)).toBeNull();
  });
});

describe('crypto helpers', () => {
  const key = 'ab'.repeat(32);
  it('encrypts and decrypts', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc, key)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('rejects tampered ciphertext and the wrong key', () => {
    const enc = encryptSecret('secret', key);
    const parts = enc.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(enc, 'cd'.repeat(32))).toThrow();
  });
  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('MemoryCounterStore', () => {
  it('counts within a window and resets after it expires', async () => {
    let t = 0;
    const store = new MemoryCounterStore(() => t);
    expect(await store.incr('k', 60)).toBe(1);
    expect(await store.incr('k', 60)).toBe(2);
    expect(await store.get('k')).toBe(2);
    t = 61_000;
    expect(await store.get('k')).toBe(0);
    expect(await store.incr('k', 60)).toBe(1);
    await store.reset('k');
    expect(await store.get('k')).toBe(0);
  });
});

describe('passwords', () => {
  const svc = new PasswordService({ memoryKib: 1024, timeCost: 2 });
  it('hashes with argon2id and verifies', async () => {
    const h = await svc.hash('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'correct horse battery')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });
  it('generates readable temporary passwords without look-alike characters', () => {
    const pw = generateTemporaryPassword();
    expect(pw).toHaveLength(12);
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
  });
});

describe('TokenService', () => {
  const svc = new TokenService({ secret: 's'.repeat(40), accessTtl: '15m' });
  const claims = { sub: 'a'.repeat(24), cid: 'b'.repeat(24), tv: 3 };

  it('round-trips access tokens and reports ~15 minutes', () => {
    const { token, expiresInSec } = svc.signAccess(claims);
    expect(expiresInSec).toBe(900);
    expect(svc.verifyAccess(token)).toEqual(claims);
  });
  it('does not accept a 2FA challenge as an access token (or vice versa)', () => {
    expect(() => svc.verifyAccess(svc.signChallenge(claims))).toThrow();
    expect(() => svc.verifyChallenge(svc.signAccess(claims).token)).toThrow();
  });
  it('rejects tampered, wrong-secret and alg=none tokens', () => {
    const { token } = svc.signAccess(claims);
    expect(() => svc.verifyAccess(token + 'x')).toThrow();
    const other = new TokenService({ secret: 'z'.repeat(40), accessTtl: '15m' });
    expect(() => other.verifyAccess(token)).toThrow();
    const none = jwt.sign({ cid: claims.cid, tv: 3 }, '', {
      algorithm: 'none',
      subject: claims.sub,
      audience: 'cognition-iq:access',
      issuer: 'cognition-iq',
    });
    expect(() => svc.verifyAccess(none)).toThrow();
  });
});
