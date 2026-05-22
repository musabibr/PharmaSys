/**
 * Standalone server entry point (no Electron).
 * Runs PharmaSys as a pure Node.js Express server.
 *
 * Usage:
 *   npx tsx src/platform/server/index.ts
 *   PORT=3001 DB_PATH=/data/pharmasys.db npx tsx src/platform/server/index.ts
 *
 * PostgreSQL mode:
 *   DB_TYPE=postgres DATABASE_URL=postgres://user:pass@host:5432/pharmasys npx tsx src/platform/server/index.ts
 */

import * as path   from 'path';
import * as fs     from 'fs';

import { ServiceContainer }    from '../../core/services/index';
import { EventBus }            from '../../core/events/event-bus';
import { createApp }           from '../../transport/rest/server';

const PORT    = Number(process.env.PORT ?? 3001);
const HOST    = process.env.HOST ?? '0.0.0.0';
const DB_DIR  = process.env.DB_PATH ?? path.join(process.cwd(), 'data');
const DB_TYPE = process.env.DB_TYPE ?? 'sqlite';

// ─── SQLite (better-sqlite3) bootstrap ───────────────────────────────────────

async function bootSqlite(): Promise<{ repos: any; shutdown: () => void }> {
  const { createRepositories } = await import('../../core/repositories/sql/index');
  const { MigrationRepository } = await import('../../core/repositories/sql/migration.repository');

  const DB_FILE = path.join(DB_DIR, 'pharmasys.db');
  fs.mkdirSync(DB_DIR, { recursive: true });

  // createRepositories opens the database file (creates if missing),
  // sets WAL mode + foreign keys, all via better-sqlite3.
  const repos = createRepositories(DB_FILE, DB_DIR);

  const migration = new MigrationRepository(repos.base, DB_DIR);
  const seedDemo = process.env.SEED_DEMO === 'true';
  await migration.initialise(seedDemo);

  return {
    repos,
    shutdown: () => repos.base.close(),
  };
}

// ─── PostgreSQL bootstrap ────────────────────────────────────────────────────

async function bootPostgres(): Promise<{ repos: any; shutdown: () => void }> {
  const { Pool } = await import('pg');
  const { createPgRepositories } = await import('../../core/repositories/pg/index');
  const { PgMigrationRepository } = await import('../../core/repositories/pg/migration.repository');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required for DB_TYPE=postgres');
  }

  fs.mkdirSync(DB_DIR, { recursive: true });

  const pool = new Pool({
    connectionString,
    max: parseInt(process.env.PG_POOL_MAX ?? '10', 10),
    min: parseInt(process.env.PG_POOL_MIN ?? '2', 10),
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });

  // Verify connection
  const client = await pool.connect();
  console.log('[Server] Connected to PostgreSQL');
  client.release();

  const repos = createPgRepositories(pool, connectionString, DB_DIR);

  const migration = new PgMigrationRepository(repos.base, DB_DIR);
  const seedDemo = process.env.SEED_DEMO === 'true';
  await migration.initialise(seedDemo);

  return {
    repos,
    shutdown: () => { pool.end().catch(() => {}); },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[Server] Database type: ${DB_TYPE}`);

  const { repos, shutdown } = DB_TYPE === 'postgres'
    ? await bootPostgres()
    : await bootSqlite();

  const bus = new EventBus();
  const svc = new ServiceContainer(repos, bus);

  // Auto-generate any missed recurring expenses (daily + monthly)
  try {
    const count = await svc.recurringExpense.generateForMissedDays(1);
    if (count > 0) console.log(`[Server] Auto-generated ${count} recurring expense(s)`);
  } catch (err) {
    console.warn('[Server] Failed to auto-generate recurring expenses:', (err as Error).message);
  }

  const app = createApp(svc);

  app.listen(PORT, HOST, () => {
    console.log(`[Server] PharmaSys API running → http://${HOST}:${PORT}/api/v1`);
    console.log(`[Server] Health check       → http://${HOST}:${PORT}/health`);
  });

  // Graceful shutdown
  const handleShutdown = (): void => {
    console.log('[Server] Shutting down…');
    shutdown();
    process.exit(0);
  };
  process.on('SIGINT',  handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
