/**
 * BaseRepository — wraps better-sqlite3 Database with typed query helpers.
 * All domain repositories are composed with a shared BaseRepository instance
 * so they all operate on the same connection and participate in the same
 * BEGIN/COMMIT transaction block.
 *
 * better-sqlite3 writes directly to disk on every COMMIT (WAL mode).
 * There is NO in-memory buffer, NO periodic flush, and NO data-loss window.
 * If a transaction commits, the data is guaranteed on disk.
 *
 * All methods are async (Promise-returning) to maintain API compatibility
 * with the rest of the codebase and to support future async backends.
 */

import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'async_hooks';
import type { IBaseRepository, RunResult } from '../../types/repositories';
import { InternalError } from '../../types/errors';

// Re-export for consumers that need the type
export type BetterDatabase = Database.Database;

export class BaseRepository implements IBaseRepository {
  public db: BetterDatabase;
  private readonly dbPath: string;

  /**
   * Serial transaction queue. Each inTransaction() chains onto this so transactions
   * never interleave — even though better-sqlite3 is synchronous, our interface is
   * async so callers may await between calls.
   */
  private _txQueue: Promise<unknown> = Promise.resolve();

  /**
   * True while a BEGIN...COMMIT/ROLLBACK is open on `this.db`. All repositories
   * share one connection, so a plain run()/rawRun() call issued while *any*
   * transaction is open would otherwise silently join that transaction and be
   * committed or rolled back with it — e.g. an audit-listener write firing
   * between two awaits inside createSale's transaction gets discarded if the
   * sale retries after a ConflictError (audit finding F1). Write methods
   * check this flag and wait for the queue instead of writing directly.
   */
  private _txActive = false;

  /**
   * Tags the async call chain currently executing inside a transaction's own
   * callback, so nested inTransaction() calls — and any run()/rawRun() calls
   * made by services invoked from within that callback — can tell "I am part
   * of the open transaction" apart from "a transaction is open, but it isn't
   * mine". Without this distinction, a nested inTransaction() call would
   * queue behind the outer transaction's completion promise, which can only
   * resolve after the nested call returns: a guaranteed deadlock (F2).
   */
  private readonly _txContext = new AsyncLocalStorage<true>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async getOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Await any *foreign* in-flight transaction before writing (F1). A call
   * made from within the active transaction's own callback (same
   * AsyncLocalStorage context) is not foreign — it's part of that unit of
   * work, so it proceeds immediately without waiting on itself.
   */
  private async _awaitForeignTx(): Promise<void> {
    if (this._txActive && !this._txContext.getStore()) {
      await this._txQueue.catch(() => { /* prior tx errors are not ours */ });
    }
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    await this._awaitForeignTx();
    const result = this.db.prepare(sql).run(...params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: result.changes,
    };
  }

  async runImmediate(sql: string, params: unknown[] = []): Promise<RunResult> {
    // With better-sqlite3, every write is immediate (disk-backed).
    // No difference from run() — kept for API compatibility.
    return this.run(sql, params);
  }

  async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // F2: a call nested inside an already-open transaction's own callback
    // must NOT queue — queueing would wait on the outer transaction's
    // completion promise, which can only resolve after this nested call
    // returns. Join the outer transaction instead: run fn() inline, with no
    // new BEGIN/COMMIT (the outer call owns those and will commit/roll back
    // whatever this nested call did as part of the same unit of work).
    if (this._txContext.getStore()) {
      return await fn();
    }

    // Wait for any in-flight transaction to fully commit/rollback
    const prev = this._txQueue.catch(() => { /* prior tx errors are not ours */ });
    let releaseQueue!: () => void;
    const done = new Promise<void>((resolve) => { releaseQueue = resolve; });
    this._txQueue = done;
    await prev;

    this._txActive = true;
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = await this._txContext.run(true, () => fn());
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('[BaseRepository] ROLLBACK failed:', (rollbackError as Error).message);
        console.error('[BaseRepository] Original error:', (error as Error).message);
        throw new InternalError(
          `Transaction failed with rollback error. ` +
          `Original: ${(error as Error).message}. ` +
          `Rollback: ${(rollbackError as Error).message}.`
        );
      }
      throw error;
    } finally {
      this._txActive = false;
      releaseQueue();
    }
  }

  /** Run an INSERT and return the new row's ID. */
  async runReturningId(sql: string, params: unknown[] = []): Promise<number> {
    await this._awaitForeignTx();
    const result = this.db.prepare(sql).run(...params);
    return Number(result.lastInsertRowid);
  }

  /** Run an UPDATE/DELETE and return the number of affected rows. */
  async runAndGetChanges(sql: string, params: unknown[] = []): Promise<number> {
    await this._awaitForeignTx();
    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  /** Execute raw SQL (no params, no save). For schema / migration use. */
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /** Execute a raw run without tracking save. For schema use. */
  async rawRun(sql: string, params: unknown[] = []): Promise<void> {
    await this._awaitForeignTx();
    if (params.length === 0) {
      this.db.exec(sql);
    } else {
      this.db.prepare(sql).run(...params);
    }
  }

  /** Run an INSERT without scheduling a save; return new row ID. For bulk seeding use. */
  async rawRunReturningId(sql: string, params: unknown[] = []): Promise<number> {
    await this._awaitForeignTx();
    const result = this.db.prepare(sql).run(...params);
    return Number(result.lastInsertRowid);
  }

  /**
   * No-op with better-sqlite3 — data is already on disk after every COMMIT.
   * Kept for API compatibility (callers like backup.create() call this).
   */
  save(): Promise<void> {
    return Promise.resolve();
  }

  /** Close and reopen the database (used after backup restore replaces the file). */
  replaceDb(): void {
    try { this.db.close(); } catch { /* already closed */ }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /** Close the database connection. */
  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
