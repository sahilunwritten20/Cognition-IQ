import type { Role, UserDoc, UserStatus } from './user.model';

/** The only user shape that ever leaves the API. Never serialize documents directly. */
export interface PublicUser {
  id: string;
  name: string;
  loginId: string;
  role: Role;
  status: UserStatus;
  departmentId: string | null;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
}

export function toPublicUser(u: UserDoc): PublicUser {
  return {
    id: u.id,
    name: u.name,
    loginId: u.loginId,
    role: u.role,
    status: u.status,
    departmentId: u.departmentId ? u.departmentId.toString() : null,
    mustChangePassword: u.mustChangePassword,
    twoFactorEnabled: u.twoFactor?.enabled ?? false,
    createdAt: u.createdAt.toISOString(),
  };
}
