import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/expenses/categories ─────────────────────────────────────────

describe('GET /api/v1/expenses/categories', () => {
  it('returns expense categories for authenticated user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/expenses/categories')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects cashier without finance.expenses.view permission', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/expenses/categories')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/expenses/categories').expect(401);
  });
});

// ─── POST /api/v1/expenses/categories ────────────────────────────────────────

describe('POST /api/v1/expenses/categories', () => {
  it('creates expense category', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/expenses/categories')
      .send({ name: 'Test Expense Category' })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.name).toBe('Test Expense Category');
  });

  it('rejects empty name', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/expenses/categories')
      .send({ name: '' })
      .expect(400);
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/expenses/categories')
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/expenses/categories')
      .send({ name: 'Nope' })
      .expect(401);
  });
});

// ─── GET /api/v1/expenses ────────────────────────────────────────────────────

describe('GET /api/v1/expenses', () => {
  it('returns expenses list', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/expenses')
      .expect(200);

    expect(res.body.data).toHaveProperty('data');
    expect(res.body.data.data).toBeInstanceOf(Array);
    expect(res.body.data).toHaveProperty('total');
    expect(res.body.data).toHaveProperty('totalPages');
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/expenses')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/expenses').expect(401);
  });
});

// ─── POST /api/v1/expenses ───────────────────────────────────────────────────

describe('POST /api/v1/expenses', () => {
  let expenseCategoryId: number;
  let createdExpenseId: number;

  beforeAll(async () => {
    // Get or create an expense category
    const catRes = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/expenses/categories')
      .expect(200);

    if (catRes.body.data.length > 0) {
      expenseCategoryId = catRes.body.data[0].id;
    } else {
      const newCat = await authRequest(ctx.app, ctx.tokens.admin)
        .post('/api/v1/expenses/categories')
        .send({ name: 'Office Supplies' })
        .expect(201);
      expenseCategoryId = newCat.body.data.id;
    }
  });

  it('creates expense', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/expenses')
      .send({
        category_id: expenseCategoryId,
        amount: 50000,
        description: 'Paper and pens',
        payment_method: 'cash',
        expense_date: new Date().toISOString().split('T')[0],
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.amount).toBe(50000);
    createdExpenseId = res.body.data.id;
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/expenses')
      .send({
        category_id: expenseCategoryId,
        amount: 10000,
        description: 'Test',
        payment_method: 'cash',
        expense_date: '2026-01-01',
      })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/expenses')
      .send({ category_id: 1, amount: 1000, payment_method: 'cash', expense_date: '2026-01-01' })
      .expect(401);
  });
});

// ─── DELETE /api/v1/expenses/:id ─────────────────────────────────────────────

describe('DELETE /api/v1/expenses/:id', () => {
  let deleteTargetId: number;

  beforeAll(async () => {
    // Get or create an expense to delete
    const catRes = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/expenses/categories')
      .expect(200);

    const catId = catRes.body.data[0]?.id || 1;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/expenses')
      .send({
        category_id: catId,
        amount: 10000,
        description: 'Delete me',
        payment_method: 'cash',
        expense_date: '2026-01-01',
      })
      .expect(201);
    deleteTargetId = res.body.data.id;
  });

  it('deletes expense', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .delete(`/api/v1/expenses/${deleteTargetId}`)
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .delete('/api/v1/expenses/1')
      .expect(403);
  });
});

// ─── GET /api/v1/expenses/cash-drops ─────────────────────────────────────────

describe('GET /api/v1/expenses/cash-drops', () => {
  it('returns cash drops for a shift', async () => {
    // Get a shift ID from the historical data (paginated result)
    const shifts = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts')
      .expect(200);

    const shiftId = shifts.body.data.data[0].id;

    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/expenses/cash-drops?shiftId=${shiftId}`)
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/expenses/cash-drops?shiftId=1')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/expenses/cash-drops?shiftId=1').expect(401);
  });
});

// ─── POST /api/v1/expenses/cash-drops ────────────────────────────────────────

describe('POST /api/v1/expenses/cash-drops', () => {
  it('rejects when no shift is open', async () => {
    // No shift is open by default in this test context
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/expenses/cash-drops')
      .send({ amount: 50000, notes: 'Test drop' })
      .expect(422);
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/expenses/cash-drops')
      .send({ amount: 50000 })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/expenses/cash-drops')
      .send({ amount: 50000 })
      .expect(401);
  });
});
