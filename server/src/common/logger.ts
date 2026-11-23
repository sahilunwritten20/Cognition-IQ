import pino, { type DestinationStream } from 'pino';

/** `destination` exists so tests can capture and inspect exactly what would be written. */
export function createLogger(level: string, destination?: DestinationStream) {
  return pino(
    {
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
    },
    destination,
  );
}

export type Logger = ReturnType<typeof createLogger>;
