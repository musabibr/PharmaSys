import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;
let testShiftId: number;
let testSaleId: number;

beforeAll(async () => {
  ctx = await createRestTestContext();

  // Open a shift — required for creating sales
  const shiftRes = await authRequest(ctx.app, ctx.tokens.admin)
    .post('/api/v1/shifts/open')
    .send({ openingAmount: 100000 })
    .expect(201);
  testShiftId = shiftRes.body.data.id;
}, 15000);

afterAll(async () => {
  // Close the shift if still open
  try {
    await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/shifts/${testShiftId}/close`)
      .send({ actualCash: 100000 });
  } catch {
    // ignore — may already be closed
  }
  ctx.destroy();
});

// ─── GET /api/v1/transactions ────────────────────────────────────────────────

describe('GET /api/v1/transactions', () => {
  it('returns paginated transactions list', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/transactions')
      .expect(200);

    // PaginatedResult: { data: Transaction[], total, page, limit, totalPages }
    const paginated = res.body.data;
    expect(paginated).toHaveProperty('data');
    expect(paginated).toHaveProperty('total');
    expect(paginated.data).toBeInstanceOf(Array);
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/transactions')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/transactions').expect(401);
  });
});

// ─── POST /api/v1/transactions/sale ──────────────────────────────────────────

describe('POST /api/v1/transactions/sale', () => {
  it('creates a sale', async () => {
    // Get an available batch with stock
    const batches = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/available')
      .expect(200);

    const batch = batches.body.data.find((b: any) => b.quantity_base > 0 && b.status === 'active');
    expect(batch).toBeDefined();

    const unitPrice = batch.selling_price_parent || batch.cost_per_parent * 2;
    const totalAmount = unitPrice;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/transactions/sale')
      .send({
        transaction_type: 'sale',
        items: [{
          product_id: batch.product_id,
          batch_id: batch.id,
          quantity: 1,
          unit_type: 'parent',
          unit_price: unitPrice,
        }],
        payment_method: 'cash',
        subtotal: totalAmount,
        total_amount: totalAmount,
        cash_tendered: totalAmount,
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('transaction_type', 'sale');
    expect(res.body.data).toHaveProperty('total_amount');
    testSaleId = res.body.data.id;
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/transactions/sale')
      .send({ items: [], payment_method: 'cash' })
      .expect(401);
  });
});

// ─── GET /api/v1/transactions/:id ────────────────────────────────────────────

describe('GET /api/v1/transactions/:id', () => {
  it('returns transaction by ID', async () => {
    // Use testSaleId from above, or fall back to first transaction from list
    let txnId = testSaleId;
    if (!txnId) {
      const list = await authRequest(ctx.app, ctx.tokens.admin)
        .get('/api/v1/transactions')
        .expect(200);
      txnId = list.body.data.data[0]?.id;
    }

    if (!txnId) return; // skip if no transactions

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/transactions/${txnId}`)
      .expect(200);

    expect(res.body.data.id).toBe(txnId);
    expect(res.body.data).toHaveProperty('transaction_type');
    expect(res.body.data).toHaveProperty('total_amount');
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/transactions/99999')
      .expect(404);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/transactions/1')
      .expect(403);
  });
});

// ─── POST /api/v1/transactions/return ────────────────────────────────────────

describe('POST /api/v1/transactions/return', () => {
  it('creates a return from a valid sale', async () => {
    if (!testSaleId) return;

    const saleRes = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/transactions/${testSaleId}`)
      .expect(200);

    const sale = saleRes.body.data;
    if (!sale.items || sale.items.length === 0) return;

    const item = sale.items[0];

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/transactions/return')
      .send({
        original_transaction_id: testSaleId,
        items: [{
          batch_id: item.batch_id,
          product_id: item.product_id,
          quantity: 1,
          unit_type: item.unit_type || 'parent',
        }],
        payment_method: 'cash',
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('transaction_type', 'return');
  });

  it('rejects cashier (requires perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/transactions/return')
      .send({
        original_transaction_id: 1,
        items: [{ batch_id: 1, product_id: 1, quantity: 1, unit_type: 'parent' }],
        payment_method: 'cash',
      })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/transactions/return')
      .send({ original_transaction_id: 1, items: [] })
      .expect(401);
  });
});

// ─── POST /api/v1/transactions/:id/void ──────────────────────────────────────

describe('POST /api/v1/transactions/:id/void', () => {
  let voidTargetId: number;

  beforeAll(async () => {
    // Create a sale to void
    const batches = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/batches/available')
      .expect(200);

    const batch = batches.body.data.find((b: any) => b.quantity_base > 0 && b.status === 'active');
    if (batch) {
      const unitPrice = batch.selling_price_parent || batch.cost_per_parent * 2;
      const res = await authRequest(ctx.app, ctx.tokens.admin)
        .post('/api/v1/transactions/sale')
        .send({
          transaction_type: 'sale',
          items: [{
            product_id: batch.product_id,
            batch_id: batch.id,
            quantity: 1,
            unit_type: 'parent',
            unit_price: unitPrice,
          }],
          payment_method: 'cash',
          subtotal: unitPrice,
          total_amount: unitPrice,
          cash_tendered: unitPrice,
        })
        .expect(201);
      voidTargetId = res.body.data.id;
    }
  });

  it('voids a transaction', async () => {
    if (!voidTargetId) return;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/transactions/${voidTargetId}/void`)
      .send({ reason: 'Test void' })
      .expect(200);

    expect(res.body.data).toHaveProperty('id');
    // voidTransaction returns the original transaction (now marked as voided)
    // or a new void-type transaction — check for either
    expect(res.body.data).toHaveProperty('transaction_type');
    expect(res.body.data.id).toBe(voidTargetId);
  });

  it('rejects voiding already-voided transaction', async () => {
    if (!voidTargetId) return;

    await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/transactions/${voidTargetId}/void`)
      .send({ reason: 'Double void' })
      .expect(400);
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/transactions/99999/void')
      .send({ reason: 'Ghost' })
      .expect(404);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/transactions/1/void')
      .send({ reason: 'Nope' })
      .expect(403);
  });
});
