import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createLogger } from '../src/common/logger';

const build = (mongo: boolean, redis: boolean) =>
  createApp({
    logger: createLogger('silent'),
    clientOrigin: 'http://localhost:5173',
    checks: { mongo: async () => mongo, redis: async () => redis },
  });

describe('infrastructure endpoints', () => {
  it('GET /health returns ok', async () => {
    const res = await request(build(true, true)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready is 200 when mongo is up', async () => {
    const res = await request(build(true, true)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('GET /ready stays 200 but degraded when only redis is down (T-05)', async () => {
    const res = await request(build(true, false)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  it('GET /ready is 503 when mongo is down', async () => {
    const res = await request(build(false, true)).get('/ready');
    expect(res.status).toBe(503);
  });
});

describe('error envelope', () => {
  it('returns the stable envelope with a request id for unknown routes', async () => {
    const res = await request(build(true, true)).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at \w+/i);
  });

  it('returns a 400 envelope for malformed JSON', async () => {
    const res = await request(build(true, true))
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(build(true, true)).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
