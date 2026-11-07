export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details?: unknown) => new AppError(400, 'VALIDATION_ERROR', 'Invalid request', details),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required'),
  // One message for every login failure (unknown, wrong password, pending, inactive) so it reveals nothing,
  // while still telling a newly registered student why they may not be able to sign in yet.
  invalidCredentials: () =>
    new AppError(
      401,
      'INVALID_CREDENTIALS',
      'Invalid login ID or password. If you registered recently, your account may still be awaiting administrator approval.',
    ),
  wrongPassword: () => new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect'),
  invalidCode: () => new AppError(401, 'INVALID_CODE', 'Invalid or expired code'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have access to this resource'),
  csrf: () => new AppError(403, 'CSRF_REJECTED', 'Request rejected'),
  actionRequired: (pending: string[]) =>
    new AppError(403, 'ACTION_REQUIRED', 'Complete required account setup first', {
      pendingActions: pending,
    }),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Resource not found'),
  conflict: (message = 'Conflict') => new AppError(409, 'CONFLICT', message),
  refreshInProgress: () =>
    new AppError(409, 'REFRESH_IN_PROGRESS', 'Session refresh in progress, retry'),
  rateLimited: () => new AppError(429, 'RATE_LIMITED', 'Too many requests'),
};
