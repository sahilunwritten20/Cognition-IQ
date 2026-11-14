import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

const valid = {
  NODE_ENV: 'test',
  CLIENT_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://localhost:27017/x',
  REDIS_URL: 'redis://localhost:6379',
  COLLEGE_ID: 'a'.repeat(24),
  ACCESS_TOKEN_SECRET: 'a'.repeat(32),
  REFRESH_TOKEN_SECRET: 'b'.repeat(32),
  TWO_FACTOR_ENCRYPTION_KEY: 'c'.repeat(64),
};

describe('parseEnv', () => {
  it('accepts a valid config and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.ACCESS_TOKEN_TTL).toBe('15m');
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7);
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

  it('requires an https client origin outside development', () => {
    const prod = { ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'true' };
    expect(() => parseEnv({ ...prod, CLIENT_ORIGIN: 'http://app.college.edu' })).toThrow(/CLIENT_ORIGIN/);
    expect(() => parseEnv({ ...prod, CLIENT_ORIGIN: 'https://app.college.edu' })).not.toThrow();
  });

  it('defaults the import worker to inline and retention to 30 days, and validates both', () => {
    const env = parseEnv(valid);
    expect(env.IMPORT_WORKER).toBe('inline');
    expect(env.IMPORT_RETENTION_DAYS).toBe(30);
    expect(parseEnv({ ...valid, IMPORT_WORKER: 'off', IMPORT_RETENTION_DAYS: '90' })).toMatchObject({ IMPORT_WORKER: 'off', IMPORT_RETENTION_DAYS: 90 });
    expect(() => parseEnv({ ...valid, IMPORT_WORKER: 'maybe' })).toThrow(/IMPORT_WORKER/);
    expect(() => parseEnv({ ...valid, IMPORT_RETENTION_DAYS: '0' })).toThrow(/IMPORT_RETENTION_DAYS/);
  });

  it('defaults the exam grace to 15 s and the sweeper to inline, and validates both', () => {
    const env = parseEnv(valid);
    expect(env.EXAM_GRACE_SECONDS).toBe(15);
    expect(env.SWEEPER).toBe('inline');
    expect(parseEnv({ ...valid, EXAM_GRACE_SECONDS: '0', SWEEPER: 'off' })).toMatchObject({ EXAM_GRACE_SECONDS: 0, SWEEPER: 'off' });
    expect(() => parseEnv({ ...valid, EXAM_GRACE_SECONDS: '-1' })).toThrow(/EXAM_GRACE_SECONDS/);
    expect(() => parseEnv({ ...valid, EXAM_GRACE_SECONDS: '121' })).toThrow(/EXAM_GRACE_SECONDS/);
    expect(() => parseEnv({ ...valid, SWEEPER: 'sometimes' })).toThrow(/SWEEPER/);
  });

  it('defaults the display time zone to Asia/Kolkata and rejects an unknown one', () => {
    expect(parseEnv(valid).DISPLAY_TIMEZONE).toBe('Asia/Kolkata');
    expect(parseEnv({ ...valid, DISPLAY_TIMEZONE: 'UTC' }).DISPLAY_TIMEZONE).toBe('UTC');
    expect(() => parseEnv({ ...valid, DISPLAY_TIMEZONE: 'Mars/Olympus' })).toThrow(/DISPLAY_TIMEZONE/);
  });

  it('rejects a malformed college id and 2FA key', () => {
    expect(() => parseEnv({ ...valid, COLLEGE_ID: 'nope' })).toThrow(/COLLEGE_ID/);
    expect(() => parseEnv({ ...valid, TWO_FACTOR_ENCRYPTION_KEY: 'short' })).toThrow(/TWO_FACTOR_ENCRYPTION_KEY/);
  });

  it('does not echo secret values in errors', () => {
    try {
      parseEnv({ ...valid, ACCESS_TOKEN_SECRET: 'supersecret' });
    } catch (e) {
      expect(String(e)).not.toContain('supersecret');
    }
  });
});
