import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totpCode } from '../src/common/totp';
import { RefreshSession } from '../src/modules/auth/session.model';
import { User } from '../src/modules/users/user.model';
import { bearer, collectKeys, CSRF, FORBIDDEN_KEYS, makeUser, refreshCookie, type TestCtx, startTestApp } from './helpers';

const A = '/api/v1/auth';
let ctx: TestCtx;

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.stop();
});
beforeEach(() => ctx.store.clear());

const login = (loginId: string, password: string) =>
  request(ctx.app).post(`${A}/login`).set(CSRF).send({ loginId, password });

describe('registration', () => {
  const body = { name: 'Asha Patil', loginId: 'Asha.Patil', password: 'Long-Enough-Pass1' };

  it('creates a pending STUDENT and never reveals whether the ID already existed', async () => {
    const first = await request(ctx.app).post(`${A}/register`).set(CSRF).send(body);
    const second = await request(ctx.app).post(`${A}/register`).set(CSRF).send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    const users = await User.find({ loginId: 'asha.patil' });
    expect(users).toHaveLength(1);
    expect(users[0]?.status).toBe('pending');
    expect(users[0]?.role).toBe('STUDENT');
  });

  it('rejects a client-supplied role (no privilege escalation)', async () => {
    const res = await request(ctx.app)
      .post(`${A}/register`)
      .set(CSRF)
      .send({ ...body, loginId: 'sneaky', role: 'SUPER_ADMIN' });
    expect(res.status).toBe(400);
    expect(await User.countDocuments({ loginId: 'sneaky' })).toBe(0);
  });

  it('rejects NoSQL operator objects and weak passwords', async () => {
    const op = await request(ctx.app).post(`${A}/login`).set(CSRF).send({ loginId: { $ne: '' }, password: { $ne: '' } });
    expect(op.status).toBe(400);
    const weak = await request(ctx.app).post(`${A}/register`).set(CSRF).send({ ...body, loginId: 'weakpw', password: 'short' });
    expect(weak.status).toBe(400);
  });

  it('a pending account cannot log in', async () => {
    await makeUser(ctx, { loginId: 'pendinguser', status: 'pending', password: 'Correct-Horse-9' });
    const res = await login('pendinguser', 'Correct-Horse-9');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    // The same message is used for every failure, and it explains the pending-approval case.
    expect(res.body.error.message).toMatch(/awaiting administrator approval/i);
  });
});

describe('login', () => {
  it('returns an access token, sets an HttpOnly SameSite=Strict cookie, and leaks no secrets', async () => {
    const { password } = await makeUser(ctx, { loginId: 'stud1' });
    const res = await login('STUD1', password); // case-insensitive IDs
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.expiresIn).toBe(900);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(res.headers['cache-control']).toBe('no-store');
    const keys = collectKeys(res.body);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
  });

  it('gives the same error for unknown user and wrong password', async () => {
    const { user } = await makeUser(ctx, { loginId: 'stud2' });
    const wrong = await login(user.loginId, 'Wrong-Password-1');
    const unknown = await login('nobody-here', 'Wrong-Password-1');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('locks the account after 10 failures, even for the correct password', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'stud3' });
    for (let i = 0; i < 10; i++) expect((await login(user.loginId, 'Wrong-Password-1')).status).toBe(401);
    expect((await login(user.loginId, password)).status).toBe(429);
  });

  it('rejects requests without the CSRF header or from another origin', async () => {
    const noHeader = await request(ctx.app).post(`${A}/login`).send({ loginId: 'abc', password: 'x' });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF_REJECTED');
    const badOrigin = await request(ctx.app)
      .post(`${A}/login`)
      .set({ 'X-Requested-With': 'cognition-iq', Origin: 'https://evil.example' })
      .send({ loginId: 'abc', password: 'x' });
    expect(badOrigin.status).toBe(403);
  });
});

describe('refresh tokens', () => {
  it('rotates, tolerates a near-simultaneous retry, and kills the family on later reuse', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'stud4' });
    const c1 = refreshCookie(await login(user.loginId, password));

    const r1 = await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', c1);
    expect(r1.status).toBe(200);
    const c2 = refreshCookie(r1);
    expect(c2).not.toBe(c1);

    // Immediate reuse = two tabs racing: 409, and the new session survives.
    const race = await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', c1);
    expect(race.status).toBe(409);

    // Age the rotation past the grace window, then replay the old token = theft signal.
    await RefreshSession.updateMany({ revokeReason: 'rotated' }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    const reuse = await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', c1);
    expect(reuse.status).toBe(401);

    // The whole chain is now revoked, including the legitimate newest token.
    const dead = await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', c2);
    expect(dead.status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'stud5' });
    const c = refreshCookie(await login(user.loginId, password));
    expect((await request(ctx.app).post(`${A}/logout`).set(CSRF).set('Cookie', c)).status).toBe(204);
    expect((await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', c)).status).toBe(401);
  });

  it('refresh without a cookie is 401', async () => {
    expect((await request(ctx.app).post(`${A}/refresh`).set(CSRF)).status).toBe(401);
  });

  it('a deactivated user cannot refresh', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'stud6' });
    const c = refreshCookie(await login(user.loginId, password));
    await User.updateOne({ _id: user._id }, { $set: { status: 'inactive' } });
    expect((await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', c)).status).toBe(401);
  });
});

describe('forced password change', () => {
  it('blocks everything else until changed, then invalidates all old tokens', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'stud7', mustChangePassword: true });
    const res = await login(user.loginId, password);
    expect(res.body.pendingActions).toEqual(['change_password']);
    const oldToken: string = res.body.accessToken;
    const oldCookie = refreshCookie(res);

    expect((await request(ctx.app).get(`${A}/me`).set(bearer(oldToken))).status).toBe(200); // allowed while pending

    const wrong = await request(ctx.app).post(`${A}/change-password`).set(bearer(oldToken)).send({ currentPassword: 'nope-nope-1', newPassword: 'Brand-New-Pass-1' });
    expect(wrong.status).toBe(401);
    const same = await request(ctx.app).post(`${A}/change-password`).set(bearer(oldToken)).send({ currentPassword: password, newPassword: password });
    expect(same.status).toBe(400);

    const ok = await request(ctx.app).post(`${A}/change-password`).set(bearer(oldToken)).send({ currentPassword: password, newPassword: 'Brand-New-Pass-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.pendingActions).toEqual([]);

    expect((await request(ctx.app).get(`${A}/me`).set(bearer(oldToken))).status).toBe(401); // old access token dead
    expect((await request(ctx.app).post(`${A}/refresh`).set(CSRF).set('Cookie', oldCookie)).status).toBe(401); // old session dead
    expect((await request(ctx.app).get(`${A}/me`).set(bearer(ok.body.accessToken))).status).toBe(200);
    expect((await login(user.loginId, 'Brand-New-Pass-1')).status).toBe(200);
  });
});

describe('SUPER_ADMIN two-factor authentication', () => {
  it('forces enrolment, then requires a fresh, non-replayed code at every login', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'admin1', role: 'SUPER_ADMIN' });

    // Without 2FA the admin can sign in but cannot use any admin endpoint.
    const first = await login(user.loginId, password);
    expect(first.status).toBe(200);
    expect(first.body.pendingActions).toEqual(['setup_2fa']);
    const token: string = first.body.accessToken;
    const blocked = await request(ctx.app).get('/api/v1/admin/users').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACTION_REQUIRED');

    // Enrol.
    const setup = await request(ctx.app).post(`${A}/2fa/setup`).set(bearer(token));
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret: string = setup.body.secret;
    const bad = await request(ctx.app).post(`${A}/2fa/enable`).set(bearer(token)).send({ code: '000000' });
    expect(bad.status).toBe(401);
    const enable = await request(ctx.app).post(`${A}/2fa/enable`).set(bearer(token)).send({ code: totpCode(secret, ctx.clock.now) });
    expect(enable.status).toBe(204);
    expect((await request(ctx.app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(200);

    // The stored secret is encrypted at rest.
    const stored = await User.findById(user._id).select('+twoFactor.secretEnc');
    expect(stored?.twoFactor.secretEnc).toBeDefined();
    expect(stored?.twoFactor.secretEnc).not.toContain(secret);

    // Next login needs the second factor and issues no tokens before it.
    const step1 = await login(user.loginId, password);
    expect(step1.body.twoFactorRequired).toBe(true);
    expect(step1.body.accessToken).toBeUndefined();
    const challengeToken: string = step1.body.challengeToken;

    // Replaying the code used at enrolment (same time step) is rejected.
    const replay = await request(ctx.app).post(`${A}/2fa/verify`).set(CSRF).send({ challengeToken, code: totpCode(secret, ctx.clock.now) });
    expect(replay.status).toBe(401);

    // A fresh code from the next step succeeds exactly once.
    ctx.clock.now += 30_000;
    const code = totpCode(secret, ctx.clock.now);
    const ok = await request(ctx.app).post(`${A}/2fa/verify`).set(CSRF).send({ challengeToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.pendingActions).toEqual([]);
    const again = await request(ctx.app).post(`${A}/2fa/verify`).set(CSRF).send({ challengeToken, code });
    expect(again.status).toBe(401);
  });

  it('a challenge token cannot be used as an access token', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'admin2', role: 'SUPER_ADMIN', twoFactorEnabled: true });
    await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.secretEnc': 'x' } });
    const step1 = await login(user.loginId, password);
    const res = await request(ctx.app).get(`${A}/me`).set(bearer(step1.body.challengeToken));
    expect(res.status).toBe(401);
  });
});
