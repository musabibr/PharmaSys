/**
 * BaseRepository — wraps sql.js Database with typed query helpers.
 * All domain repositories are composed with a shared BaseRepository instance
 * so they all operate on the same connection and participate in the same
 * BEGIN/COMMIT transaction block.
 *
 * All methods are async (Promise-returning) to support swapping to an async
 * backend like PostgreSQL. Since sql.js is synchronous under the hood,
 * the Promises resolve immediately.
 */

import type { IBaseRepository, RunResult } from '../../types/repositories';
import { InternalError } from '../../types/errors';

// Minimal sql.js interfaces (no @types/sql.js available)
export interface SqlJsStatement {
  bind(params?: unknown[]): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
  reset(): void;
}

export interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

export class BaseRepository implements IBaseRepository {
  private _txDepth = 0;

  constructor(
    public readonly db: SqlJsDatabase,
    private readonly saveFn: () => void,
    private readonly scheduleSaveFn: () => void
  ) {}

  /** Read last_insert_rowid and changes() after a write operation. */
  private _readLastResult(): RunResult {
    const lastId = this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] as number || 0;
    const changes = this.db.exec('SELECT changes()')[0]?.values[0]?.[0] as number || 0;
    return { lastInsertRowid: lastId, changes };
  }

  async getOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let row: T | undefined;
    if (stmt.step()) {
      row = stmt.getAsObject() as T;
    }
    stmt.free();
    return row;
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    this.db.run(sql, params);
    const result = this._readLastResult();
    this.scheduleSaveFn();
    return result;
  }

  async runImmediate(sql: string, params: unknown[] = []): Promise<RunResult> {
    this.db.run(sql, params);
    const result = this._readLastResult();
    // Skip immediate save when inside a transaction — inTransaction() saves on COMMIT
    if (this._txDepth === 0) {
      this.saveFn();
    } else {
      this.scheduleSaveFn();
    }
    return result;
  }

  async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this._txDepth++;
    if (this._txDepth === 1) {
      this.db.run('BEGIN TRANSACTION');
    }
    try {
      const result = await fn();
      this._txDepth--;
      if (this._txDepth === 0) {
        this.db.run('COMMIT');
        this.saveFn();
      }
      return result;
    } catch (error) {
      this._txDepth--;
      if (this._txDepth === 0) {
        try {
          this.db.run('ROLLBACK');
        } catch (rollbackError) {
          console.error('[BaseRepository] ROLLBACK failed:', (rollbackError as Error).message);
          console.error('[BaseRepository] Original error:', (error as Error).message);
          throw new InternalError(
            `Transaction failed with rollback error. ` +
            `Original: ${(error as Error).message}. ` +
            `Rollback: ${(rollbackError as Error).message}.`
          );
        }
      }
      throw error;
    }
  }

  /** Run an INSERT and return the new row's ID. */
  async runReturningId(sql: string, params: unknown[] = []): Promise<number> {
    this.db.run(sql, params);
    const { lastInsertRowid } = this._readLastResult();
    this.scheduleSaveFn();
    return lastInsertRowid as number;
  }

  /** Run an UPDATE/DELETE and return the number of affected rows. */
  async runAndGetChanges(sql: string, params: unknown[] = []): Promise<number> {
    this.db.run(sql, params);
    const { changes } = this._readLastResult();
    this.scheduleSaveFn();
    return changes;
  }

  /** Execute raw SQL (no params, no save). For schema / migration use. */
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /** Execute a raw run without tracking save. For schema use. */
  async rawRun(sql: string, params: unknown[] = []): Promise<void> {
    this.db.run(sql, params);
  }

  /** Run an INSERT without scheduling a save; return new row ID. For bulk seeding use. */
  async rawRunReturningId(sql: string, params: unknown[] = []): Promise<number> {
    this.db.run(sql, params);
    return this._readLastResult().lastInsertRowid as number;
  }

  save(): void {
    this.saveFn();
  }
}
