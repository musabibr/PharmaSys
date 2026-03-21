import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/categories ──────────────────────────────────────────────────

describe('GET /api/v1/categories', () => {
  it('requires authentication', async () => {
    await request(ctx.app)
      .get('/api/v1/categories')
      .expect(401);
  });

  it('returns categories with auth', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/categories')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBeGreaterThanOrEqual(8); // demo seed
  });

  it('each category has expected shape', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/categories')
      .expect(200);

    const cat = res.body.data[0];
    expect(cat).toHaveProperty('id');
    expect(cat).toHaveProperty('name');
    expect(cat).toHaveProperty('created_at');
  });
});

// ─── POST /api/v1/categories ─────────────────────────────────────────────────

describe('POST /api/v1/categories', () => {
  it('admin creates category', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/categories')
      .send({ name: 'Test Category' })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.name).toBe('Test Category');
  });

  it('pharmacist creates category (has perm_inventory)', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/categories')
      .send({ name: 'Pharma Category' })
      .expect(201);

    expect(res.body.data.name).toBe('Pharma Category');
  });

  it('rejects empty name', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/categories')
      .send({ name: '' })
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('rejects cashier (no perm_inventory)', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .post('/api/v1/categories')
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/categories')
      .send({ name: 'Nope' })
      .expect(401);
  });
});

// ─── PUT /api/v1/categories/:id ──────────────────────────────────────────────

describe('PUT /api/v1/categories/:id', () => {
  let categoryId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/categories')
      .send({ name: 'Update Target' })
      .expect(201);
    categoryId = res.body.data.id;
  });

  it('updates category name', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .put(`/api/v1/categories/${categoryId}`)
      .send({ name: 'Updated Name' })
      .expect(200);

    expect(res.body.data.name).toBe('Updated Name');
    expect(res.body.data.id).toBe(categoryId);
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .put('/api/v1/categories/99999')
      .send({ name: 'Ghost' })
      .expect(404);
  });

  it('rejects empty name', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .put(`/api/v1/categories/${categoryId}`)
      .send({ name: '' })
      .expect(400);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .put(`/api/v1/categories/${categoryId}`)
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .put(`/api/v1/categories/${categoryId}`)
      .send({ name: 'Nope' })
      .expect(401);
  });
});
