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
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have access to this resource'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Resource not found'),
  conflict: (message = 'Conflict') => new AppError(409, 'CONFLICT', message),
  rateLimited: () => new AppError(429, 'RATE_LIMITED', 'Too many requests'),
};
