import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const ROLES = ['SUPER_ADMIN', 'HOD', 'TEACHER', 'STUDENT'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['pending', 'active', 'inactive'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface IUser {
  collegeId: Types.ObjectId;
  name: string;
  loginId: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  departmentId?: Types.ObjectId;
  /** Incremented on password change/reset/deactivation: invalidates all outstanding access tokens. */
  tokenVersion: number;
  twoFactor: {
    enabled: boolean;
    secretEnc?: string;
    pendingSecretEnc?: string;
    lastUsedStep?: number;
  };
  deletedAt?: Date;
  deletedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    collegeId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    loginId: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: [...ROLES], required: true },
    status: { type: String, enum: [...USER_STATUSES], required: true, default: 'pending' },
    mustChangePassword: { type: Boolean, default: false },
    departmentId: { type: Schema.Types.ObjectId },
    tokenVersion: { type: Number, default: 0 },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      pendingSecretEnc: { type: String, select: false },
      lastUsedStep: { type: Number, select: false },
    },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// Login ID is unique per college (enforced by MongoDB, not by application pre-checks).
userSchema.index({ collegeId: 1, loginId: 1 }, { unique: true });
userSchema.index({ collegeId: 1, status: 1, role: 1, createdAt: -1 });

export const User = model<IUser>('User', userSchema);
export type UserDoc = HydratedDocument<IUser>;
