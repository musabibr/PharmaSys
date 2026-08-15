import { AuditListener } from '@core/events/audit.listener';
import { EventBus } from '@core/events/event-bus';
import type { IAuditRepository, IBaseRepository } from '@core/types/repositories';

function createAuditRepo(): jest.Mocked<Pick<IAuditRepository, 'log'>> {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

/** A minimal fake mirroring BaseRepository's runAfterCommit semantics for
 *  this test: immediate when `open` is false, queued while `open` is true. */
function createFakeBase() {
  let open = false;
  const queue: Array<() => void | Promise<void>> = [];
  return {
    runAfterCommit: jest.fn((cb: () => void | Promise<void>) => {
      if (open) queue.push(cb); else cb();
    }),
    openTx() { open = true; },
    commit() { open = false; while (queue.length) queue.shift()!(); },
  };
}

describe('AuditListener', () => {
  it('writes immediately when no base repository is supplied (legacy fire-and-forget)', async () => {
    const bus = new EventBus();
    const auditRepo = createAuditRepo();
    new AuditListener(bus, auditRepo as unknown as IAuditRepository);

    bus.emit('entity:mutated', {
      action: 'CREATE_PRODUCT', table: 'products', recordId: 1, userId: 1,
      newValues: { name: 'Test' },
    });

    // fire-and-forget resolves on a microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(auditRepo.log).toHaveBeenCalledWith(1, 'CREATE_PRODUCT', 'products', 1, null, { name: 'Test' });
  });

  it('defers the write via runAfterCommit when a base repository is supplied (F3)', async () => {
    const bus = new EventBus();
    const auditRepo = createAuditRepo();
    const fakeBase = createFakeBase();
    new AuditListener(bus, auditRepo as unknown as IAuditRepository, fakeBase as unknown as IBaseRepository);

    fakeBase.openTx();
    bus.emit('entity:mutated', {
      action: 'UPDATE_PRODUCT', table: 'products', recordId: 1, userId: 1,
      newValues: { name: 'Renamed' },
    });

    // Still inside the "transaction" — the write must not have happened yet.
    expect(auditRepo.log).not.toHaveBeenCalled();

    fakeBase.commit();
    await Promise.resolve();
    await Promise.resolve();

    expect(auditRepo.log).toHaveBeenCalledWith(1, 'UPDATE_PRODUCT', 'products', 1, null, { name: 'Renamed' });
  });
});
