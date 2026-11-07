import jwt from 'jsonwebtoken';
import { Errors } from '../../common/errors';

const ISSUER = 'cognition-iq';
const AUD_ACCESS = 'cognition-iq:access';
const AUD_2FA = 'cognition-iq:2fa';
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Deliberately minimal. Role/status are always read from the database, never trusted from a token. */
export interface Claims {
  sub: string; // user id
  cid: string; // college id
  tv: number; // user.tokenVersion at issue time
}

function readClaims(payload: unknown): Claims | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sub !== 'string' || typeof p.cid !== 'string' || typeof p.tv !== 'number') return null;
  if (!OBJECT_ID.test(p.sub) || !OBJECT_ID.test(p.cid)) return null;
  return { sub: p.sub, cid: p.cid, tv: p.tv };
}

export class TokenService {
  constructor(private readonly cfg: { secret: string; accessTtl: string }) {}

  signAccess(c: Claims): { token: string; expiresInSec: number } {
    const token = jwt.sign({ cid: c.cid, tv: c.tv }, this.cfg.secret, {
      algorithm: 'HS256',
      subject: c.sub,
      audience: AUD_ACCESS,
      issuer: ISSUER,
      expiresIn: this.cfg.accessTtl as jwt.SignOptions['expiresIn'],
    });
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    return { token, expiresInSec: decoded.exp - decoded.iat };
  }

  /** Short-lived proof that the password step succeeded; only usable at /auth/2fa/verify. */
  signChallenge(c: Claims): string {
    return jwt.sign({ cid: c.cid, tv: c.tv }, this.cfg.secret, {
      algorithm: 'HS256',
      subject: c.sub,
      audience: AUD_2FA,
      issuer: ISSUER,
      expiresIn: '5m',
    });
  }

  verifyAccess(token: string): Claims {
    return this.verify(token, AUD_ACCESS);
  }

  verifyChallenge(token: string): Claims {
    return this.verify(token, AUD_2FA);
  }

  private verify(token: string, audience: string): Claims {
    let claims: Claims | null = null;
    try {
      const payload = jwt.verify(token, this.cfg.secret, {
        algorithms: ['HS256'], // never accept "none" or other algorithms
        audience,
        issuer: ISSUER,
      });
      claims = readClaims(payload);
    } catch {
      claims = null;
    }
    if (!claims) throw Errors.unauthenticated();
    return claims;
  }
}
