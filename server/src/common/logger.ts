import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    // Never log credentials, tokens or answer keys.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.refreshToken',
        '*.correctOptionId',
      ],
      censor: '[redacted]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
