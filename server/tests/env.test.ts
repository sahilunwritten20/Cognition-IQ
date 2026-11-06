import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

const valid = {
  NODE_ENV: 'test',
  CLIENT_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://localhost:27017/x',
  REDIS_URL: 'redis://localhost:6379',
  ACCESS_TOKEN_SECRET: 'a'.repeat(32),
  REFRESH_TOKEN_SECRET: 'b'.repeat(32),
};

describe('parseEnv', () => {
  it('accepts a valid config and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.ACCESS_TOKEN_TTL).toBe('15m');
  });

  it('rejects short secrets', () => {
    expect(() => parseEnv({ ...valid, ACCESS_TOKEN_SECRET: 'short' })).toThrow(/ACCESS_TOKEN_SECRET/);
  });

  it('rejects identical token secrets', () => {
    expect(() => parseEnv({ ...valid, REFRESH_TOKEN_SECRET: valid.ACCESS_TOKEN_SECRET })).toThrow(/differ/);
  });

  it('requires secure cookies in production', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  it('does not echo secret values in errors', () => {
    try {
      parseEnv({ ...valid, ACCESS_TOKEN_SECRET: 'supersecret' });
    } catch (e) {
      expect(String(e)).not.toContain('supersecret');
    }
  });
});
