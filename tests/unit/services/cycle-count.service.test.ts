import { CycleCountService } from '@core/services/cycle-count.service';

/**
 * Stock-integrity coverage for product-level stock-count completion.
 * On complete, the counted product total is reconciled against the batches' CURRENT
 * quantities (not the start snapshot): shortages come off the oldest-expiry batch first,
 * and each per-batch change is recorded as a correction adjustment so the reconciliation
 * ledger stays in sync with actual stock.
 */
function makeService(cc: any, batches: any[]) {
  const repo = {
    getById: jest.fn().mockResolvedValue(cc),
    inTransaction: jest.fn(async (fn: () => Promise<unknown>) => await fn()),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const batchRepo = {
    getBatchesForProducts: jest.fn().mockResolvedValue(batches),
    updateQuantityOptimistic: jest.fn().mockResolvedValue(true),
    insertAdjustment: jest.fn().mockResolvedValue(undefined),
  };
  const bus = { emit: jest.fn() };
  const svc = new CycleCountService(repo as any, batchRepo as any, bus as any);
  return { svc, repo, batchRepo, bus };
}

describe('CycleCountService.complete — product-level stock integrity', () => {
  it('distributes a product shortage onto the oldest-expiry batch and records the adjustment from CURRENT stock', async () => {
    // Count started at total 100; counted 88. But a sale during the count left the product at 90.
    const cc = {
      id: 1, name: 'CC1', status: 'in_progress',
      items: [{ id: 10, status: 'counted', product_id: 2, batch_id: null, counted_quantity: 88, expected_quantity: 100 }],
    };
    const batches = [
      { id: 5, product_id: 2, quantity_base: 90, status: 'active', version: 1, expiry_date: '2026-03-01' },
    ];
    const { svc, batchRepo } = makeService(cc, batches);

    await svc.complete(1, true, 99);

    // 90 current − 88 counted = remove 2 from the oldest batch
    expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(5, 88, 'active', 1);
    expect(batchRepo.insertAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ batch_id: 5, product_id: 2, quantity_base: 2, type: 'correction' }),
    );
  });

  it('removes a shortage across multiple batches oldest-first', async () => {
    const cc = {
      id: 1, name: 'CC1', status: 'in_progress',
      items: [{ id: 10, status: 'counted', product_id: 2, batch_id: null, counted_quantity: 30, expected_quantity: 50 }],
    };
    const batches = [
      { id: 5, product_id: 2, quantity_base: 10, status: 'active', version: 1, expiry_date: '2026-03-01' },
      { id: 6, product_id: 2, quantity_base: 40, status: 'active', version: 1, expiry_date: '2026-09-01' },
    ];
    const { svc, batchRepo } = makeService(cc, batches);

    await svc.complete(1, true, 99); // total 50 → counted 30 → remove 20: all 10 from B5, 10 from B6

    expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(5, 0, 'sold_out', 1);
    expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(6, 30, 'active', 1);
  });

  it('does nothing when the counted total already matches current stock', async () => {
    const cc = {
      id: 1, name: 'CC1', status: 'in_progress',
      items: [{ id: 10, status: 'counted', product_id: 2, batch_id: null, counted_quantity: 50, expected_quantity: 55 }],
    };
    const batches = [{ id: 5, product_id: 2, quantity_base: 50, status: 'active', version: 1, expiry_date: '2026-03-01' }];
    const { svc, batchRepo } = makeService(cc, batches);

    await svc.complete(1, true, 99);

    expect(batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    expect(batchRepo.insertAdjustment).not.toHaveBeenCalled();
  });
});
