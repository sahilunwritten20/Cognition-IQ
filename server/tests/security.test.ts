import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { asyncHandler } from '../src/common/http';
import { createLogger } from '../src/common/logger';
import { AcademicYear, Department } from '../src/modules/academics/academics.models';
import { bearer, CSRF, CLIENT_ORIGIN, makeUser, startTestApp, tokenFor, type TestCtx } from './helpers';

let ctx: TestCtx;
const ZERO = '0'.repeat(24);

// ---------------------------------------------------------------- route inventory (read from the real Express app)
interface Layer {
  name: string;
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}
interface RouteInfo { method: string; path: string; key: string }

/** Every route the application really serves, discovered from the router tables, so a route added later is covered automatically. */
function listRoutes(app: unknown): RouteInfo[] {
  const root = (app as { _router: { stack: Layer[] } })._router.stack;
  const found = new Map<string, RouteInfo>();
  const mountPath = (re: RegExp) => re.source.replace('^\\/?(?=\\/|$)', '').replace('\\/?(?=\\/|$)', '').replace(/^\^/, '').replace(/\\\//g, '/');
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          if (!layer.route.methods[m] || m.startsWith('_')) continue;
          const method = m.toUpperCase();
          // A router mounted at /audit with get('/') reports "/api/v1/audit/": the trailing slash is the same route.
          let path = prefix + layer.route.path;
          if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
          found.set(`${method} ${path}`, { method, path, key: `${method} ${path}` });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer.regexp));
      }
    }
  };
  walk(root, '');
  return [...found.values()];
}

const PUBLIC_INFRA = ['GET /health', 'GET /ready'];
const PUBLIC_AUTH = ['POST /api/v1/auth/register', 'POST /api/v1/auth/login', 'POST /api/v1/auth/2fa/verify', 'POST /api/v1/auth/refresh', 'POST /api/v1/auth/logout'];
const isPublic = (r: RouteInfo) => PUBLIC_INFRA.includes(r.key) || PUBLIC_AUTH.includes(r.key);
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, ZERO);
const startsWithAny = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

async function hit(r: RouteInfo, token?: string): Promise<number> {
  const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let req = request(ctx.app)[method](concrete(r.path));
  if (token) req = req.set(bearer(token));
  const res = ['get', 'delete'].includes(method) ? await req : await req.send({});
  return res.status;
}
/** Runs every route in `routes` and returns the ones whose status is NOT acceptable (empty = pass). */
async function offenders(routes: RouteInfo[], token: string | undefined, acceptable: (status: number) => boolean): Promise<string[]> {
  const bad: string[] = [];
  for (const r of routes) {
    const status = await hit(r, token);
    if (!acceptable(status)) bad.push(`${r.key} -> ${status}`);
  }
  return bad;
}

let routes: RouteInfo[];
const tokens = {} as { student: string; teacher: string; hod: string; admin: string };

beforeAll(async () => {
  ctx = await startTestApp();
  routes = listRoutes(ctx.app);
  const dept = await Department.create({ collegeId: ctx.collegeId, name: 'Science', code: 'SCI' });
  await AcademicYear.create({ collegeId: ctx.collegeId, label: 'AY-SEC', startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31'), isCurrent: false });
  tokens.student = tokenFor(ctx, (await makeUser(ctx, { role: 'STUDENT' })).user);
  tokens.teacher = tokenFor(ctx, (await makeUser(ctx, { role: 'TEACHER', departmentId: dept._id })).user);
  tokens.hod = tokenFor(ctx, (await makeUser(ctx, { role: 'HOD', twoFactorEnabled: true, departmentId: dept._id })).user);
  tokens.admin = tokenFor(ctx, (await makeUser(ctx, { role: 'SUPER_ADMIN', twoFactorEnabled: true })).user);
});
afterAll(async () => {
  await ctx.stop();
});
beforeEach(() => ctx.store.clear());

// ================================================================= DENY BY DEFAULT
describe('deny by default: every route is protected, discovered from the real router tables', () => {
  it('finds the whole API (so the sweeps below cannot pass vacuously)', () => {
    expect(routes.length).toBeGreaterThan(90); // about 97 today
    for (const known of ['GET /health', 'POST /api/v1/auth/login', 'POST /api/v1/quizzes/:id/publish', 'PUT /api/v1/student/attempts/:id/answers', 'GET /api/v1/audit', 'POST /api/v1/imports/credentials/reissue']) {
      expect(routes.map((r) => r.key), known).toContain(known);
    }
    // The only routes anyone may call without signing in.
    expect(routes.filter(isPublic).map((r) => r.key).sort()).toEqual([...PUBLIC_INFRA, ...PUBLIC_AUTH].sort());
  });

  it('every non-public route answers 401 without a token', async () => {
    expect(await offenders(routes.filter((r) => !isPublic(r)), undefined, (s) => s === 401)).toEqual([]);
  });

  it('every non-public route rejects a garbage token and a wrong-scheme header with 401', async () => {
    const sample = routes.filter((r) => !isPublic(r)).slice(0, 40);
    expect(await offenders(sample, 'not.a.jwt', (s) => s === 401)).toEqual([]);
    for (const r of sample.slice(0, 10)) {
      const res = await request(ctx.app)[r.method.toLowerCase() as 'get' | 'post'](concrete(r.path)).set('Authorization', tokens.admin).send({});
      expect(res.status, r.key).toBe(401);
    }
  });

  it('the public auth routes are CSRF-protected: without the header they are refused', async () => {
    for (const key of PUBLIC_AUTH) {
      const res = await request(ctx.app).post(key.replace('POST ', '')).send({});
      expect(res.status, key).toBe(403);
      expect(res.body.error.code, key).toBe('CSRF_REJECTED');
    }
  });

  it('a STUDENT can only reach /student and /auth routes: everything else is 403', async () => {
    const others = routes.filter((r) => !isPublic(r) && !startsWithAny(r.path, ['/api/v1/student', '/api/v1/auth']));
    expect(others.length).toBeGreaterThan(70);
    expect(await offenders(others, tokens.student, (s) => s === 403)).toEqual([]);
  });

  it('a HOD is read-only: no mutating route outside /auth works', async () => {
    const writes = routes.filter((r) => !isPublic(r) && r.method !== 'GET' && !startsWithAny(r.path, ['/api/v1/auth']));
    expect(writes.length).toBeGreaterThan(50);
    expect(await offenders(writes, tokens.hod, (s) => s === 403)).toEqual([]);
  });

  it('a TEACHER cannot use admin, import, audit or student routes, nor change the college structure', async () => {
    const forbidden = routes.filter(
      (r) =>
        !isPublic(r) &&
        (startsWithAny(r.path, ['/api/v1/admin', '/api/v1/imports', '/api/v1/audit', '/api/v1/student']) || (r.method !== 'GET' && startsWithAny(r.path, ['/api/v1/academics']))),
    );
    expect(forbidden.length).toBeGreaterThan(40);
    expect(await offenders(forbidden, tokens.teacher, (s) => s === 403)).toEqual([]);
  });

  it('SUPER_ADMIN cannot take exams or run teacher-only actions (it may only extend or emergency-close)', async () => {
    const emergency = ['POST /api/v1/quizzes/:id/extend', 'POST /api/v1/quizzes/:id/emergency-close'];
    const forbidden = routes.filter(
      (r) =>
        !isPublic(r) &&
        (startsWithAny(r.path, ['/api/v1/student']) || (r.method !== 'GET' && startsWithAny(r.path, ['/api/v1/questions'])) || (r.method !== 'GET' && startsWithAny(r.path, ['/api/v1/quizzes']) && !emergency.includes(r.key))),
    );
    expect(forbidden.length).toBeGreaterThan(20);
    expect(await offenders(forbidden, tokens.admin, (s) => s === 403)).toEqual([]);
  });

  it('unknown paths are a plain 404 envelope with a request id, for every method', async () => {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const res = await request(ctx.app)[method]('/api/v1/does-not-exist').set(bearer(tokens.admin)).send({});
      expect(res.status, method).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });
});

// ================================================================= BROWSER-FACING PROTECTIONS
describe('CORS and security headers', () => {
  it('never reflects an unknown origin and never uses a wildcard', async () => {
    const evil = await request(ctx.app).options('/api/v1/quizzes').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    const allowed = evil.headers['access-control-allow-origin'];
    expect(allowed === undefined || allowed === CLIENT_ORIGIN).toBe(true); // a browser will refuse anything but the college's own client
    expect(allowed).not.toBe('*');
    expect(allowed).not.toBe('https://evil.example');

    const ok = await request(ctx.app).options('/api/v1/quizzes').set('Origin', CLIENT_ORIGIN).set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe(CLIENT_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a cross-site request cannot ride the refresh cookie (CSRF)', async () => {
    const forged = await request(ctx.app).post('/api/v1/auth/refresh').set({ Origin: 'https://evil.example', 'X-Requested-With': 'cognition-iq' }).set('Cookie', 'ciq_rt=anything');
    expect(forged.status).toBe(403);
    const noHeader = await request(ctx.app).post('/api/v1/auth/refresh').set({ Origin: CLIENT_ORIGIN }).set('Cookie', 'ciq_rt=anything');
    expect(noHeader.status).toBe(403);
  });

  it('sets the standard protective headers and hides the framework', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['referrer-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    const api = await request(ctx.app).get('/api/v1/auth/me').set(bearer(tokens.student));
    expect(api.headers['cache-control']).toBe('no-store'); // tokens, passwords and answers are never cached
  });
});

// ================================================================= WHAT THE SERVER SAYS AND WRITES
describe('errors and logs reveal nothing', () => {
  const quiet = () => createLogger('silent');
  const boomApp = createApp({
    logger: quiet(),
    clientOrigin: CLIENT_ORIGIN,
    checks: { mongo: async () => true, redis: async () => true },
    mount: (v1) => {
      v1.get('/boom', () => {
        throw new Error('secret internals: /etc/passwd password=hunter2');
      });
      v1.get('/boom-async', asyncHandler(async () => {
        throw new Error('db connection string mongodb://user:hunter2@host');
      }));
    },
  });

  it('an unexpected error becomes a generic 500 with no message, stack or file path', async () => {
    for (const path of ['/api/v1/boom', '/api/v1/boom-async']) {
      const res = await request(boomApp).get(path);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
      expect(res.body.error.requestId).toBeTruthy();
      const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
      for (const leak of ['secret internals', 'hunter2', '/etc/passwd', 'mongodb://', 'at Object', '.ts:', 'node_modules']) expect(text, leak).not.toContain(leak);
    }
  });

  it('oversized and malformed bodies are refused cleanly', async () => {
    const huge = await request(ctx.app).post('/api/v1/auth/login').set(CSRF).send({ loginId: 'abc', password: 'x'.repeat(150_000) });
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe('VALIDATION_ERROR');
    const broken = await request(ctx.app).post('/api/v1/auth/login').set(CSRF).set('Content-Type', 'application/json').send('{"loginId": ');
    expect(broken.status).toBe(400);
  });

  it('log output never contains credentials, tokens, cookies, hashes or answer keys', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (s: string) => void lines.push(s) });
    logger.info(
      {
        req: { headers: { authorization: 'Bearer SECRET-BEARER', cookie: 'ciq_rt=SECRET-COOKIE' } },
        user: { password: 'SECRET-PASSWORD', passwordHash: '$argon2id$SECRET-HASH', token: 'SECRET-TOKEN', refreshToken: 'SECRET-REFRESH', correctOptionId: 'SECRET-KEY' },
      },
      'direct log line',
    );
    const out = lines.join('');
    expect(out).toContain('direct log line'); // something was written...
    expect(out).toContain('[redacted]');
    for (const secret of ['SECRET-BEARER', 'SECRET-COOKIE', 'SECRET-PASSWORD', 'SECRET-HASH', 'SECRET-TOKEN', 'SECRET-REFRESH', 'SECRET-KEY']) expect(out, secret).not.toContain(secret);
  });

  it('the request logger redacts the Authorization header and cookies of a real request', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (s: string) => void lines.push(s) });
    const app = createApp({ logger, clientOrigin: CLIENT_ORIGIN, checks: { mongo: async () => true, redis: async () => true } });
    await request(app).get('/api/v1/nothing-here').set('Authorization', 'Bearer SECRET-LIVE-TOKEN').set('Cookie', 'ciq_rt=SECRET-LIVE-COOKIE');
    const out = lines.join('');
    expect(out).toContain('"statusCode":404'); // the request WAS logged
    expect(out).not.toContain('SECRET-LIVE-TOKEN');
    expect(out).not.toContain('SECRET-LIVE-COOKIE');
  });
});

// ================================================================= ABUSE LIMITS
describe('abuse limits', () => {
  it('limits public registrations per address (100 per hour)', async () => {
    const register = (i: number) => request(ctx.app).post('/api/v1/auth/register').set(CSRF).send({ name: 'Reg User', loginId: `reg${i}x`, password: 'Long-Enough-Pass1' });
    for (let i = 0; i < 100; i++) expect((await register(i)).status, `registration ${i}`).toBe(202);
    const blocked = await register(100);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
