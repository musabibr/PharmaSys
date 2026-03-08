import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/reports/dashboard ───────────────────────────────────────────

describe('GET /api/v1/reports/dashboard', () => {
  it('returns dashboard stats', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/reports/dashboard')
      .expect(200);

    expect(res.body).toHaveProperty('data');
    // Dashboard should have some stats from demo data
    const stats = res.body.data;
    expect(stats).toHaveProperty('today_sales');
    expect(stats).toHaveProperty('today_transactions');
  });

  it('rejects cashier without reports.dashboard permission', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/reports/dashboard')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/reports/dashboard').expect(401);
  });
});

// ─── GET /api/v1/reports/cash-flow ───────────────────────────────────────────

describe('GET /api/v1/reports/cash-flow', () => {
  it('returns cash flow report with date range', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/reports/cash-flow?startDate=2025-12-01&endDate=2026-02-28')
      .expect(200);

    expect(res.body).toHaveProperty('data');
  });

  it('pharmacist can access (has perm_reports)', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .get('/api/v1/reports/cash-flow?startDate=2026-01-01&endDate=2026-02-28')
      .expect(200);
  });

  it('rejects cashier (no perm_reports)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/reports/cash-flow?startDate=2026-01-01&endDate=2026-02-28')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .get('/api/v1/reports/cash-flow?startDate=2026-01-01&endDate=2026-02-28')
      .expect(401);
  });
});

// ─── GET /api/v1/reports/profit-loss ─────────────────────────────────────────

describe('GET /api/v1/reports/profit-loss', () => {
  it('returns profit-loss report', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/reports/profit-loss?startDate=2025-12-01&endDate=2026-02-28')
      .expect(200);

    expect(res.body).toHaveProperty('data');
  });

  it('rejects cashier (no perm_reports)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/reports/profit-loss?startDate=2026-01-01&endDate=2026-02-28')
      .expect(403);
  });
});

// ─── GET /api/v1/reports/reorder ─────────────────────────────────────────────

describe('GET /api/v1/reports/reorder', () => {
  it('returns reorder recommendations', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/reports/reorder')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/reports/reorder')
      .expect(403);
  });
});

// ─── GET /api/v1/reports/dead-capital ────────────────────────────────────────

describe('GET /api/v1/reports/dead-capital', () => {
  it('returns dead capital items', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/reports/dead-capital')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/reports/dead-capital')
      .expect(403);
  });
});

// ─── GET /api/v1/reports/inventory-valuation ─────────────────────────────────

describe('GET /api/v1/reports/inventory-valuation', () => {
  it('returns inventory valuation', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/reports/inventory-valuation')
      .expect(200);

    expect(res.body).toHaveProperty('data');
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/reports/inventory-valuation')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .get('/api/v1/reports/inventory-valuation')
      .expect(401);
  });
});
