/**
 * Test database helper — boots an in-memory sql.js database
 * with full schema and seed data for integration tests.
 *
 * Usage:
 *   const ctx = await createTestContext();
 *   // use ctx.services.product.getAll(), etc.
 *   ctx.destroy();
 */

import initSqlJs from 'sql.js';
import { BaseRepository }      from '@core/repositories/sql/base.repository';
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
  const SQL = await initSqlJs();
  const db  = new SQL.Database();

  // Enable foreign keys
  db.run('PRAGMA foreign_keys=ON;');

  const noop = (): void => {};
  const repos = createRepositories(db as any, '/tmp/test-data', noop, noop);

  // Run full schema + migrations + seed data (demo products/users, no historical transactions)
  const migration = new MigrationRepository(repos.base, '/tmp/test-data');
  await migration.initialise(true, false);

  const bus      = new EventBus();
  const services = new ServiceContainer(repos, bus);

  return {
    repos,
    services,
    bus,
    destroy: () => db.close(),
  };
}
