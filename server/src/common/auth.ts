import type { RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { Errors } from './errors';
import { asyncHandler } from './http';
import type { TokenService } from '../modules/auth/token.service';
import { User, type Role } from '../modules/users/user.model';

export type PendingAction = 'change_password' | 'setup_2fa';

/** Roles that must have TOTP enabled before they can use the API. */
export const ROLES_REQUIRING_2FA: readonly Role[] = ['SUPER_ADMIN', 'HOD'];

export function computePendingActions(u: {
  role: Role;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
}): PendingAction[] {
  const pending: PendingAction[] = [];
  if (u.mustChangePassword) pending.push('change_password');
  if (ROLES_REQUIRING_2FA.includes(u.role) && !u.twoFactorEnabled) pending.push('setup_2fa');
  return pending;
}

/** Identity as established on the server from the database, never from client input. */
export interface AuthContext {
  userId: string;
  collegeId: Types.ObjectId;
  role: Role;
  departmentId?: string;
  pendingActions: PendingAction[];
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface Guards {
  /**
   * Verifies the bearer token, then re-loads the user so inactive/pending/deleted accounts and
   * revoked tokens are rejected immediately. `allow` lists the unfinished setup steps this
   * endpoint may be used during (e.g. the change-password endpoint itself).
   */
  requireAuth(opts?: { allow?: PendingAction[] }): RequestHandler;
  requireRole(...roles: Role[]): RequestHandler;
}

export function createGuards(tokens: TokenService): Guards {
  return {
    requireAuth: (opts = {}) =>
      asyncHandler(async (req, _res, next) => {
        const match = /^Bearer (.+)$/i.exec(req.header('authorization') ?? '');
        if (!match || !match[1]) throw Errors.unauthenticated();
        const claims = tokens.verifyAccess(match[1]);

        const user = await User.findOne({
          _id: claims.sub,
          collegeId: claims.cid,
          deletedAt: null,
        }).select('role status collegeId departmentId tokenVersion mustChangePassword twoFactor.enabled');

        if (!user || user.status !== 'active' || user.tokenVersion !== claims.tv) {
          throw Errors.unauthenticated();
        }

        const pending = computePendingActions({
          role: user.role,
          mustChangePassword: user.mustChangePassword,
          twoFactorEnabled: user.twoFactor?.enabled ?? false,
        });
        const allow = opts.allow ?? [];
        const blocked = pending.filter((p) => !allow.includes(p));
        if (blocked.length > 0) throw Errors.actionRequired(blocked);

        req.auth = {
          userId: user.id,
          collegeId: user.collegeId,
          role: user.role,
          departmentId: user.departmentId?.toString(),
          pendingActions: pending,
        };
        next();
      }),

    requireRole:
      (...roles) =>
      (req, _res, next) => {
        if (!req.auth) return next(Errors.unauthenticated());
        if (!roles.includes(req.auth.role)) return next(Errors.forbidden());
        next();
      },
  };
}
