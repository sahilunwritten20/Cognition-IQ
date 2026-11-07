import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { PasswordService } from '../modules/auth/password.service';
import { User } from '../modules/users/user.model';

// Creates the FIRST SUPER_ADMIN from environment variables. Idempotent. No default password exists.
const schema = z.object({
  MONGODB_URI: z.string().min(1),
  COLLEGE_ID: z.string().regex(/^[a-f0-9]{24}$/i),
  SEED_ADMIN_LOGIN_ID: z.string().trim().min(3).max(100),
  SEED_ADMIN_NAME: z.string().trim().min(2).max(120),
  SEED_ADMIN_PASSWORD: z.string().min(12).max(128),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
});

async function main() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid seed variables: ${fields}`);
  }
  const env = parsed.data;
  const collegeId = new Types.ObjectId(env.COLLEGE_ID);

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    await User.init(); // make sure the unique index exists before inserting
    if (await User.exists({ collegeId, role: 'SUPER_ADMIN', deletedAt: null })) {
      console.log('A SUPER_ADMIN already exists for this college. Nothing to do.');
      return;
    }
    const passwords = new PasswordService({ memoryKib: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST });
    await User.create({
      collegeId,
      name: env.SEED_ADMIN_NAME,
      loginId: env.SEED_ADMIN_LOGIN_ID,
      passwordHash: await passwords.hash(env.SEED_ADMIN_PASSWORD),
      role: 'SUPER_ADMIN',
      status: 'active',
      mustChangePassword: true, // must set a new password and enrol 2FA at first login
    });
    console.log(`Created SUPER_ADMIN "${env.SEED_ADMIN_LOGIN_ID.toLowerCase()}". Remove SEED_* from your environment now.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
