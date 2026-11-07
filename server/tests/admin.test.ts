import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { User } from '../src/modules/users/user.model';
import { bearer, CSRF, makeUser, refreshCookie, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
let adminToken: string;
let adminId: string;

beforeAll(async () => {
  ctx = await startTestApp();
  const { user } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true, loginId: 'rootadmin' });
  adminToken = tokenFor(ctx, user);
  adminId = user.id;
});
afterAll(async () => {
  await ctx.stop();
});
beforeEach(() => ctx.store.clear());

const as = bearer;
const post = (path: string, body?: object) => request(ctx.app).post(`/api/v1/admin${path}`).set(as(adminToken)).send(body);
const login = (loginId: string, password: string) => request(ctx.app).post('/api/v1/auth/login').set(CSRF).send({ loginId, password });

describe('registration approvals', () => {
  it('lists pending registrations, approves one, and the student can then log in', async () => {
    const { user, password } = await makeUser(ctx, { status: 'pending', loginId: 'newstudent' });
    const list = await request(ctx.app).get('/api/v1/admin/users?status=pending').set(as(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.items.some((u: { id: string }) => u.id === user.id)).toBe(true);

    expect((await login('newstudent', password)).status).toBe(401);
    const approved = await post(`/users/${user.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.user.status).toBe('active');
    expect((await login('newstudent', password)).status).toBe(200);

    const audit = await AuditLog.findOne({ action: 'admin.user_approved', targetId: user.id });
    expect(audit?.actorId?.toString()).toBe(adminId);
  });

  it('approving twice conflicts (state-checked atomically)', async () => {
    const { user } = await makeUser(ctx, { status: 'pending' });
    expect((await post(`/users/${user.id}/approve`)).status).toBe(200);
    expect((await post(`/users/${user.id}/approve`)).status).toBe(409);
  });

  it('rejecting keeps the account inactive and records the reason', async () => {
    const { user, password } = await makeUser(ctx, { status: 'pending', loginId: 'rejectme' });
    const res = await post(`/users/${user.id}/reject`, { reason: 'Not in roster' });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('inactive');
    expect((await login('rejectme', password)).status).toBe(401);
    const audit = await AuditLog.findOne({ action: 'admin.user_rejected', targetId: user.id });
    expect(audit?.summary?.reason).toBe('Not in roster');
  });
});

describe('creating users and temporary passwords', () => {
  it('returns a one-time temporary password, forces a change, and never audits the password', async () => {
    const res = await post('/users', { name: 'Ravi Kulkarni', loginId: 'Ravi.K', role: 'TEACHER' });
    expect(res.status).toBe(201);
    const temp: string = res.body.temporaryPassword;
    expect(temp).toHaveLength(12);
    expect(res.body.user.loginId).toBe('ravi.k');
    expect(res.body.user.mustChangePassword).toBe(true);

    const lg = await login('ravi.k', temp);
    expect(lg.status).toBe(200);
    expect(lg.body.pendingActions).toEqual(['change_password']);

    const audits = await AuditLog.find({ targetId: res.body.user.id }).lean();
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(temp);
  });

  it('rejects unknown fields, invalid roles and reused login IDs', async () => {
    expect((await post('/users', { name: 'Bad Role', loginId: 'badrole', role: 'GOD' })).status).toBe(400);
    expect((await post('/users', { name: 'Extra Field', loginId: 'extra', role: 'STUDENT', status: 'active' })).status).toBe(400);
    expect((await post('/users', { name: 'Dup One', loginId: 'dupuser', role: 'STUDENT' })).status).toBe(201);
    expect((await post('/users', { name: 'Dup Two', loginId: 'dupuser', role: 'STUDENT' })).status).toBe(409);
  });
});

describe('password reset and deactivation revoke sessions', () => {
  it('reset-password signs the user out everywhere and forces a new change', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'resetme' });
    const lg = await login('resetme', password);
    const cookie = refreshCookie(lg);
    const oldToken: string = lg.body.accessToken;

    const res = await post(`/users/${user.id}/reset-password`);
    expect(res.status).toBe(200);
    const temp: string = res.body.temporaryPassword;

    expect((await login('resetme', password)).status).toBe(401);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(as(oldToken))).status).toBe(401);
    expect((await request(ctx.app).post('/api/v1/auth/refresh').set(CSRF).set('Cookie', cookie)).status).toBe(401);
    const again = await login('resetme', temp);
    expect(again.status).toBe(200);
    expect(again.body.pendingActions).toEqual(['change_password']);
    expect(JSON.stringify(await AuditLog.find({ action: 'admin.password_reset' }).lean())).not.toContain(temp);
  });

  it('deactivate kills existing access and refresh tokens at once; activate restores login', async () => {
    const { user, password } = await makeUser(ctx, { loginId: 'deactme' });
    const lg = await login('deactme', password);
    const cookie = refreshCookie(lg);
    expect((await post(`/users/${user.id}/deactivate`, { reason: 'Left college' })).status).toBe(200);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(as(lg.body.accessToken))).status).toBe(401);
    expect((await request(ctx.app).post('/api/v1/auth/refresh').set(CSRF).set('Cookie', cookie)).status).toBe(401);
    expect((await login('deactme', password)).status).toBe(401);
    expect((await post(`/users/${user.id}/activate`)).status).toBe(200);
    expect((await login('deactme', password)).status).toBe(200);
  });

  it('admins cannot act on themselves (no self lock-out or silent self-change)', async () => {
    expect((await post(`/users/${adminId}/deactivate`)).status).toBe(403);
    expect((await post(`/users/${adminId}/reset-password`)).status).toBe(403);
    expect((await post(`/users/${adminId}/reset-2fa`, { reason: 'testing self' })).status).toBe(403);
  });

  it("cannot reach another college's users", async () => {
    const foreign = await User.create({
      collegeId: '1'.repeat(24),
      name: 'Other College',
      loginId: 'foreign',
      passwordHash: await ctx.modules.passwords.hash('Correct-Horse-9'),
      role: 'STUDENT',
      status: 'pending',
    });
    expect((await post(`/users/${foreign.id}/approve`)).status).toBe(404);
    const list = await request(ctx.app).get('/api/v1/admin/users?pageSize=100').set(as(adminToken));
    expect(list.body.items.some((u: { loginId: string }) => u.loginId === 'foreign')).toBe(false);
  });
});

describe('listing', () => {
  it('bounds page size and rejects unknown query fields', async () => {
    expect((await request(ctx.app).get('/api/v1/admin/users?pageSize=101').set(as(adminToken))).status).toBe(400);
    expect((await request(ctx.app).get('/api/v1/admin/users?pageSize=0').set(as(adminToken))).status).toBe(400);
    expect((await request(ctx.app).get('/api/v1/admin/users?role[$ne]=STUDENT').set(as(adminToken))).status).toBe(400);
    const ok = await request(ctx.app).get('/api/v1/admin/users').set(as(adminToken));
    expect(ok.body.pageSize).toBe(25);
  });
});

describe('SUPER_ADMIN recovery (two-admin model)', () => {
  it('a second SUPER_ADMIN can be created; it must change its password and enrol 2FA before doing anything', async () => {
    const res = await post('/users', { name: 'Backup Admin', loginId: 'backupadmin', role: 'SUPER_ADMIN' });
    expect(res.status).toBe(201);
    const lg = await login('backupadmin', res.body.temporaryPassword);
    expect(lg.status).toBe(200);
    expect(lg.body.pendingActions).toEqual(['change_password', 'setup_2fa']);
    const blocked = await request(ctx.app).get('/api/v1/admin/users').set(as(lg.body.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACTION_REQUIRED');
    const audit = await AuditLog.findOne({ action: 'admin.user_created', targetId: res.body.user.id });
    expect(audit?.summary?.role).toBe('SUPER_ADMIN');
  });

  it("one admin can reset another admin's lost authenticator: reason required, audited, forces re-enrolment", async () => {
    const { user: locked, password } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true, loginId: 'lockedadmin' });
    await User.updateOne({ _id: locked._id }, { $set: { 'twoFactor.secretEnc': 'x' } });
    const oldToken = tokenFor(ctx, locked);

    expect((await post(`/users/${locked.id}/reset-2fa`, {})).status).toBe(400); // reason is mandatory
    const res = await post(`/users/${locked.id}/reset-2fa`, { reason: 'Phone lost' });
    expect(res.status).toBe(200);
    expect(res.body.user.twoFactorEnabled).toBe(false);

    expect((await request(ctx.app).get('/api/v1/auth/me').set(as(oldToken))).status).toBe(401);
    const lg = await login('lockedadmin', password);
    expect(lg.status).toBe(200);
    expect(lg.body.twoFactorRequired).toBeUndefined();
    expect(lg.body.pendingActions).toEqual(['setup_2fa']);

    const stored = await User.findById(locked._id).select('+twoFactor.secretEnc');
    expect(stored?.twoFactor.secretEnc).toBeUndefined();
    const audit = await AuditLog.findOne({ action: 'admin.2fa_reset', targetId: locked.id });
    expect(audit?.actorId?.toString()).toBe(adminId);
    expect(audit?.summary?.reason).toBe('Phone lost');
  });

  it('can reset a HOD authenticator and reset another admin password, but not across colleges', async () => {
    const { user: hod } = await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true });
    expect((await post(`/users/${hod.id}/reset-2fa`, { reason: 'Device replaced' })).status).toBe(200);

    const { user: other, password } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const reset = await post(`/users/${other.id}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await login(other.loginId, password)).status).toBe(401);

    const foreign = await User.create({
      collegeId: '2'.repeat(24),
      name: 'Other College Admin',
      loginId: 'foreignadmin',
      passwordHash: await ctx.modules.passwords.hash('Correct-Horse-9'),
      role: 'SUPER_ADMIN',
      status: 'active',
    });
    expect((await post(`/users/${foreign.id}/reset-2fa`, { reason: 'cross-college attempt' })).status).toBe(404);
  });

  it('can deactivate another admin, which ends their access immediately', async () => {
    const { user: other } = await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true });
    const token = tokenFor(ctx, other);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(as(token))).status).toBe(200);
    expect((await post(`/users/${other.id}/deactivate`, { reason: 'Compromised' })).status).toBe(200);
    expect((await request(ctx.app).get('/api/v1/auth/me').set(as(token))).status).toBe(401);
  });
});
