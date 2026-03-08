import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/held-sales ──────────────────────────────────────────────────

describe('GET /api/v1/held-sales', () => {
  it('returns held sales for authenticated user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/held-sales')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('allows cashier (requireAuth only)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/held-sales')
      .expect(200);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/held-sales').expect(401);
  });
});

// ─── POST /api/v1/held-sales ─────────────────────────────────────────────────

describe('POST /api/v1/held-sales', () => {
  let savedSaleId: number;

  it('saves a held sale', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/held-sales')
      .send({
        items: [
          { product_id: 1, product_name: 'Test Product', batch_id: 1, quantity: 2, unit_type: 'parent', unit_price: 50000 },
        ],
        customerNote: 'Hold for customer',
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    savedSaleId = res.body.data.id;
  });

  it('allows cashier to hold sales', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/held-sales')
      .send({
        items: [
          { product_id: 1, product_name: 'Test', batch_id: 1, quantity: 1, unit_type: 'parent', unit_price: 30000 },
        ],
      })
      .expect(201);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/held-sales')
      .send({ items: [] })
      .expect(401);
  });
});

// ─── DELETE /api/v1/held-sales/:id ───────────────────────────────────────────

describe('DELETE /api/v1/held-sales/:id', () => {
  let deleteTargetId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/held-sales')
      .send({
        items: [
          { product_id: 1, product_name: 'Delete Me', batch_id: 1, quantity: 1, unit_type: 'parent', unit_price: 10000 },
        ],
      })
      .expect(201);
    deleteTargetId = res.body.data.id;
  });

  it('deletes held sale', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .delete(`/api/v1/held-sales/${deleteTargetId}`)
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .delete('/api/v1/held-sales/1')
      .expect(401);
  });
});
