import request from 'supertest';
import { createRestTestContext, authRequest, type RestTestContext } from './helpers/rest-client';

let ctx: RestTestContext;

beforeAll(async () => {
  ctx = await createRestTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── POST /api/v1/auth/login ─────────────────────────────────────────────────

describe('POST /api/v1/auth/login', () => {
  it('returns user + token on valid credentials', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
      .expect(200);

    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data).toHaveProperty('mustChangePassword');
    expect(res.body.data.user.username).toBe('admin');
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.token.length).toBe(64); // 32 random bytes hex
  });

  it('returned token works for authenticated requests', async () => {
    const loginRes = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
      .expect(200);

    const token = loginRes.body.data.token;

    await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects wrong password', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'wrongpass' })
      .expect(401);

    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  it('rejects non-existent username', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'nonexistent', password: 'pass' })
      .expect(401);

    expect(res.body).toHaveProperty('code', 'AUTHENTICATION_ERROR');
  });

  it('rejects missing username', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ password: 'pass' });

    // Service throws AuthenticationError (401) or ValidationError (400)
    expect([400, 401]).toContain(res.status);
  });

  it('rejects missing password', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin' });

    expect([400, 401]).toContain(res.status);
  });
});

// ─── POST /api/v1/auth/logout ────────────────────────────────────────────────

describe('POST /api/v1/auth/logout', () => {
  it('logs out and invalidates token', async () => {
    // Login to get a fresh token
    const loginRes = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
      .expect(200);

    const token = loginRes.body.data.token;

    // Logout
    const res = await request(ctx.app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });

    // Token is now invalid
    await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/auth/logout')
      .expect(401);
  });
});

// ─── GET /api/v1/auth/me ─────────────────────────────────────────────────────

describe('GET /api/v1/auth/me', () => {
  it('returns current user data', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .get('/api/v1/auth/me')
      .expect(200);

    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('username', 'admin');
    expect(res.body.data).toHaveProperty('role', 'admin');
    expect(res.body.data).not.toHaveProperty('password_hash');
  });

  it('rejects without token', async () => {
    await request(ctx.app).get('/api/v1/auth/me').expect(401);
  });

  it('rejects invalid token', async () => {
    await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalidtoken123')
      .expect(401);
  });
});

// ─── POST /api/v1/auth/change-password ───────────────────────────────────────

describe('POST /api/v1/auth/change-password', () => {
  it('changes password with valid credentials', async () => {
    // Login as pharmacist, change password, then change back
    const res = await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'pharma123', newPassword: 'newpass456' })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });

    // Change it back
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'newpass456', newPassword: 'pharma123' })
      .expect(200);
  });

  it('rejects wrong current password', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'wrongcurrent', newPassword: 'newpassword123' });

    // 400 (ValidationError) or 401 (AuthenticationError)
    expect([400, 401]).toContain(res.status);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'admin123', newPassword: 'newpass' })
      .expect(401);
  });
});

// ─── POST /api/v1/auth/admin-reset-password ──────────────────────────────────

describe('POST /api/v1/auth/admin-reset-password', () => {
  it('admin resets another user password', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/auth/admin-reset-password')
      .send({ targetUserId: ctx.users.cashier.id, newPassword: 'reset456', mustChange: false })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });

    // Reset back to original
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/auth/admin-reset-password')
      .send({ targetUserId: ctx.users.cashier.id, newPassword: 'cashier123', mustChange: false })
      .expect(200);
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/auth/admin-reset-password')
      .send({ targetUserId: ctx.users.cashier.id, newPassword: 'nope' })
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/auth/admin-reset-password')
      .send({ targetUserId: 1, newPassword: 'nope' })
      .expect(401);
  });
});

// ─── GET /api/v1/auth/security-question ──────────────────────────────────────

describe('GET /api/v1/auth/security-question', () => {
  it('returns question for user with one set', async () => {
    // First set a security question
    await authRequest(ctx.app, ctx.tokens.admin)
      .post('/api/v1/auth/security-question/set')
      .send({ question: 'What is your pet name?', answer: 'fluffy' })
      .expect(200);

    const res = await request(ctx.app)
      .get('/api/v1/auth/security-question?username=admin')
      .expect(200);

    expect(res.body.data).toHaveProperty('question', 'What is your pet name?');
  });

  it('returns null for user without security question', async () => {
    const res = await request(ctx.app)
      .get('/api/v1/auth/security-question?username=cashier')
      .expect(200);

    expect(res.body.data).toHaveProperty('question', null);
  });
});

// ─── POST /api/v1/auth/security-question/set ─────────────────────────────────

describe('POST /api/v1/auth/security-question/set', () => {
  it('sets security question', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post('/api/v1/auth/security-question/set')
      .send({ question: 'Favourite colour?', answer: 'blue' })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post('/api/v1/auth/security-question/set')
      .send({ question: 'Q?', answer: 'A' })
      .expect(401);
  });
});

// ─── POST /api/v1/auth/reset-password ────────────────────────────────────────

describe('POST /api/v1/auth/reset-password', () => {
  it('resets password with correct security answer', async () => {
    // admin already has security question set from earlier test
    const res = await request(ctx.app)
      .post('/api/v1/auth/reset-password')
      .send({ username: 'admin', answer: 'fluffy', newPassword: 'admin123' })
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects wrong answer', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/reset-password')
      .send({ username: 'admin', answer: 'wronganswer', newPassword: 'newpassword123' });

    // 400 (ValidationError for wrong answer) or 401
    expect([400, 401]).toContain(res.status);
  });
});

// ─── POST /api/v1/auth/unlock/:userId ────────────────────────────────────────

describe('POST /api/v1/auth/unlock/:userId', () => {
  it('admin unlocks user', async () => {
    const res = await authRequest(ctx.app, ctx.tokens.admin)
      .post(`/api/v1/auth/unlock/${ctx.users.cashier.id}`)
      .expect(200);

    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects non-admin', async () => {
    await authRequest(ctx.app, ctx.tokens.pharmacist)
      .post(`/api/v1/auth/unlock/${ctx.users.cashier.id}`)
      .expect(403);
  });

  it('rejects without token', async () => {
    await request(ctx.app)
      .post(`/api/v1/auth/unlock/${ctx.users.cashier.id}`)
      .expect(401);
  });
});

// ─── 404 catch-all ───────────────────────────────────────────────────────────

describe('404 catch-all', () => {
  it('returns 404 for non-existent route', async () => {
    const res = await request(ctx.app)
      .get('/api/v1/nonexistent')
      .expect(404);

    expect(res.body).toEqual({ error: 'Route not found', code: 'NOT_FOUND' });
  });
});
