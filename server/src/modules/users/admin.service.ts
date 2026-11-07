import { Types, type FilterQuery, type UpdateQuery } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { Errors } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { generateTemporaryPassword, type PasswordService } from '../auth/password.service';
import type { RequestMeta } from '../auth/auth.service';
import { revokeAllForUser } from '../auth/session.model';
import { toPublicUser, type PublicUser } from './user.dto';
import { User, type IUser, type Role, type UserStatus } from './user.model';

export interface AdminDeps {
  collegeId: Types.ObjectId;
  passwords: PasswordService;
  audit: AuditService;
}

interface Transition {
  from: UserStatus[];
  to: UserStatus;
  action: string;
  reason?: string;
  revokeSessions: boolean;
}

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

/** SUPER_ADMIN-only user administration. Every query is scoped by the caller's collegeId. */
export class UserAdminService {
  constructor(private readonly d: AdminDeps) {}

  async list(
    actor: AuthContext,
    q: { status?: UserStatus; role?: Role; page: number; pageSize: number },
  ): Promise<{ items: PublicUser[]; page: number; pageSize: number; total: number }> {
    const filter: FilterQuery<IUser> = { collegeId: actor.collegeId, deletedAt: null };
    if (q.status) filter.status = q.status;
    if (q.role) filter.role = q.role;
    const [docs, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      User.countDocuments(filter),
    ]);
    return { items: docs.map(toPublicUser), page: q.page, pageSize: q.pageSize, total };
  }

  /** Creates an active account with a one-time temporary password (shown once, never stored). */
  async create(
    actor: AuthContext,
    input: { name: string; loginId: string; role: Role; departmentId?: string },
    meta: RequestMeta,
  ): Promise<{ user: PublicUser; temporaryPassword: string }> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.d.passwords.hash(temporaryPassword);
    try {
      const user = await User.create({
        collegeId: actor.collegeId,
        name: input.name,
        loginId: input.loginId,
        passwordHash,
        role: input.role,
        status: 'active',
        mustChangePassword: true,
        ...(input.departmentId ? { departmentId: new Types.ObjectId(input.departmentId) } : {}),
      });
      await this.audit(actor, meta, 'admin.user_created', user.id, { role: input.role });
      return { user: toPublicUser(user), temporaryPassword };
    } catch (err) {
      if (isDuplicateKey(err)) throw Errors.conflict('A user with this login ID already exists');
      throw err;
    }
  }

  approve(actor: AuthContext, id: string, meta: RequestMeta): Promise<PublicUser> {
    return this.transition(actor, id, meta, { from: ['pending'], to: 'active', action: 'admin.user_approved', revokeSessions: false });
  }

  reject(actor: AuthContext, id: string, reason: string | undefined, meta: RequestMeta): Promise<PublicUser> {
    return this.transition(actor, id, meta, { from: ['pending'], to: 'inactive', action: 'admin.user_rejected', reason, revokeSessions: false });
  }

  deactivate(actor: AuthContext, id: string, reason: string | undefined, meta: RequestMeta): Promise<PublicUser> {
    return this.transition(actor, id, meta, { from: ['active'], to: 'inactive', action: 'admin.user_deactivated', reason, revokeSessions: true });
  }

  activate(actor: AuthContext, id: string, meta: RequestMeta): Promise<PublicUser> {
    return this.transition(actor, id, meta, { from: ['inactive'], to: 'active', action: 'admin.user_activated', revokeSessions: false });
  }

  /** Admin-initiated reset (R1). Forces a change at next login and signs the user out everywhere. */
  async resetPassword(actor: AuthContext, id: string, meta: RequestMeta): Promise<{ temporaryPassword: string }> {
    const target = await this.findTarget(actor, id);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.d.passwords.hash(temporaryPassword);
    await User.updateOne(
      { _id: target._id, collegeId: actor.collegeId },
      { $set: { passwordHash, mustChangePassword: true }, $inc: { tokenVersion: 1 } },
    );
    await revokeAllForUser(target._id, 'admin');
    await this.audit(actor, meta, 'admin.password_reset', target.id); // the password itself is never logged
    return { temporaryPassword };
  }

  /**
   * Clears a user's authenticator (lost phone). They must enrol a new one at next login, and all their
   * sessions end. Combined with a second SUPER_ADMIN this is the normal recovery path; the
   * break-glass script (scripts/recover-admin.ts) covers the case where no admin can sign in.
   */
  async resetTwoFactor(actor: AuthContext, id: string, reason: string, meta: RequestMeta): Promise<PublicUser> {
    const target = await this.findTarget(actor, id);
    const updated = await User.findOneAndUpdate(
      { _id: target._id, collegeId: actor.collegeId },
      {
        $set: { 'twoFactor.enabled': false },
        $unset: { 'twoFactor.secretEnc': '', 'twoFactor.pendingSecretEnc': '', 'twoFactor.lastUsedStep': '' },
        $inc: { tokenVersion: 1 },
      },
      { new: true },
    );
    if (!updated) throw Errors.notFound();
    await revokeAllForUser(updated._id, 'admin');
    await this.audit(actor, meta, 'admin.2fa_reset', updated.id, { reason });
    return toPublicUser(updated);
  }

  // ---------------------------------------------------------------- internals
  /**
   * Admins may act on any user in their college EXCEPT themselves (so one admin can recover another,
   * but nobody can lock themselves out or silently change their own credentials). Every action is audited.
   */
  private async findTarget(actor: AuthContext, id: string) {
    const target = await User.findOne({ _id: id, collegeId: actor.collegeId, deletedAt: null });
    if (!target) throw Errors.notFound();
    if (target.id === actor.userId) throw Errors.forbidden();
    return target;
  }

  private async transition(actor: AuthContext, id: string, meta: RequestMeta, t: Transition): Promise<PublicUser> {
    const target = await this.findTarget(actor, id);
    const update: UpdateQuery<IUser> = { $set: { status: t.to } };
    if (t.revokeSessions) update.$inc = { tokenVersion: 1 };

    // Conditional on the current status, so two admins acting at once cannot double-apply.
    const updated = await User.findOneAndUpdate(
      { _id: target._id, collegeId: actor.collegeId, status: { $in: t.from } },
      update,
      { new: true },
    );
    if (!updated) throw Errors.conflict('The user is not in a state that allows this action');
    if (t.revokeSessions) await revokeAllForUser(updated._id, 'admin');
    await this.audit(actor, meta, t.action, updated.id, { from: target.status, to: t.to, reason: t.reason });
    return toPublicUser(updated);
  }

  private audit(actor: AuthContext, meta: RequestMeta, action: string, targetId: string, summary?: Record<string, unknown>) {
    return this.d.audit.record({
      collegeId: actor.collegeId,
      actorId: actor.userId,
      action,
      targetType: 'user',
      targetId,
      summary,
      requestId: meta.requestId,
      ip: meta.ip,
    });
  }
}
