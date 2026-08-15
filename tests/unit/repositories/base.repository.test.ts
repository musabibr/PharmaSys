/**
 * BaseRepository transaction-concurrency tests (audit F1/F2).
 *
 * These exercise pure control flow (the serial queue + AsyncLocalStorage
 * re-entrancy tracking), not real SQL — better-sqlite3 is mocked out
 * entirely so this can run under plain Node/Jest (the real native binding
 * is built for Electron's ABI and can't load here; see
 * tests/helpers/test-db.ts and jest.config.js).
 */

// A minimal fake standing in for better-sqlite3's Database. It doesn't
// interpret SQL at all — every call is just recorded in `calls` so tests can
// assert ordering.
class FakeStatement {
  constructor(private readonly db: FakeDatabase, private readonly sql: string) {}
  run(...params: unknown[]) {
    this.db.calls.push({ type: 'run', sql: this.sql, params });
    return { lastInsertRowid: 1, changes: 1 };
  }
  get(..._params: unknown[]) { return undefined; }
  all(..._params: unknown[]) { return []; }
}

class FakeDatabase {
  calls: Array<{ type: string; sql: string; params?: unknown[] }> = [];
  prepare(sql: string) { return new FakeStatement(this, sql); }
  exec(sql: string) { this.calls.push({ type: 'exec', sql }); }
  pragma(_s: string) { /* no-op */ }
  close() { /* no-op */ }
}

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => new FakeDatabase());
});

import { BaseRepository } from '@core/repositories/sql/base.repository';

function createRepo(): BaseRepository {
  return new BaseRepository(':memory:');
}

describe('BaseRepository transaction concurrency', () => {
  it('runs sequential inTransaction calls one after another, never interleaved', async () => {
    const repo = createRepo();
    const order: string[] = [];

    const t1 = repo.inTransaction(async () => {
      order.push('t1-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('t1-end');
      return 1;
    });
    const t2 = repo.inTransaction(async () => {
      order.push('t2-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('t2-end');
      return 2;
    });

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(['t1-start', 't1-end', 't2-start', 't2-end']);
  });

  it('does not deadlock on a nested inTransaction call — joins the outer transaction (F2)', async () => {
    const repo = createRepo();
    const order: string[] = [];

    const outer = repo.inTransaction(async () => {
      order.push('outer-start');
      const innerResult = await repo.inTransaction(async () => {
        order.push('inner');
        return 'inner-result';
      });
      order.push('outer-end');
      return innerResult;
    });

    // Previously this would hang forever — race against a short timeout so a
    // regression fails fast instead of hanging the whole suite. Clear the
    // timer either way so it doesn't keep the process alive after the test.
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('deadlock timeout')), 2000);
    });
    const result = await Promise.race([outer, timeout]);
    clearTimeout(timeoutHandle);

    expect(result).toBe('inner-result');
    expect(order).toEqual(['outer-start', 'inner', 'outer-end']);
  });

  it('a write from inside the transaction executes immediately, without waiting on itself', async () => {
    const repo = createRepo();
    const result = await repo.inTransaction(async () => {
      return await repo.run('INSERT INTO x VALUES (1)');
    });
    expect(result.changes).toBe(1);
  });

  it('a foreign write waits for the open transaction to finish instead of joining it (F1)', async () => {
    const repo = createRepo();
    const order: string[] = [];
    let releaseTx!: () => void;
    const holdOpen = new Promise<void>((resolve) => { releaseTx = resolve; });

    const txPromise = repo.inTransaction(async () => {
      order.push('tx-start');
      await holdOpen;
      order.push('tx-end');
      return 'tx-result';
    });

    // Let inTransaction actually acquire the queue and call BEGIN.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['tx-start']);

    const foreignWrite = repo.run('INSERT INTO y VALUES (1)').then(() => {
      order.push('foreign-write');
    });

    // The foreign write must not have run yet — the transaction is still open.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['tx-start']);

    releaseTx();
    await Promise.all([txPromise, foreignWrite]);

    expect(order).toEqual(['tx-start', 'tx-end', 'foreign-write']);
  });
});
