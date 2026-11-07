import type { RequestHandler } from 'express';
import { Errors } from './errors';

/**
 * CSRF defence for cookie-involving endpoints (login, refresh, logout, 2FA verify).
 * 1. If an Origin header is sent it must be our client origin.
 * 2. A custom header is required: cross-site forms cannot set it, and CORS blocks other sites.
 * Combined with a SameSite=Strict refresh cookie. See docs/architecture/ADR-002-auth.md.
 */
export function csrfGuard(allowedOrigin: string): RequestHandler {
  return (req, _res, next) => {
    const origin = req.header('origin');
    if (origin !== undefined && origin !== allowedOrigin) return next(Errors.csrf());
    if (req.header('x-requested-with') !== 'cognition-iq') return next(Errors.csrf());
    next();
  };
}
