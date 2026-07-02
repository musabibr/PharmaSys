/**
 * Test database helper — boots an in-memory better-sqlite3 database
 * with full schema and seed data for integration tests.
 *
 * NOTE (issues.md #40): the better-sqlite3 native binding in node_modules is
 * built for Electron's ABI (postinstall runs electron-builder install-app-deps),
 * so Node-based Jest cannot load it. The integration/REST suites that use this
 * helper are excluded from the default `npm test` run via
 * `testPathIgnorePatterns` in jest.config.js until a dual-ABI build exists.
 * To run them: rebuild better-sqlite3 for the local Node ABI
 * (`npm rebuild better-sqlite3`), run the suites, then restore the Electron
 * build (`npx electron-builder install-app-deps`).
 *
 * Usage:
 *   const ctx = await createTestContext();
 *   // use ctx.services.product.getAll(), etc.
 *   ctx.destroy();
 */

import { MigrationRepository } from '@core/repositories/sql/migration.repository';
import { createRepositories, type Repositories } from '@core/repositories/sql/index';
import { ServiceContainer }    from '@core/services/index';
import { EventBus }            from '@core/events/event-bus';

export interface TestContext {
  repos: Repositories;
  services: ServiceContainer;
  bus: EventBus;
  destroy: () => void;
}

export async function createTestContext(): Promise<TestContext> {
  // ':memory:' gives each test context an isolated in-memory database.
  const repos = createRepositories(':memory:', '/tmp/test-data');

  // Run full schema + migrations + seed data (demo products/users, no historical transactions)
  const migration = new MigrationRepository(repos.base, '/tmp/test-data');
  await migration.initialise(true, false);

  const bus      = new EventBus();
  const services = new ServiceContainer(repos, bus);

  return {
    repos,
    services,
    bus,
    destroy: () => repos.base.close(),
  };
}
