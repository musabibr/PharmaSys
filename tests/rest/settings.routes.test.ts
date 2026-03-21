import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/settings ────────────────────────────────────────────────────

describe('GET /api/v1/settings', () => {
  it('returns all settings', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/settings')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('allows pharmacist (requireAuth only)', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .get('/api/v1/settings')
      .expect(200);
  });

  it('allows cashier (requireAuth only)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/settings')
      .expect(200);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/settings').expect(401);
  });
});

// ─── GET /api/v1/settings/:key ───────────────────────────────────────────────

describe('GET /api/v1/settings/:key', () => {
  it('returns setting by key', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/settings/business_name')
      .expect(200);

    expect(res.body.data).toHaveProperty('key', 'business_name');
    expect(res.body.data).toHaveProperty('value');
  });

  it('returns null value for unknown key', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/settings/nonexistent_key')
      .expect(200);

    expect(res.body.data).toHaveProperty('key', 'nonexistent_key');
    expect(res.body.data.value).toBeNull();
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/settings/test_key').expect(401);
  });
});

// ─── PUT /api/v1/settings/:key ───────────────────────────────────────────────

describe('PUT /api/v1/settings/:key', () => {
  it('admin sets setting value', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .put('/api/v1/settings/business_name')
      .send({ value: 'Test Pharmacy' })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });

    // Verify it was saved
    const getRes = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/settings/business_name')
      .expect(200);

    expect(getRes.body.data.value).toBe('Test Pharmacy');
  });

  it('rejects unknown setting key', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .put('/api/v1/settings/unknown_key')
      .send({ value: 'nope' })
      .expect(400);
  });

  it('rejects pharmacist (requireAdmin)', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .put('/api/v1/settings/business_name')
      .send({ value: 'nope' })
      .expect(403);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .put('/api/v1/settings/business_name')
      .send({ value: 'nope' })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .put('/api/v1/settings/business_name')
      .send({ value: 'nope' })
      .expect(401);
  });
});
