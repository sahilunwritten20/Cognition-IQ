import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { AuditLog } from '../modules/audit/audit.model';
import { PasswordService } from '../modules/auth/password.service';
import { revokeAllForUser } from '../modules/auth/session.model';
import { User } from '../modules/users/user.model';

/**
 * BREAK-GLASS recovery for a SUPER_ADMIN who cannot sign in AND has no second admin to help.
 * Needs direct access to the server environment (database credentials), so it is an operator action:
 *   npm run recover:admin -w server -- --yes
 * It clears the admin's authenticator, signs them out everywhere, optionally sets a new temporary
 * password, and writes an audit record. They must enrol 2FA again at next login.
 */
const schema = z.object({
  MONGODB_URI: z.string().min(1),
  COLLEGE_ID: z.string().regex(/^[a-f0-9]{24}$/i),
  RECOVER_LOGIN_ID: z.string().trim().min(3).max(100),
  RECOVER_NEW_PASSWORD: z.string().min(12).max(128).optional(),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
});

async function main() {
  if (!process.argv.includes('--yes')) {
    throw new Error('Refusing to run without --yes. Read docs/operations/RUNBOOK-admin-recovery.md first.');
  }
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Missing or invalid variables: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const env = parsed.data;
  const collegeId = new Types.ObjectId(env.COLLEGE_ID);
  const loginId = env.RECOVER_LOGIN_ID.toLowerCase();

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const admin = await User.findOne({ collegeId, loginId, role: 'SUPER_ADMIN', deletedAt: null });
    if (!admin) throw new Error(`No SUPER_ADMIN with login ID "${loginId}" in this college.`);

    const set: Record<string, unknown> = { 'twoFactor.enabled': false, status: 'active' };
    if (env.RECOVER_NEW_PASSWORD) {
      const passwords = new PasswordService({ memoryKib: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST });
      set.passwordHash = await passwords.hash(env.RECOVER_NEW_PASSWORD);
      set.mustChangePassword = true;
    }
    await User.updateOne(
      { _id: admin._id },
      {
        $set: set,
        $unset: { 'twoFactor.secretEnc': '', 'twoFactor.pendingSecretEnc': '', 'twoFactor.lastUsedStep': '' },
        $inc: { tokenVersion: 1 },
      },
    );
    await revokeAllForUser(admin._id, 'admin');
    await AuditLog.create({
      collegeId,
      action: 'ops.admin_recovery',
      targetType: 'user',
      targetId: admin.id,
      summary: {
        via: 'break-glass script',
        operator: process.env.USERNAME ?? process.env.USER ?? 'unknown',
        passwordReset: Boolean(env.RECOVER_NEW_PASSWORD),
      },
    });
    console.log(`Recovered "${loginId}": 2FA cleared, sessions revoked${env.RECOVER_NEW_PASSWORD ? ', password reset' : ''}.`);
    console.log('Remove RECOVER_* from your environment now. The admin must enrol 2FA at next login.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
