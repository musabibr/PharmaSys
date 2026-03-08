import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/batches ─────────────────────────────────────────────────────

describe('GET /api/v1/batches', () => {
  it('returns batches for authenticated user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty('id');
    expect(res.body.data[0]).toHaveProperty('product_id');
    expect(res.body.data[0]).toHaveProperty('batch_number');
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches').expect(401);
  });
});

// ─── GET /api/v1/batches/available ───────────────────────────────────────────

describe('GET /api/v1/batches/available', () => {
  it('returns available batches', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/available')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/available').expect(401);
  });
});

// ─── GET /api/v1/batches/available/:productId ────────────────────────────────

describe('GET /api/v1/batches/available/:productId', () => {
  it('returns available batches for product', async () => {
    // Get a product that has batches
    const products = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);

    const productId = products.body.data[0].id;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/batches/available/${productId}`)
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/available/1').expect(401);
  });
});

// ─── GET /api/v1/batches/expiring ────────────────────────────────────────────

describe('GET /api/v1/batches/expiring', () => {
  it('returns expiring batches with default days', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/expiring')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('accepts custom days parameter', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/expiring?days=90')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/expiring').expect(401);
  });
});

// ─── GET /api/v1/batches/expired ─────────────────────────────────────────────

describe('GET /api/v1/batches/expired', () => {
  it('returns expired batches', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/expired')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/expired').expect(401);
  });
});

// ─── GET /api/v1/batches/by-product/:productId ──────────────────────────────

describe('GET /api/v1/batches/by-product/:productId', () => {
  it('returns batches for product', async () => {
    const products = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);

    const productId = products.body.data[0].id;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/batches/by-product/${productId}`)
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/by-product/1').expect(401);
  });
});

// ─── GET /api/v1/batches/adjustments ─────────────────────────────────────────

describe('GET /api/v1/batches/adjustments', () => {
  it('admin gets adjustments', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/adjustments')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('pharmacist gets adjustments (has perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .get('/api/v1/batches/adjustments')
      .expect(200);
  });

  it('rejects cashier (no perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/batches/adjustments')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/adjustments').expect(401);
  });
});

// ─── GET /api/v1/batches/:id ─────────────────────────────────────────────────

describe('GET /api/v1/batches/:id', () => {
  it('returns batch by ID', async () => {
    const list = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches')
      .expect(200);

    const batchId = list.body.data[0].id;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/batches/${batchId}`)
      .expect(200);

    expect(res.body.data.id).toBe(batchId);
    expect(res.body.data).toHaveProperty('batch_number');
    expect(res.body.data).toHaveProperty('expiry_date');
    expect(res.body.data).toHaveProperty('quantity_base');
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/99999')
      .expect(404);

    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/batches/1').expect(401);
  });
});

// ─── POST /api/v1/batches ────────────────────────────────────────────────────

describe('POST /api/v1/batches', () => {
  let testProductId: number;

  beforeAll(async () => {
    const products = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);
    testProductId = products.body.data[0].id;
  });

  it('creates batch with valid data', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/batches')
      .send({
        product_id: testProductId,
        batch_number: 'REST-BATCH-001',
        expiry_date: '2028-12-31',
        quantity_base: 100,
        cost_per_parent: 50000,
        selling_price_parent: 80000,
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.batch_number).toBe('REST-BATCH-001');
    expect(res.body.data.product_id).toBe(testProductId);
  });

  it('pharmacist can create batch (has perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/batches')
      .send({
        product_id: testProductId,
        batch_number: 'REST-BATCH-002',
        expiry_date: '2028-06-30',
        quantity_base: 50,
        cost_per_parent: 40000,
        selling_price_parent: 70000,
      })
      .expect(201);
  });

  it('rejects cashier (no perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/batches')
      .send({
        product_id: testProductId,
        batch_number: 'NOPE',
        expiry_date: '2028-12-31',
        quantity_base: 10,
        cost_per_parent: 5000,
        selling_price_parent: 8000,
      })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/batches')
      .send({ product_id: testProductId, batch_number: 'X', expiry_date: '2028-12-31', quantity_base: 10 })
      .expect(401);
  });
});

// ─── PUT /api/v1/batches/:id ─────────────────────────────────────────────────

describe('PUT /api/v1/batches/:id', () => {
  let testBatchId: number;

  beforeAll(async () => {
    const list = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches')
      .expect(200);
    // Pick the batch we created in the POST test
    const batch = list.body.data.find((b: any) => b.batch_number === 'REST-BATCH-001');
    testBatchId = batch ? batch.id : list.body.data[0].id;
  });

  it('updates batch', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .put(`/api/v1/batches/${testBatchId}`)
      .send({ selling_price_parent: 85000 })
      .expect(200);

    expect(res.body.data.id).toBe(testBatchId);
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .put('/api/v1/batches/99999')
      .send({ selling_price_parent: 1000 })
      .expect(404);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .put(`/api/v1/batches/${testBatchId}`)
      .send({ selling_price_parent: 1000 })
      .expect(403);
  });
});

// ─── POST /api/v1/batches/:id/damage ─────────────────────────────────────────

describe('POST /api/v1/batches/:id/damage', () => {
  let damageBatchId: number;

  beforeAll(async () => {
    // Create a batch with enough stock to damage
    const products = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/products')
      .expect(200);

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/batches')
      .send({
        product_id: products.body.data[0].id,
        batch_number: 'DAMAGE-TEST-001',
        expiry_date: '2028-12-31',
        quantity_base: 200,
        cost_per_parent: 50000,
        selling_price_parent: 80000,
      })
      .expect(201);
    damageBatchId = res.body.data.id;
  });

  it('reports damage', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/batches/${damageBatchId}/damage`)
      .send({ quantityBase: 5, reason: 'Broken packaging', type: 'damage' })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects cashier (no perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post(`/api/v1/batches/${damageBatchId}/damage`)
      .send({ quantityBase: 1, type: 'damage' })
      .expect(403);
  });

  it('returns 404 for non-existent batch', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/batches/99999/damage')
      .send({ quantityBase: 1, type: 'damage' })
      .expect(404);
  });
});
