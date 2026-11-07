import { Router, type Request, type Response } from 'express';
import type { Guards } from '../../common/auth';
import { csrfGuard } from '../../common/csrf';
import { AppError, Errors } from '../../common/errors';
import { asyncHandler } from '../../common/http';
import { parse } from '../../common/validate';
import {
  changePasswordSchema,
  enable2faSchema,
  loginSchema,
  registerSchema,
  verify2faSchema,
} from './auth.schemas';
import type { AuthService, RequestMeta, SessionResult } from './auth.service';

export const REFRESH_COOKIE = 'ciq_rt';
const COOKIE_PATH = '/api/v1/auth';

export interface AuthRouteConfig {
  allowedOrigin: string;
  cookieSecure: boolean;
  refreshTtlMs: number;
}

const meta = (req: Request): RequestMeta => ({
  ip: req.ip,
  userAgent: req.header('user-agent'),
  requestId: req.id,
});

const readRefreshCookie = (req: Request): string | undefined => {
  const raw: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
};

export function authRouter(auth: AuthService, guards: Guards, cfg: AuthRouteConfig): Router {
  const r = Router();
  const csrf = csrfGuard(cfg.allowedOrigin);
  // Endpoints that must stay usable while account setup is unfinished.
  const setupOk = guards.requireAuth({ allow: ['change_password', 'setup_2fa'] });

  const cookieOpts = {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'strict' as const,
    path: COOKIE_PATH,
  };
  const sendSession = (res: Response, s: SessionResult, status = 200): void => {
    res.cookie(REFRESH_COOKIE, s.refreshToken, { ...cookieOpts, maxAge: cfg.refreshTtlMs });
    // The refresh token is cookie-only: it never appears in a JSON body.
    res.status(status).json({
      accessToken: s.accessToken,
      expiresIn: s.expiresInSec,
      user: s.user,
      pendingActions: s.pendingActions,
    });
  };

  r.post(
    '/register',
    csrf,
    asyncHandler(async (req, res) => {
      await auth.register(parse(registerSchema, req.body), meta(req));
      res.status(202).json({ message: 'Registration request received. An administrator will review it.' });
    }),
  );

  r.post(
    '/login',
    csrf,
    asyncHandler(async (req, res) => {
      const result = await auth.login(parse(loginSchema, req.body), meta(req));
      if (result.twoFactorRequired) {
        res.json({ twoFactorRequired: true, challengeToken: result.challengeToken });
        return;
      }
      sendSession(res, result);
    }),
  );

  r.post(
    '/2fa/verify',
    csrf,
    asyncHandler(async (req, res) => {
      sendSession(res, await auth.verifyTwoFactorLogin(parse(verify2faSchema, req.body), meta(req)));
    }),
  );

  r.post(
    '/refresh',
    csrf,
    asyncHandler(async (req, res) => {
      try {
        sendSession(res, await auth.refresh(readRefreshCookie(req), meta(req)));
      } catch (err) {
        // A definitive failure clears the dead cookie; a race (409) keeps it so the client can retry.
        if (err instanceof AppError && err.status === 401) {
          res.clearCookie(REFRESH_COOKIE, cookieOpts);
        }
        throw err;
      }
    }),
  );

  r.post(
    '/logout',
    csrf,
    asyncHandler(async (req, res) => {
      await auth.logout(readRefreshCookie(req));
      res.clearCookie(REFRESH_COOKIE, cookieOpts);
      res.status(204).end();
    }),
  );

  r.get(
    '/me',
    setupOk,
    asyncHandler(async (req, res) => {
      if (!req.auth) throw Errors.unauthenticated();
      res.json(await auth.getProfile(req.auth.userId, req.auth.collegeId));
    }),
  );

  r.post(
    '/change-password',
    setupOk,
    asyncHandler(async (req, res) => {
      if (!req.auth) throw Errors.unauthenticated();
      const input = parse(changePasswordSchema, req.body);
      sendSession(res, await auth.changePassword(req.auth.userId, req.auth.collegeId, input, meta(req)));
    }),
  );

  r.post(
    '/2fa/setup',
    setupOk,
    asyncHandler(async (req, res) => {
      if (!req.auth) throw Errors.unauthenticated();
      res.json(await auth.beginTwoFactorSetup(req.auth.userId, req.auth.collegeId));
    }),
  );

  r.post(
    '/2fa/enable',
    setupOk,
    asyncHandler(async (req, res) => {
      if (!req.auth) throw Errors.unauthenticated();
      await auth.enableTwoFactor(req.auth.userId, req.auth.collegeId, parse(enable2faSchema, req.body).code, meta(req));
      res.status(204).end();
    }),
  );

  return r;
}
