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

// ─── SQLite (sql.js) bootstrap ───────────────────────────────────────────────

async function bootSqlite(): Promise<{ repos: any; shutdown: () => void }> {
  const initSqlJs = (await import('sql.js')).default;
  const { createRepositories } = await import('../../core/repositories/sql/index');
  const { MigrationRepository } = await import('../../core/repositories/sql/migration.repository');

  const DB_FILE = path.join(DB_DIR, 'pharmasys.db');
  fs.mkdirSync(DB_DIR, { recursive: true });

  const SQL = await initSqlJs();

  let db: InstanceType<typeof SQL.Database>;
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
    console.log('[Server] New database created at', DB_FILE);
  }

  db.run('PRAGMA journal_mode=WAL;');
  db.run('PRAGMA foreign_keys=ON;');

  // Mutable reference — saveFn always exports the current DB (survives backup restore swap)
  const dbRef = { current: db };

  const saveFn = (): void => {
    const data = dbRef.current.export();
    const tmp  = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, DB_FILE);
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSaveFn = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFn, 500);
  };

  const repos = createRepositories(db as any, DB_DIR, saveFn, scheduleSaveFn,
    (newDb) => { dbRef.current = newDb as any; }
  );

  const migration = new MigrationRepository(repos.base, DB_DIR);
  const seedDemo = process.env.SEED_DEMO === 'true';
  await migration.initialise(seedDemo);

  return {
    repos,
    shutdown: () => saveFn(),
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
