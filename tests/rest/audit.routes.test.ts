import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/audit ───────────────────────────────────────────────────────

describe('GET /api/v1/audit', () => {
  it('admin gets audit logs', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/audit')
      .expect(200);

    // PaginatedResult: { data: AuditLog[], total, page, limit, totalPages }
    const paginated = res.body.data;
    expect(paginated).toHaveProperty('data');
    expect(paginated).toHaveProperty('total');
    expect(paginated.data).toBeInstanceOf(Array);
  });

  it('rejects pharmacist', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .get('/api/v1/audit')
      .expect(403);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/audit')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/audit').expect(401);
  });
});

// ─── DELETE /api/v1/audit/purge ──────────────────────────────────────────────

describe('DELETE /api/v1/audit/purge', () => {
  it('admin purges old audit logs', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .delete('/api/v1/audit/purge')
      .send({ olderThanDays: 365 })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects pharmacist', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .delete('/api/v1/audit/purge')
      .send({ olderThanDays: 90 })
      .expect(403);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .delete('/api/v1/audit/purge')
      .send({ olderThanDays: 90 })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .delete('/api/v1/audit/purge')
      .send({ olderThanDays: 90 })
      .expect(401);
  });
});
