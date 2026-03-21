import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── GET /api/v1/users ───────────────────────────────────────────────────────

describe('GET /api/v1/users', () => {
  it('admin gets all users', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/users')
      .expect(200);

    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3); // admin + pharmacist + cashier
    expect(res.body.data[0]).toHaveProperty('id');
    expect(res.body.data[0]).toHaveProperty('username');
    expect(res.body.data[0]).toHaveProperty('role');
  });

  it('rejects pharmacist', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .get('/api/v1/users')
      .expect(403);
  });

  it('rejects cashier', async () => {
    await authRequest(ctx.app, ctx.tokens.cashier)
      .get('/api/v1/users')
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/users').expect(401);
  });
});

// ─── GET /api/v1/users/:id ───────────────────────────────────────────────────

describe('GET /api/v1/users/:id', () => {
  it('admin gets user by ID', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get(`/api/v1/users/${ctx.users.pharmacist.id}`)
      .expect(200);

    expect(res.body.data.id).toBe(ctx.users.pharmacist.id);
    expect(res.body.data.username).toBe('pharmacist');
  });

  it('returns 404 for non-existent ID', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/users/99999')
      .expect(404);

    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .get(`/api/v1/users/${ctx.users.cashier.id}`)
      .expect(403);
  });
});

// ─── POST /api/v1/users ──────────────────────────────────────────────────────

describe('POST /api/v1/users', () => {
  let createdUserId: number;

  it('admin creates user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/users')
      .send({
        username: 'newuser',
        password: 'newpass123',
        full_name: 'New User',
        role: 'cashier',
      })
      .expect(201);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.username).toBe('newuser');
    expect(res.body.data.role).toBe('cashier');
    createdUserId = res.body.data.id;
  });

  it('rejects missing username', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/users')
      .send({ password: 'pass123', full_name: 'Test', role: 'cashier' })
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('rejects missing password', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/users')
      .send({ username: 'nopass', full_name: 'Test', role: 'cashier' })
      .expect(400);
  });

  it('rejects duplicate username', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/users')
      .send({ username: 'admin', password: 'pass12345', full_name: 'Dup', role: 'cashier' })
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/users')
      .send({ username: 'nope', password: 'pass123', full_name: 'Nope', role: 'cashier' })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/users')
      .send({ username: 'nope', password: 'pass' })
      .expect(401);
  });
});

// ─── PUT /api/v1/users/:id ───────────────────────────────────────────────────

describe('PUT /api/v1/users/:id', () => {
  let targetUserId: number;

  beforeAll(async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/users')
      .send({ username: 'updatetarget', password: 'pass12345', full_name: 'Update Target', role: 'cashier' })
      .expect(201);
    targetUserId = res.body.data.id;
  });

  it('admin updates user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .put(`/api/v1/users/${targetUserId}`)
      .send({ full_name: 'Updated Name', role: 'cashier' })
      .expect(200);

    expect(res.body.data.full_name).toBe('Updated Name');
  });

  it('returns 404 for non-existent ID', async () => {
    await authRequest(ctx.app, ctx.tokens.admin)
      .put('/api/v1/users/99999')
      .send({ full_name: 'Ghost', role: 'cashier' })
      .expect(404);
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .put(`/api/v1/users/${targetUserId}`)
      .send({ full_name: 'Nope', role: 'cashier' })
      .expect(403);
  });
});

// ─── POST /api/v1/users/:id/reset-password ───────────────────────────────────

describe('POST /api/v1/users/:id/reset-password', () => {
  it('admin resets user password', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/users/${ctx.users.cashier.id}/reset-password`)
      .send({ newPassword: 'reset789' })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });

    // Reset back
    await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/users/${ctx.users.cashier.id}/reset-password`)
      .send({ newPassword: 'cashier123' })
      .expect(200);
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post(`/api/v1/users/${ctx.users.cashier.id}/reset-password`)
      .send({ newPassword: 'nope' })
      .expect(403);
  });
});

// ─── POST /api/v1/users/:id/unlock ───────────────────────────────────────────

describe('POST /api/v1/users/:id/unlock', () => {
  it('admin unlocks user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/users/${ctx.users.cashier.id}/unlock`)
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post(`/api/v1/users/${ctx.users.cashier.id}/unlock`)
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post(`/api/v1/users/${ctx.users.cashier.id}/unlock`)
      .expect(401);
  });
});
