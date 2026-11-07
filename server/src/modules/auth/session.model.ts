import { Schema, model, type Types } from 'mongoose';

export type RevokeReason = 'rotated' | 'logout' | 'reuse_detected' | 'password_change' | 'admin';

/** One row per issued refresh token. A "family" is the chain of rotations from one login. */
export interface IRefreshSession {
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string; // SHA-256 of the opaque token; the raw token is never stored
  expiresAt: Date;
  revokedAt?: Date;
  revokeReason?: RevokeReason;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const sessionSchema = new Schema<IRefreshSession>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }, // TTL cleanup
    revokedAt: { type: Date },
    revokeReason: { type: String },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const RefreshSession = model<IRefreshSession>('RefreshSession', sessionSchema);

export async function revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
  await RefreshSession.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
  );
}

export async function revokeAllForUser(userId: Types.ObjectId, reason: RevokeReason): Promise<void> {
  await RefreshSession.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
  );
}
