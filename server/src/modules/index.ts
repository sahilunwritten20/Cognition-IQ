import { Router } from 'express';
import { Types } from 'mongoose';
import { createGuards } from '../common/auth';
import { deriveKey } from '../common/crypto';
import type { Env } from '../config/env';
import type { Logger } from '../common/logger';
import type { CounterStore } from '../common/rateLimit';
import { academicsRouter } from './academics/academics.routes';
import { AcademicsService } from './academics/academics.service';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { authRouter } from './auth/auth.routes';
import { importRouter } from './imports/import.routes';
import { ImportService } from './imports/import.service';
import { ImportWorker } from './imports/import.worker';
import { PasswordService } from './auth/password.service';
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
});

/** Composition root: builds services once and returns a function that mounts routers on /api/v1. */
export function createApiModules(
  cfg: ApiConfig,
  deps: { logger: Logger; store: CounterStore; now?: () => number; shouldPause?: () => Promise<boolean> },
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
    shouldPause: deps.shouldPause, // the exam engine passes "is an exam window open?" here (Steps 6-7)
  });
  const guards = createGuards(tokens);
  const allowedOrigin = new URL(cfg.clientOrigin).origin;

  const mount = (v1: Router): void => {
    v1.use('/auth', authRouter(auth, guards, { allowedOrigin, cookieSecure: cfg.cookieSecure, refreshTtlMs }));
    v1.use('/admin', adminRouter(admin, guards));
    v1.use('/academics', academicsRouter(academics, guards));
    v1.use('/imports', importRouter(imports, guards));
    v1.use('/questions', questionRouter(questions, guards));
  };

  return { mount, passwords, tokens, audit, auth, admin, academics, questions, imports, importWorker, guards, collegeId };
}
