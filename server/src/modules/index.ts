import { Router } from 'express';
import { Types } from 'mongoose';
import { createGuards } from '../common/auth';
import { deriveKey } from '../common/crypto';
import type { Env } from '../config/env';
import type { Logger } from '../common/logger';
import type { CounterStore } from '../common/rateLimit';
import { academicsRouter } from './academics/academics.routes';
import { AcademicsService } from './academics/academics.service';
import { AttemptService } from './attempts/attempt.service';
import { createAttemptLookup } from './attempts/attempt.lookup';
import { studentExamRouter } from './attempts/attempt.routes';
import { AttemptSweeper } from './attempts/attempt.sweeper';
import { AuditService } from './audit/audit.service';
import { resultsRouter, studentResultsRouter } from './results/results.routes';
import { ResultsService } from './results/results.service';
import { AuthService } from './auth/auth.service';
import { authRouter } from './auth/auth.routes';
import { importRouter } from './imports/import.routes';
import { ImportService } from './imports/import.service';
import { ImportWorker } from './imports/import.worker';
import { PasswordService } from './auth/password.service';
import type { AttemptLookup } from './quizzes/quiz.rules';
import { quizRouter, studentQuizRouter } from './quizzes/quiz.routes';
import { QuizService } from './quizzes/quiz.service';
import { questionRouter } from './questions/question.routes';
import { QuestionService } from './questions/question.service';
import { TokenService } from './auth/token.service';
import { adminRouter } from './users/admin.routes';
import { UserAdminService } from './users/admin.service';

export interface ApiConfig {
  collegeId: string;
  accessTokenSecret: string;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  twoFactorEncryptionKey: string;
  argon2: { memoryKib: number; timeCost: number };
  cookieSecure: boolean;
  clientOrigin: string;
  importRetentionDays: number;
  examGraceSeconds: number;
  displayTimeZone: string;
}

export const apiConfigFromEnv = (env: Env): ApiConfig => ({
  collegeId: env.COLLEGE_ID,
  accessTokenSecret: env.ACCESS_TOKEN_SECRET,
  accessTokenTtl: env.ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  twoFactorEncryptionKey: env.TWO_FACTOR_ENCRYPTION_KEY,
  argon2: { memoryKib: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST },
  cookieSecure: env.COOKIE_SECURE,
  clientOrigin: env.CLIENT_ORIGIN,
  importRetentionDays: env.IMPORT_RETENTION_DAYS,
  examGraceSeconds: env.EXAM_GRACE_SECONDS,
  displayTimeZone: env.DISPLAY_TIMEZONE,
});

/** Composition root: builds services once and returns a function that mounts routers on /api/v1. */
export function createApiModules(
  cfg: ApiConfig,
  deps: { logger: Logger; store: CounterStore; now?: () => number; shouldPause?: () => Promise<boolean>; attempts?: AttemptLookup },
) {
  const collegeId = new Types.ObjectId(cfg.collegeId);
  const passwords = new PasswordService(cfg.argon2);
  const tokens = new TokenService({ secret: cfg.accessTokenSecret, accessTtl: cfg.accessTokenTtl });
  const audit = new AuditService(deps.logger);
  const refreshTtlMs = cfg.refreshTokenTtlDays * 24 * 60 * 60 * 1000;

  const auth = new AuthService({
    collegeId,
    passwords,
    tokens,
    store: deps.store,
    audit,
    refreshTtlMs,
    twoFactorKey: cfg.twoFactorEncryptionKey,
    now: deps.now,
  });
  const admin = new UserAdminService({ collegeId, passwords, audit });
  const academics = new AcademicsService(audit);
  const questions = new QuestionService(audit);
  const clock = deps.now;
  const now = clock ? () => new Date(clock()) : undefined;
  const quizCodeKey = deriveKey(cfg.twoFactorEncryptionKey, 'quiz-codes-v1'); // access codes are HMAC-hashed with their own sub-key
  const attempts = new AttemptService({
    store: deps.store,
    codeKey: quizCodeKey,
    graceMs: cfg.examGraceSeconds * 1000,
    logger: deps.logger,
    now,
  });
  const quizzes = new QuizService({
    audit,
    codeKey: quizCodeKey,
    attempts: deps.attempts ?? createAttemptLookup(),
    now,
  });
  const sweeper = new AttemptSweeper({ attempts, logger: deps.logger, now });
  const results = new ResultsService({ audit, attempts, timeZone: cfg.displayTimeZone, now });
  // Temporary import passwords are encrypted with a purpose-specific sub-key, never the master key.
  const credentialKey = deriveKey(cfg.twoFactorEncryptionKey, 'import-credentials-v1');
  const imports = new ImportService({ audit, credentialKey, retentionDays: cfg.importRetentionDays });
  const importWorker = new ImportWorker({
    audit,
    passwords,
    imports,
    credentialKey,
    logger: deps.logger,
    retentionDays: cfg.importRetentionDays,
    // Imports hash passwords (CPU heavy): they wait while any exam is running or open.
    shouldPause: deps.shouldPause ?? (() => attempts.examWindowOpen()),
  });
  const guards = createGuards(tokens);
  const allowedOrigin = new URL(cfg.clientOrigin).origin;

  const mount = (v1: Router): void => {
    v1.use('/auth', authRouter(auth, guards, { allowedOrigin, cookieSecure: cfg.cookieSecure, refreshTtlMs }));
    v1.use('/admin', adminRouter(admin, guards));
    v1.use('/academics', academicsRouter(academics, guards));
    v1.use('/imports', importRouter(imports, guards));
    v1.use('/questions', questionRouter(questions, guards));
    v1.use('/quizzes', quizRouter(quizzes, guards));
    v1.use('/quizzes', resultsRouter(results, guards));
    v1.use('/student/quizzes', studentQuizRouter(quizzes, guards));
    v1.use('/student', studentExamRouter(attempts, guards));
    v1.use('/student', studentResultsRouter(results, guards));
  };

  return { mount, passwords, tokens, audit, auth, admin, academics, questions, quizzes, attempts, sweeper, results, imports, importWorker, guards, collegeId };
}
