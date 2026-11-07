import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, User, type Role } from '../src/modules/users/user.model';
import { bearer, collectKeys, FORBIDDEN_KEYS, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});

const SOME_ID = '0'.repeat(24);

interface Endpoint {
  method: 'get' | 'post';
  path: string;
  body?: object;
  allowed: Role[];
}
// Allow/deny matrix for every endpoint that exists so far (guide Section 11). Extend with each step.
const ENDPOINTS: Endpoint[] = [
  { method: 'get', path: '/api/v1/auth/me', allowed: [...ROLES] },
  { method: 'get', path: '/api/v1/admin/users', allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: '/api/v1/admin/users', body: { name: 'New Teacher', loginId: 'newteacher', role: 'TEACHER' }, allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: `/api/v1/admin/users/${SOME_ID}/approve`, allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: `/api/v1/admin/users/${SOME_ID}/reject`, allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: `/api/v1/admin/users/${SOME_ID}/deactivate`, allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: `/api/v1/admin/users/${SOME_ID}/activate`, allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: `/api/v1/admin/users/${SOME_ID}/reset-password`, allowed: ['SUPER_ADMIN'] },
  { method: 'post', path: `/api/v1/admin/users/${SOME_ID}/reset-2fa`, body: { reason: 'lost phone' }, allowed: ['SUPER_ADMIN'] },
];

describe('permission matrix', () => {
  for (const ep of ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} ${ep.path.replace(SOME_ID, ':id')}`, () => {
      it('401 without a token', async () => {
        const res = await request(ctx.app)[ep.method](ep.path).send(ep.body);
        expect(res.status).toBe(401);
      });

      for (const role of ROLES) {
        const allowed = ep.allowed.includes(role);
        it(`${role}: ${allowed ? 'allowed' : '403'}`, async () => {
          const { user } = await makeUser(ctx, { role, twoFactorEnabled: role === 'SUPER_ADMIN' || role === 'HOD' });
          const res = await request(ctx.app)[ep.method](ep.path).set(bearer(tokenFor(ctx, user))).send(ep.body);
          if (allowed) expect([401, 403]).not.toContain(res.status);
          else expect(res.status).toBe(403);
        });
      }
    });
  }
});

describe('token and account-state enforcement', () => {
  it('rejects tokens for pending, inactive and soft-deleted accounts immediately', async () => {
    for (const status of ['pending', 'inactive'] as const) {
      const { user } = await makeUser(ctx, { status });
      const res = await request(ctx.app).get('/api/v1/auth/me').set(bearer(tokenFor(ctx, user)));
      expect(res.status).toBe(401);
    }
    const { user } = await makeUser(ctx);
    const token = tokenFor(ctx, user);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(200);
    await User.updateOne({ _id: user._id }, { $set: { deletedAt: new Date() } });
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('rejects a stale token version, another college, garbage and a missing scheme', async () => {
    const { user } = await makeUser(ctx);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(tokenFor(ctx, user, { tv: 99 })))).status).toBe(401);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(tokenFor(ctx, user, { cid: SOME_ID })))).status).toBe(401);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer('not.a.jwt'))).status).toBe(401);
    expect((await request(ctx.app).get('/api/v1/auth/me').set({ Authorization: tokenFor(ctx, user) })).status).toBe(401);
  });

  it('role always comes from the database, not from the token or client', async () => {
    const { user } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const token = tokenFor(ctx, user);
    expect((await request(ctx.app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(200);
    await User.updateOne({ _id: user._id }, { $set: { role: 'TEACHER' } }); // demoted
    expect((await request(ctx.app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(403);
  });
});

describe('mandatory 2FA roles (SUPER_ADMIN and HOD)', () => {
  for (const role of ['SUPER_ADMIN', 'HOD'] as const) {
    it(`${role} without 2FA can only reach setup endpoints`, async () => {
      const { user } = await makeUser(ctx, { role });
      const token = bearer(tokenFor(ctx, user));
      const me = await request(ctx.app).get('/api/v1/auth/me').set(token);
      expect(me.status).toBe(200);
      expect(me.body.pendingActions).toEqual(['setup_2fa']);
      const blocked = await request(ctx.app).get('/api/v1/admin/users').set(token);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('ACTION_REQUIRED');
      expect((await request(ctx.app).post('/api/v1/auth/2fa/setup').set(token)).status).toBe(200);
    });
  }

  for (const role of ['TEACHER', 'STUDENT'] as const) {
    it(`${role} is not required to use 2FA`, async () => {
      const { user } = await makeUser(ctx, { role });
      const me = await request(ctx.app).get('/api/v1/auth/me').set(bearer(tokenFor(ctx, user)));
      expect(me.body.pendingActions).toEqual([]);
    });
  }
});

describe('response allow-lists', () => {
  it('never exposes hashes, secrets or token internals on any response', async () => {
    const { user: admin } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const t = bearer(tokenFor(ctx, admin));
    const me = await request(ctx.app).get('/api/v1/auth/me').set(t);
    const list = await request(ctx.app).get('/api/v1/admin/users').set(t);
    const created = await request(ctx.app).post('/api/v1/admin/users').set(t).send({ name: 'Leak Check', loginId: 'leakcheck', role: 'STUDENT' });
    const denied = await request(ctx.app).get('/api/v1/admin/users').set(bearer('bad'));
    for (const res of [me, list, created, denied]) {
      const keys = collectKeys(res.body);
      for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${k} leaked`).toBe(false);
    }
  });
});
