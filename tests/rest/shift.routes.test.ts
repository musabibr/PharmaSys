import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/shifts/current ──────────────────────────────────────────────

describe('GET /api/v1/shifts/current', () => {
  it('returns data when checking current shift', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts/current')
      .expect(200);

    expect(res.body).toHaveProperty('data');
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/shifts/current').expect(401);
  });
});

// ─── POST /api/v1/shifts/open ────────────────────────────────────────────────

describe('POST /api/v1/shifts/open', () => {
  let openedShiftId: number;

  it('opens a new shift', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/shifts/open')
      .send({ openingAmount: 100000 })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('status', 'open');
    expect(res.body.data).toHaveProperty('opening_amount', 100000);
    openedShiftId = res.body.data.id;
  });

  it('rejects opening another shift while one is open', async () => {
    // Shift.open throws ValidationError (400) for duplicate open shift
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/shifts/open')
      .send({ openingAmount: 50000 })
      .expect(400);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/shifts/open')
      .send({ openingAmount: 50000 })
      .expect(401);
  });

  // Close the shift opened above so subsequent tests can run cleanly
  afterAll(async () => {
    if (openedShiftId) {
      await authRequest(ctx.app, ctx.tokens.admin)
        .post(`/api/v1/shifts/${openedShiftId}/close`)
        .send({ actualCash: 100000 });
    }
  });
});

// ─── GET /api/v1/shifts ──────────────────────────────────────────────────────

describe('GET /api/v1/shifts', () => {
  it('returns paginated shifts list', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts')
      .expect(200);

    // PaginatedResult: { data: Shift[], total, page, limit, totalPages }
    const paginated = res.body.data;
    expect(paginated).toHaveProperty('data');
    expect(paginated).toHaveProperty('total');
    expect(paginated.data).toBeInstanceOf(Array);
    expect(paginated.data.length).toBeGreaterThan(0);
    expect(paginated.data[0]).toHaveProperty('id');
    expect(paginated.data[0]).toHaveProperty('status');
  });

  it('rejects cashier (no perm_finance)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/shifts')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/shifts').expect(401);
  });
});

// ─── GET /api/v1/shifts/:id ──────────────────────────────────────────────────

describe('GET /api/v1/shifts/:id', () => {
  let shiftId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts')
      .expect(200);
    shiftId = res.body.data.data[0].id;
  });

  it('returns shift by ID', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/shifts/${shiftId}`)
      .expect(200);

    expect(res.body.data.id).toBe(shiftId);
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('opening_amount');
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts/99999')
      .expect(404);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get(`/api/v1/shifts/${shiftId}`)
      .expect(403);
  });
});

// ─── GET /api/v1/shifts/:id/expected-cash ────────────────────────────────────

describe('GET /api/v1/shifts/:id/expected-cash', () => {
  let shiftId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts')
      .expect(200);
    shiftId = res.body.data.data[0].id;
  });

  it('returns expected cash breakdown', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/shifts/${shiftId}/expected-cash`)
      .expect(200);

    expect(res.body.data).toHaveProperty('opening_amount');
    expect(res.body.data).toHaveProperty('expected_cash');
  });

  it('allows cashier (has pos.sales permission)', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.cashier)
      .get(`/api/v1/shifts/${shiftId}/expected-cash`)
      .expect(200);

    expect(res.body.data).toHaveProperty('expected_cash');
  });
});

// ─── GET /api/v1/shifts/:id/report ───────────────────────────────────────────

describe('GET /api/v1/shifts/:id/report', () => {
  let shiftId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/shifts')
      .expect(200);
    shiftId = res.body.data.data[0].id;
  });

  it('returns shift report', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/shifts/${shiftId}/report`)
      .expect(200);

    expect(res.body).toHaveProperty('data');
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get(`/api/v1/shifts/${shiftId}/report`)
      .expect(403);
  });
});

// ─── POST /api/v1/shifts/:id/close ───────────────────────────────────────────

describe('POST /api/v1/shifts/:id/close', () => {
  let shiftToCloseId: number;

  beforeAll(async () => {
    // Open a fresh shift to close
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/shifts/open')
      .send({ openingAmount: 50000 })
      .expect(201);
    shiftToCloseId = res.body.data.id;
  });

  it('closes a shift', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/shifts/${shiftToCloseId}/close`)
      .send({ actualCash: 50000, notes: 'Test close' })
      .expect(200);

    expect(res.body.data).toHaveProperty('status', 'closed');
    expect(res.body.data).toHaveProperty('variance_type');
  });

  it('rejects closing already-closed shift', async () => {
    // ShiftService.close throws ValidationError (400) for already-closed
    await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/shifts/${shiftToCloseId}/close`)
      .send({ actualCash: 50000 })
      .expect(400);
  });

  it('allows cashier with pos.sales permission (shift already closed → 400)', async () => {
    // Cashier can close shifts via pos.sales, but this shift is already closed
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post(`/api/v1/shifts/${shiftToCloseId}/close`)
      .send({ actualCash: 50000 })
      .expect(400);
  });
});
