import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { computePendingActions, type PendingAction } from '../../common/auth';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../../common/crypto';
import { Errors } from '../../common/errors';
import type { CounterStore } from '../../common/rateLimit';
import { buildOtpauthUrl, generateTotpSecret, verifyTotp } from '../../common/totp';
import { AuditService } from '../audit/audit.service';
import { toPublicUser, type PublicUser } from '../users/user.dto';
import { User, type UserDoc } from '../users/user.model';
import type { PasswordService } from './password.service';
import { RefreshSession, revokeAllForUser, revokeFamily } from './session.model';
import type { TokenService } from './token.service';

// Starting values (guide Section 7): tune by load test. Per-IP limits are generous because
// many students share one college NAT address.
const LIMITS = {
  loginPerAccount: 10, // failed logins per account per 15 min
  loginPerIp: 300, // all login attempts per IP per 15 min
  registerPerIp: 100, // registrations per IP per hour
  twoFactorFailures: 5, // per user per 10 min
  passwordFailures: 5, // wrong current-password attempts per user per 15 min
};
const MIN_15 = 15 * 60;
const MIN_10 = 10 * 60;
const ROTATION_GRACE_MS = 10_000; // tolerate two tabs refreshing at the same instant

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface SessionResult {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string; // raw value: the route puts it in an HttpOnly cookie, never in JSON
  user: PublicUser;
  pendingActions: PendingAction[];
}

export type LoginResult =
  | ({ twoFactorRequired: false } & SessionResult)
  | { twoFactorRequired: true; challengeToken: string };

export interface AuthDeps {
  collegeId: Types.ObjectId;
  passwords: PasswordService;
  tokens: TokenService;
  store: CounterStore;
  audit: AuditService;
  refreshTtlMs: number;
  twoFactorKey: string;
  now?: () => number; // injectable clock (TOTP tests)
}

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

export class AuthService {
  constructor(private readonly d: AuthDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private async hit(key: string, max: number, windowSec: number): Promise<void> {
    if ((await this.d.store.incr(key, windowSec)) > max) throw Errors.rateLimited();
  }

  private async assertBelow(key: string, max: number): Promise<void> {
    if ((await this.d.store.get(key)) >= max) throw Errors.rateLimited();
  }

  // ---------------------------------------------------------------- registration
  /** Students only; always creates a PENDING account. Same outcome whether or not the ID exists. */
  async register(input: { name: string; loginId: string; password: string }, meta: RequestMeta): Promise<void> {
    await this.hit(`register:ip:${meta.ip ?? 'unknown'}`, LIMITS.registerPerIp, 3600);
    const passwordHash = await this.d.passwords.hash(input.password); // hash first: equal timing
    try {
      const user = await User.create({
        collegeId: this.d.collegeId,
        name: input.name,
        loginId: input.loginId,
        passwordHash,
        role: 'STUDENT',
        status: 'pending',
        mustChangePassword: false,
      });
      await this.d.audit.record({
        collegeId: this.d.collegeId,
        actorId: user._id,
        action: 'auth.register_requested',
        targetType: 'user',
        targetId: user.id,
        requestId: meta.requestId,
        ip: meta.ip,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // duplicate: silently identical to success
    }
  }

  // ---------------------------------------------------------------- login
  async login(input: { loginId: string; password: string }, meta: RequestMeta): Promise<LoginResult> {
    await this.hit(`login:ip:${meta.ip ?? 'unknown'}`, LIMITS.loginPerIp, MIN_15);
    const acctKey = `login:acct:${input.loginId}`;
    await this.assertBelow(acctKey, LIMITS.loginPerAccount);

    const user = await User.findOne({
      collegeId: this.d.collegeId,
      loginId: input.loginId,
      deletedAt: null,
    }).select('+passwordHash');

    let passwordOk = false;
    if (user) passwordOk = await this.d.passwords.verify(user.passwordHash, input.password);
    else await this.d.passwords.verifyAgainstDummy(input.password);

    // One generic failure for: unknown user, wrong password, pending or inactive account.
    if (!user || !passwordOk || user.status !== 'active') {
      await this.d.store.incr(acctKey, MIN_15);
      throw Errors.invalidCredentials();
    }
    await this.d.store.reset(acctKey);

    if (user.twoFactor?.enabled) {
      return {
        twoFactorRequired: true,
        challengeToken: this.d.tokens.signChallenge({
          sub: user.id,
          cid: user.collegeId.toString(),
          tv: user.tokenVersion,
        }),
      };
    }
    return { twoFactorRequired: false, ...(await this.issueSession(user, meta)) };
  }

  async verifyTwoFactorLogin(
    input: { challengeToken: string; code: string },
    meta: RequestMeta,
  ): Promise<SessionResult> {
    const claims = this.d.tokens.verifyChallenge(input.challengeToken);
    const key = `2fa:${claims.sub}`;
    await this.assertBelow(key, LIMITS.twoFactorFailures);

    const user = await User.findOne({
      _id: claims.sub,
      collegeId: claims.cid,
      deletedAt: null,
    }).select('+twoFactor.secretEnc +twoFactor.lastUsedStep');

    if (
      !user ||
      user.status !== 'active' ||
      user.tokenVersion !== claims.tv ||
      !user.twoFactor?.enabled ||
      !user.twoFactor.secretEnc
    ) {
      throw Errors.unauthenticated();
    }

    const step = verifyTotp(decryptSecret(user.twoFactor.secretEnc, this.d.twoFactorKey), input.code, this.now());
    const last = user.twoFactor.lastUsedStep;
    if (step === null || (last !== undefined && step <= last)) {
      await this.d.store.incr(key, MIN_10);
      throw Errors.invalidCode();
    }

    // Atomic replay protection: only the first request to claim this step wins.
    const claimed = await User.updateOne(
      {
        _id: user._id,
        $or: [{ 'twoFactor.lastUsedStep': { $exists: false } }, { 'twoFactor.lastUsedStep': { $lt: step } }],
      },
      { $set: { 'twoFactor.lastUsedStep': step } },
    );
    if (claimed.modifiedCount !== 1) {
      await this.d.store.incr(key, MIN_10);
      throw Errors.invalidCode();
    }
    await this.d.store.reset(key);
    return this.issueSession(user, meta);
  }

  // ---------------------------------------------------------------- sessions
  private async issueSession(user: UserDoc, meta: RequestMeta, familyId: string = randomUUID()): Promise<SessionResult> {
    const refreshToken = randomToken();
    await RefreshSession.create({
      userId: user._id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + this.d.refreshTtlMs),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 200),
    });
    const { token, expiresInSec } = this.d.tokens.signAccess({
      sub: user.id,
      cid: user.collegeId.toString(),
      tv: user.tokenVersion,
    });
    return {
      accessToken: token,
      expiresInSec,
      refreshToken,
      user: toPublicUser(user),
      pendingActions: computePendingActions({
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        twoFactorEnabled: user.twoFactor?.enabled ?? false,
      }),
    };
  }

  /** Rotating refresh token with reuse detection. */
  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<SessionResult> {
    if (!rawToken) throw Errors.unauthenticated();
    const tokenHash = sha256(rawToken);
    const now = new Date();

    // Atomic claim: exactly one request can rotate a given token.
    const claimed = await RefreshSession.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { revokedAt: now, revokeReason: 'rotated' } },
    );

    if (!claimed) {
      const existing = await RefreshSession.findOne({ tokenHash });
      if (existing?.revokedAt && existing.revokeReason === 'rotated') {
        if (now.getTime() - existing.revokedAt.getTime() < ROTATION_GRACE_MS) {
          throw Errors.refreshInProgress(); // two tabs raced: not an attack, just retry
        }
        // An already-rotated token came back later: assume theft, kill the whole chain.
        await revokeFamily(existing.familyId, 'reuse_detected');
        await this.d.audit.record({
          collegeId: this.d.collegeId,
          actorId: existing.userId,
          action: 'auth.refresh_reuse_detected',
          targetType: 'user',
          targetId: existing.userId.toString(),
          requestId: meta.requestId,
          ip: meta.ip,
        });
      }
      throw Errors.unauthenticated();
    }

    const user = await User.findOne({ _id: claimed.userId, collegeId: this.d.collegeId, deletedAt: null });
    if (!user || user.status !== 'active') {
      await revokeFamily(claimed.familyId, 'admin');
      throw Errors.unauthenticated();
    }
    return this.issueSession(user, meta, claimed.familyId);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const session = await RefreshSession.findOne({ tokenHash: sha256(rawToken) });
    if (session) await revokeFamily(session.familyId, 'logout');
  }

  // ---------------------------------------------------------------- account
  async getProfile(userId: string, collegeId: Types.ObjectId): Promise<{ user: PublicUser; pendingActions: PendingAction[] }> {
    const user = await User.findOne({ _id: userId, collegeId, deletedAt: null });
    if (!user) throw Errors.unauthenticated();
    return {
      user: toPublicUser(user),
      pendingActions: computePendingActions({
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        twoFactorEnabled: user.twoFactor?.enabled ?? false,
      }),
    };
  }

  async changePassword(
    userId: string,
    collegeId: Types.ObjectId,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<SessionResult> {
    const key = `pw:${userId}`;
    await this.assertBelow(key, LIMITS.passwordFailures);

    const user = await User.findOne({ _id: userId, collegeId, deletedAt: null }).select('+passwordHash');
    if (!user || user.status !== 'active') throw Errors.unauthenticated();

    if (!(await this.d.passwords.verify(user.passwordHash, input.currentPassword))) {
      await this.d.store.incr(key, MIN_15);
      throw Errors.wrongPassword();
    }
    if (input.currentPassword === input.newPassword) {
      throw Errors.validation([{ path: 'newPassword', message: 'must differ from the current password' }]);
    }

    const passwordHash = await this.d.passwords.hash(input.newPassword);
    const updated = await User.findOneAndUpdate(
      { _id: user._id },
      { $set: { passwordHash, mustChangePassword: false }, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    if (!updated) throw Errors.unauthenticated();

    await this.d.store.reset(key);
    await revokeAllForUser(updated._id, 'password_change'); // every other device is signed out
    await this.d.audit.record({
      collegeId: this.d.collegeId,
      actorId: updated._id,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: updated.id,
      requestId: meta.requestId,
      ip: meta.ip,
    });
    return this.issueSession(updated, meta);
  }

  // ---------------------------------------------------------------- 2FA enrolment
  async beginTwoFactorSetup(userId: string, collegeId: Types.ObjectId): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await User.findOne({ _id: userId, collegeId, deletedAt: null });
    if (!user) throw Errors.unauthenticated();
    if (user.twoFactor?.enabled) throw Errors.conflict('Two-factor authentication is already enabled');

    const secret = generateTotpSecret();
    await User.updateOne(
      { _id: user._id },
      { $set: { 'twoFactor.pendingSecretEnc': encryptSecret(secret, this.d.twoFactorKey) } },
    );
    return { secret, otpauthUrl: buildOtpauthUrl(secret, user.loginId) };
  }

  async enableTwoFactor(userId: string, collegeId: Types.ObjectId, code: string, meta: RequestMeta): Promise<void> {
    const key = `2fa:${userId}`;
    await this.assertBelow(key, LIMITS.twoFactorFailures);

    const user = await User.findOne({ _id: userId, collegeId, deletedAt: null }).select('+twoFactor.pendingSecretEnc');
    if (!user) throw Errors.unauthenticated();
    if (user.twoFactor?.enabled) throw Errors.conflict('Two-factor authentication is already enabled');
    const pending = user.twoFactor?.pendingSecretEnc;
    if (!pending) throw Errors.conflict('Start two-factor setup first');

    const step = verifyTotp(decryptSecret(pending, this.d.twoFactorKey), code, this.now());
    if (step === null) {
      await this.d.store.incr(key, MIN_10);
      throw Errors.invalidCode();
    }
    await User.updateOne(
      { _id: user._id },
      {
        $set: { 'twoFactor.enabled': true, 'twoFactor.secretEnc': pending, 'twoFactor.lastUsedStep': step },
        $unset: { 'twoFactor.pendingSecretEnc': '' },
      },
    );
    await this.d.store.reset(key);
    await this.d.audit.record({
      collegeId: this.d.collegeId,
      actorId: user._id,
      action: 'auth.2fa_enabled',
      targetType: 'user',
      targetId: user.id,
      requestId: meta.requestId,
      ip: meta.ip,
    });
  }
}
