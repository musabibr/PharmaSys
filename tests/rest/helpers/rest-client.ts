/**
 * REST test helper — creates an Express app backed by a real
 * in-memory sql.js database with schema + demo data.
 *
 * Usage:
 *   const ctx = await createRestTestContext();
 *   const res = await authRequest(ctx.app, ctx.tokens.admin)
 *     .get('/api/v1/products')
 *     .expect(200);
 *   ctx.destroy();
 */

import type { Application } from 'express';
import request from 'supertest';
import { createTestContext, type TestContext } from '../../helpers/test-db';
import { createApp } from '@transport/rest/server';
import { createSession, destroySession } from '@transport/middleware/auth.middleware';
import type { UserPublic } from '@core/types/models';
import type { ServiceContainer } from '@core/services/index';

export interface RestTestContext {
  app: Application;
  services: ServiceContainer;
  tokens: {
    admin: string;
    pharmacist: string;
    cashier: string;
  };
  users: {
    admin: UserPublic;
    pharmacist: UserPublic;
    cashier: UserPublic;
  };
  destroy: () => void;
}

/**
 * Boots a full REST test context:
 * 1. Creates in-memory sql.js with schema + demo data
 * 2. Creates Express app with real ServiceContainer
 * 3. Logs in all 3 demo users and captures session tokens
 */
export async function createRestTestContext(): Promise<RestTestContext> {
  const testCtx = await createTestContext();
  const app = createApp(testCtx.services);

  // Login each demo user to get UserPublic objects, then mint tokens
  const adminResult = await testCtx.services.auth.login('admin', 'admin123');
  const pharmResult = await testCtx.services.auth.login('pharmacist', 'pharma123');
  const cashResult  = await testCtx.services.auth.login('cashier', 'cashier123');

  const adminToken = createSession(adminResult.user);
  const pharmToken = createSession(pharmResult.user);
  const cashToken  = createSession(cashResult.user);

  return {
    app,
    services: testCtx.services,
    tokens: {
      admin: adminToken,
      pharmacist: pharmToken,
      cashier: cashToken,
    },
    users: {
      admin: adminResult.user,
      pharmacist: pharmResult.user,
      cashier: cashResult.user,
    },
    destroy: () => {
      destroySession(adminToken);
      destroySession(pharmToken);
      destroySession(cashToken);
      testCtx.destroy();
    },
  };
}

/** Convenience: returns request helpers pre-configured with a Bearer token. */
export function authRequest(app: Application, token: string) {
  return {
    get:    (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
    post:   (url: string) => request(app).post(url).set('Authorization', `Bearer ${token}`),
    put:    (url: string) => request(app).put(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
  };
}
