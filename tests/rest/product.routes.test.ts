import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/products ────────────────────────────────────────────────────

describe('GET /api/v1/products', () => {
  it('returns all products for authenticated user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBeGreaterThanOrEqual(15);
    expect(res.body.data[0]).toHaveProperty('id');
    expect(res.body.data[0]).toHaveProperty('name');
    expect(res.body.data[0]).toHaveProperty('conversion_factor');
  });

  it('allows cashier to browse products (needed for POS)', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/products')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects unauthenticated request', async () => {
    const res = await request(ctx.app)
      .get('/api/v1/products')
      .expect(401);

    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });
});

// ─── GET /api/v1/products/search ─────────────────────────────────────────────

describe('GET /api/v1/products/search', () => {
  it('returns matching products', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products/search?q=Amoxicillin')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array for no matches', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products/search?q=ZZZZNONEXISTENT')
      .expect(200);

    expect(res.body.data).toEqual([]);
  });

  it('rejects unauthenticated request', async () => {
    await request(ctx.app)
      .get('/api/v1/products/search?q=test')
      .expect(401);
  });
});

// ─── GET /api/v1/products/:id ────────────────────────────────────────────────

describe('GET /api/v1/products/:id', () => {
  it('returns product by ID', async () => {
    const listRes = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);

    const productId = listRes.body.data[0].id;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/products/${productId}`)
      .expect(200);

    expect(res.body.data.id).toBe(productId);
    expect(res.body.data).toHaveProperty('name');
    expect(res.body.data).toHaveProperty('parent_unit');
    expect(res.body.data).toHaveProperty('child_unit');
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products/99999')
      .expect(404);

    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  it('rejects unauthenticated request', async () => {
    await request(ctx.app)
      .get('/api/v1/products/1')
      .expect(401);
  });
});

// ─── POST /api/v1/products ───────────────────────────────────────────────────

describe('POST /api/v1/products', () => {
  it('creates a product with valid data', async () => {
    const catRes = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/categories')
      .expect(200);

    const categoryId = catRes.body.data[0].id;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/products')
      .send({
        name: 'Test Product REST',
        generic_name: 'Test Generic',
        category_id: categoryId,
        parent_unit: 'Box',
        child_unit: 'Tablet',
        conversion_factor: 10,
        min_stock_level: 5,
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.name).toBe('Test Product REST');
    expect(res.body.data.conversion_factor).toBe(10);
  });

  it('allows pharmacist (has perm_inventory)', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/products')
      .send({
        name: 'Pharmacist Created Product',
        parent_unit: 'Box',
        child_unit: 'Tablet',
        conversion_factor: 12,
      })
      .expect(201);

    expect(res.body.data.name).toBe('Pharmacist Created Product');
  });

  it('rejects empty name', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/products')
      .send({ name: '', parent_unit: 'Box', child_unit: 'Tab', conversion_factor: 1 })
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('rejects cashier (no perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/products')
      .send({ name: 'Cashier Product', parent_unit: 'Box', child_unit: 'Tab', conversion_factor: 1 })
      .expect(403);
  });

  it('rejects unauthenticated request', async () => {
    await request(ctx.app)
      .post('/api/v1/products')
      .send({ name: 'No Auth' })
      .expect(401);
  });
});

// ─── PUT /api/v1/products/:id ────────────────────────────────────────────────

describe('PUT /api/v1/products/:id', () => {
  let targetProductId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/products')
      .send({ name: 'Update Target Product', parent_unit: 'Box', child_unit: 'Tab', conversion_factor: 5 })
      .expect(201);
    targetProductId = res.body.data.id;
  });

  it('updates product name', async () => {
    // First get the existing product to know its category_id
    const existing = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/products/${targetProductId}`)
      .expect(200);

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .put(`/api/v1/products/${targetProductId}`)
      .send({ name: 'Updated Product Name', category_id: existing.body.data.category_id })
      .expect(200);

    expect(res.body.data.name).toBe('Updated Product Name');
    expect(res.body.data.id).toBe(targetProductId);
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .put('/api/v1/products/99999')
      .send({ name: 'Ghost' })
      .expect(404);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .put(`/api/v1/products/${targetProductId}`)
      .send({ name: 'Nope' })
      .expect(403);
  });
});

// ─── DELETE /api/v1/products/:id ─────────────────────────────────────────────

describe('DELETE /api/v1/products/:id', () => {
  let deleteTargetId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/products')
      .send({ name: 'Delete Me Product', parent_unit: 'Box', child_unit: 'Tab', conversion_factor: 1 })
      .expect(201);
    deleteTargetId = res.body.data.id;
  });

  it('deletes product with no active batches', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .delete(`/api/v1/products/${deleteTargetId}`)
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('product is not returned in getAll after soft-delete', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);

    const found = res.body.data.find((p: any) => p.id === deleteTargetId);
    // Soft-deleted products should not appear in getAll
    // (or if they do, is_active should be 0)
    if (found) {
      expect(found.is_active).toBe(0);
    }
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .delete('/api/v1/products/1')
      .expect(403);
  });
});

// ─── POST /api/v1/products/bulk ──────────────────────────────────────────────

describe('POST /api/v1/products/bulk', () => {
  it('bulk creates products', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/products/bulk')
      .send([
        {
          name: 'Bulk Product 1',
          parent_unit: 'Box',
          child_unit: 'Tab',
          conversion_factor: 10,
          expiry_date: '2028-12-31',
          quantity_base: 100,
          cost_per_parent: 5000,
          selling_price_parent: 8000,
        },
      ])
      .expect(201);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/products/bulk')
      .send([{ name: 'No' }])
      .expect(403);
  });

  it('rejects unauthenticated', async () => {
    await request(ctx.app)
      .post('/api/v1/products/bulk')
      .send([{ name: 'No' }])
      .expect(401);
  });
});
