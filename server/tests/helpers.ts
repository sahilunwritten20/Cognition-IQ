import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Response } from 'supertest';
import { createApp } from '../src/app';
import { createLogger } from '../src/common/logger';
import { MemoryCounterStore } from '../src/common/rateLimit';
import { createApiModules, type ApiConfig } from '../src/modules';
import { initAcademicIndexes } from '../src/modules/academics/academics.models';
import { initAttemptIndexes } from '../src/modules/attempts/attempt.model';
import { initImportIndexes } from '../src/modules/imports/import.models';
import { initQuestionIndexes } from '../src/modules/questions/question.model';
import { initQuizIndexes } from '../src/modules/quizzes/quiz.model';
import type { AttemptLookup } from '../src/modules/quizzes/quiz.rules';
import { AuditLog } from '../src/modules/audit/audit.model';
import { RefreshSession } from '../src/modules/auth/session.model';
import { User, type Role, type UserDoc, type UserStatus } from '../src/modules/users/user.model';

export const CLIENT_ORIGIN = 'http://localhost:5173';
/** Headers a legitimate browser client sends to cookie/CSRF-protected endpoints. */
export const CSRF = { 'X-Requested-With': 'cognition-iq', Origin: CLIENT_ORIGIN };

export type TestCtx = Awaited<ReturnType<typeof startTestApp>>;

export async function startTestApp(opts: { attempts?: AttemptLookup } = {}) {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.init(), RefreshSession.init(), AuditLog.init(), initAcademicIndexes(), initImportIndexes(), initQuestionIndexes(), initQuizIndexes(), initAttemptIndexes()]);

  const cfg: ApiConfig = {
    collegeId: new Types.ObjectId().toString(),
    accessTokenSecret: 'a'.repeat(40),
    accessTokenTtl: '15m',
    refreshTokenTtlDays: 7,
    twoFactorEncryptionKey: 'ab'.repeat(32),
    argon2: { memoryKib: 1024, timeCost: 2 }, // cheap hashing for tests only
    cookieSecure: false,
    clientOrigin: CLIENT_ORIGIN,
    importRetentionDays: 30,
    examGraceSeconds: 15,
    displayTimeZone: 'Asia/Kolkata',
  };
  const clock = { now: Date.UTC(2026, 10, 6, 10, 0, 0) };
  const store = new MemoryCounterStore();
  const logger = createLogger('silent');
  const modules = createApiModules(cfg, { logger, store, now: () => clock.now, attempts: opts.attempts });
  const app = createApp({
    logger,
    clientOrigin: CLIENT_ORIGIN,
    checks: { mongo: async () => true, redis: async () => true },
    mount: modules.mount,
  });

  return {
    app,
    cfg,
    modules,
    store,
    clock,
    collegeId: modules.collegeId,
    stop: async () => {
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

let counter = 0;

export async function makeUser(
  ctx: TestCtx,
  o: Partial<{
    loginId: string;
    role: Role;
    status: UserStatus;
    password: string;
    mustChangePassword: boolean;
    twoFactorEnabled: boolean;
    departmentId: Types.ObjectId;
  }> = {},
): Promise<{ user: UserDoc; password: string }> {
  const password = o.password ?? 'Correct-Horse-9';
  counter += 1;
  const user = await User.create({
    collegeId: ctx.collegeId,
    name: 'Test User',
    loginId: o.loginId ?? `user${counter}`,
    passwordHash: await ctx.modules.passwords.hash(password),
    role: o.role ?? 'STUDENT',
    status: o.status ?? 'active',
    mustChangePassword: o.mustChangePassword ?? false,
    twoFactor: { enabled: o.twoFactorEnabled ?? false },
    ...(o.departmentId ? { departmentId: o.departmentId } : {}),
  });
  return { user, password };
}

/** Mint an access token directly (bypasses login) for permission tests. */
export function tokenFor(ctx: TestCtx, user: UserDoc, overrides: { tv?: number; cid?: string } = {}): string {
  return ctx.modules.tokens.signAccess({
    sub: user.id,
    cid: overrides.cid ?? ctx.collegeId.toString(),
    tv: overrides.tv ?? user.tokenVersion,
  }).token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** "ciq_rt=<value>" from a Set-Cookie header, ready to send back as a Cookie header. */
export function refreshCookie(res: Response): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string | string[] | undefined ?? []);
  const found = raw.find((c) => c.startsWith('ciq_rt='));
  if (!found) throw new Error('no refresh cookie in response');
  return (found.split(';')[0]) as string;
}

/** Every key at any nesting depth, for "forbidden field" scans. */
export function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
  return into;
}

export const FORBIDDEN_KEYS = [
  'passwordHash',
  'secretEnc',
  'pendingSecretEnc',
  'lastUsedStep',
  'tokenHash',
  'tokenVersion',
  'refreshToken',
  'correctOptionId',
  'answerKey',
  'internalNotes',
  'grading',
];
