/**
 * PgBaseRepository — PostgreSQL implementation of IBaseRepository.
 *
 * Wraps the `pg` module's Pool with the same typed query helpers as the
 * sql.js BaseRepository. Domain repositories are written with SQLite syntax;
 * this class translates SQL on the fly so the same repository code works
 * against both backends.
 *
 * Key translations:
 *   ?                           -> $1, $2, $3 ...
 *   datetime('now')             -> NOW()
 *   datetime('now', ?)          -> NOW() + $n::interval   (param is e.g. '-90 days')
 *   date('now')                 -> CURRENT_DATE
 *   date('now', ?)              -> (CURRENT_DATE + ?::interval)
 *   DATE(expr)                  -> (expr)::date
 *   JULIANDAY('now') - JULIANDAY(expr) -> EXTRACT(epoch FROM (NOW() - (expr)::timestamp)) / 86400
 *   JULIANDAY(expr) - JULIANDAY('now') -> EXTRACT(epoch FROM ((expr)::timestamp - NOW())) / 86400
 *   CAST(expr AS INTEGER)       -> FLOOR(expr)::integer
 *   LIKE                        -> ILIKE
 *   INSERT ... VALUES (...)     -> INSERT ... VALUES (...) RETURNING id  (when no RETURNING already)
 *
 * All methods are async (returning Promises) matching the IBaseRepository contract.
 */

import type { Pool, PoolClient, QueryResult } from 'pg';
import type { IBaseRepository, RunResult } from '../../types/repositories';
import { InternalError } from '../../types/errors';

export class PgBaseRepository implements IBaseRepository {
  /**
   * When non-null, we are inside a transaction and all queries MUST
   * be routed through this dedicated client instead of the pool.
   */
  private _txClient: PoolClient | null = null;

  constructor(private readonly pool: Pool) {}

  // ─── SQL Translation ─────────────────────────────────────────────

  /**
   * Full translation pipeline: SQLite dialect -> PostgreSQL dialect.
   * Returns the translated SQL and (potentially rewritten) params array.
   */
  private _translate(sql: string, params: unknown[] = []): { sql: string; params: unknown[] } {
    let translated = sql;
    const newParams = [...params];

    // 1a. JULIANDAY('now') - JULIANDAY(expr)  ->  EXTRACT(epoch FROM (NOW() - (expr)::timestamp)) / 86400
    translated = translated.replace(
      /JULIANDAY\s*\(\s*'now'\s*\)\s*-\s*JULIANDAY\s*\(([^)]+)\)/gi,
      'EXTRACT(epoch FROM (NOW() - ($1)::timestamp)) / 86400'
    );

    // 1b. JULIANDAY(expr) - JULIANDAY('now')  ->  EXTRACT(epoch FROM ((expr)::timestamp - NOW())) / 86400
    //     Reverse direction (used in purchase payment due-date calculations)
    translated = translated.replace(
      /JULIANDAY\s*\(([^)]+)\)\s*-\s*JULIANDAY\s*\(\s*'now'\s*\)/gi,
      'EXTRACT(epoch FROM (($1)::timestamp - NOW())) / 86400'
    );

    // 2a. CAST(... AS INTEGER) -> FLOOR(...)::integer  (PG needs explicit FLOOR for day calculations)
    translated = translated.replace(
      /CAST\s*\((.+?)\s+AS\s+INTEGER\s*\)/gi,
      'FLOOR($1)::integer'
    );

    // 3a. date('now', ?)  ->  (CURRENT_DATE + ?::interval)
    //     The ? is a bound parameter like '+30 days'. Must run before date('now') and DATE() rules.
    translated = translated.replace(
      /date\s*\(\s*'now'\s*,\s*\?\s*\)/gi,
      '(CURRENT_DATE + ?::interval)'
    );

    // 3b. date('now')  ->  CURRENT_DATE
    //     Used in batch/purchase queries for comparison against date columns.
    translated = translated.replace(
      /date\s*\(\s*'now'\s*\)/gi,
      'CURRENT_DATE'
    );

    // 3c. DATE(expr)  ->  (expr)::date
    //     Used in report queries: DATE(created_at), DATE(t.created_at), etc.
    //     Runs AFTER date('now') rules so those are already consumed.
    translated = translated.replace(
      /\bDATE\s*\(([^)']+)\)/gi,
      '($1)::date'
    );

    // 4. datetime('now', ?)  ->  NOW() + ?::interval
    translated = translated.replace(
      /datetime\s*\(\s*'now'\s*,\s*\?\s*\)/gi,
      '(NOW() + ?::interval)'
    );

    // 5. datetime('now')  ->  NOW()
    //    Must run AFTER the datetime('now', ?) replacement above.
    translated = translated.replace(
      /datetime\s*\(\s*'now'\s*\)/gi,
      'NOW()'
    );

    // 6. LIKE -> ILIKE  (case-insensitive search compatibility)
    translated = translated.replace(/\bLIKE\b/g, 'ILIKE');

    // 5. Convert ? placeholders to $1, $2, $3 ...
    //    Walk through the SQL character by character, tracking whether we're
    //    inside a string literal (single quotes). Only convert unquoted ?.
    const result = this._convertPlaceholders(translated, newParams);

    return result;
  }

  /**
   * Convert SQLite-style `?` positional placeholders to PostgreSQL `$n`
   * numbered placeholders. Correctly skips `?` inside single-quoted strings.
   */
  private _convertPlaceholders(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    let paramIndex = 0;
    let inString = false;
    let result = '';

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];

      if (ch === "'") {
        // Check for escaped quote ('')
        if (inString && i + 1 < sql.length && sql[i + 1] === "'") {
          result += "''";
          i++; // skip the next quote
          continue;
        }
        inString = !inString;
        result += ch;
      } else if (ch === '?' && !inString) {
        paramIndex++;
        result += '$' + paramIndex;
      } else {
        result += ch;
      }
    }

    return { sql: result, params };
  }

  /**
   * Detect INSERT statements and append RETURNING id if not already present.
   * Returns the modified SQL and a flag indicating whether RETURNING was added.
   */
  private _appendReturningId(sql: string): { sql: string; hasReturning: boolean } {
    const trimmed = sql.trim();

    // Only for INSERT statements
    if (!/^INSERT\b/i.test(trimmed)) {
      return { sql, hasReturning: false };
    }

    // Don't add if RETURNING is already present
    if (/\bRETURNING\b/i.test(trimmed)) {
      return { sql, hasReturning: true };
    }

    // Append RETURNING id
    return { sql: trimmed + ' RETURNING id', hasReturning: true };
  }

  // ─── Query Executor ───────────────────────────────────────────────

  /**
   * Returns the active transaction client if inside a transaction,
   * otherwise the pool (which picks an available connection per query).
   */
  private get _executor(): Pool | PoolClient {
    return this._txClient ?? this.pool;
  }

  // ─── IBaseRepository Implementation ───────────────────────────────

  /**
   * Execute a SELECT and return the first row, or undefined if no rows match.
   */
  async getOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const translated = this._translate(sql, params);
    const result: QueryResult = await this._executor.query(
      translated.sql,
      translated.params
    );
    return (result.rows[0] as T) ?? undefined;
  }

  /**
   * Execute a SELECT and return all matching rows.
   */
  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const translated = this._translate(sql, params);
    const result: QueryResult = await this._executor.query(
      translated.sql,
      translated.params
    );
    return result.rows as T[];
  }

  /**
   * Execute a write statement (INSERT/UPDATE/DELETE).
   *
   * For INSERTs: appends RETURNING id to capture the new row's ID.
   * For UPDATE/DELETE: uses rowCount for the changes count.
   *
   * Returns a RunResult matching the sql.js semantics.
   */
  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const translated = this._translate(sql, params);
    const { sql: withReturning, hasReturning } = this._appendReturningId(translated.sql);

    const result: QueryResult = await this._executor.query(withReturning, translated.params);

    let lastInsertRowid = 0;
    if (hasReturning && result.rows.length > 0) {
      lastInsertRowid = result.rows[0].id as number;
    }

    const changes = result.rowCount ?? 0;

    return { lastInsertRowid, changes };
  }

  /**
   * Same as run() for PostgreSQL — there is no buffered/scheduled save
   * distinction since PostgreSQL auto-persists.
   */
  async runImmediate(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.run(sql, params);
  }

  /**
   * Execute a callback inside a database transaction.
   *
   * Acquires a dedicated client from the pool and sets it as the active
   * transaction client. All queries issued by `fn()` (via getOne, getAll,
   * run, etc.) will be routed through this client.
   *
   * On success: COMMIT.
   * On failure: ROLLBACK, then rethrow.
   * Always: release the client back to the pool.
   */
  async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this._txClient) {
      // Already inside a transaction — just execute fn() without nesting.
      // PostgreSQL doesn't support true nested transactions without SAVEPOINTs,
      // and the sql.js BaseRepository also doesn't nest. So we run inline.
      return fn();
    }

    const client = await this.pool.connect();
    this._txClient = client;

    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[PgBaseRepository] ROLLBACK failed:', (rollbackError as Error).message);
        console.error('[PgBaseRepository] Original error:', (error as Error).message);
        throw new InternalError(
          `Transaction failed with rollback error. ` +
          `Original: ${(error as Error).message}. ` +
          `Rollback: ${(rollbackError as Error).message}.`
        );
      }
      throw error;
    } finally {
      this._txClient = null;
      client.release();
    }
  }

  /**
   * Run an INSERT and return the new row's ID.
   * Appends RETURNING id to the INSERT if not already present.
   */
  async runReturningId(sql: string, params: unknown[] = []): Promise<number> {
    const translated = this._translate(sql, params);
    const { sql: withReturning } = this._appendReturningId(translated.sql);

    const result: QueryResult = await this._executor.query(withReturning, translated.params);

    if (result.rows.length === 0) {
      throw new InternalError('runReturningId: INSERT did not return a row ID');
    }

    return result.rows[0].id as number;
  }

  /**
   * Run an UPDATE or DELETE and return the number of affected rows.
   */
  async runAndGetChanges(sql: string, params: unknown[] = []): Promise<number> {
    const translated = this._translate(sql, params);
    const result: QueryResult = await this._executor.query(
      translated.sql,
      translated.params
    );
    return result.rowCount ?? 0;
  }

  // ─── Extra Methods (Migration / Backup / Seeding) ─────────────────

  /**
   * Execute raw SQL with no parameters and no return value.
   * Used for DDL statements (CREATE TABLE, etc.) and multi-statement scripts.
   */
  async exec(sql: string): Promise<void> {
    await this._executor.query(sql);
  }

  /**
   * Execute a parameterised SQL statement with no return value.
   * Used for schema setup and bulk seeding where the result is not needed.
   */
  async rawRun(sql: string, params: unknown[] = []): Promise<void> {
    const translated = this._translate(sql, params);
    await this._executor.query(translated.sql, translated.params);
  }

  /**
   * Execute an INSERT without tracking save (no-op distinction for PG)
   * and return the new row's ID. Used for bulk seeding.
   */
  async rawRunReturningId(sql: string, params: unknown[] = []): Promise<number> {
    const translated = this._translate(sql, params);
    const { sql: withReturning } = this._appendReturningId(translated.sql);

    const result: QueryResult = await this._executor.query(withReturning, translated.params);

    if (result.rows.length === 0) {
      throw new InternalError('rawRunReturningId: INSERT did not return a row ID');
    }

    return result.rows[0].id as number;
  }

  /**
   * No-op for PostgreSQL. The sql.js backend uses this to persist the
   * in-memory database to disk. PostgreSQL auto-persists all committed writes.
   */
  save(): void {
    // No-op — PostgreSQL auto-persists
  }
}
