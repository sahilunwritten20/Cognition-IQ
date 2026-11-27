import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CSRF, startTestApp } from './helpers';

const failedLogin = (app: Parameters<typeof request>[0], i: number) => request(app).post('/api/v1/auth/login').set(CSRF).send({ loginId: `nobody${i}x`, password: 'Wrong-Password-1' });

describe('load-test mode lifts ONLY the per-IP limits', () => {
  it('by default one IP is limited to 300 login attempts per 15 minutes', async () => {
    const ctx = await startTestApp();
    try {
      for (let i = 0; i < 300; i++) expect((await failedLogin(ctx.app, i)).status).toBe(401);
      expect((await failedLogin(ctx.app, 300)).status).toBe(429);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it('with loadTestMode the same traffic is not blocked by IP, but a single account is still locked after 10 failures', async () => {
    const ctx = await startTestApp({ cfg: { loadTestMode: true } });
    try {
      for (let i = 0; i < 310; i++) expect((await failedLogin(ctx.app, i)).status, `attempt ${i}`).toBe(401);
      const sameAccount = (n: number) => request(ctx.app).post('/api/v1/auth/login').set(CSRF).send({ loginId: 'target.account', password: `Wrong-Password-${n}` });
      for (let i = 0; i < 10; i++) expect((await sameAccount(i)).status).toBe(401);
      expect((await sameAccount(11)).status).toBe(429); // the per-account limit is untouched
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
