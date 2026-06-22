import { CycleCountService } from '@core/services/cycle-count.service';

/**
 * Regression coverage for stock-integrity in cycle-count completion.
 * The adjustment must be derived from the batch's CURRENT quantity at apply time,
 * not from the variance snapshotted when the count was started — otherwise a sale
 * that happens mid-count desyncs the reconciliation ledger from actual stock.
 */
function makeService(cc: any, batch: any) {
  const repo = {
    getById: jest.fn().mockResolvedValue(cc),
    inTransaction: jest.fn(async (fn: () => Promise<unknown>) => await fn()),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const batchRepo = {
    getById: jest.fn().mockResolvedValue(batch),
    updateQuantityOptimistic: jest.fn().mockResolvedValue(true),
    insertAdjustment: jest.fn().mockResolvedValue(undefined),
  };
  const bus = { emit: jest.fn() };
  const svc = new CycleCountService(repo as any, batchRepo as any, bus as any);
  return { svc, repo, batchRepo, bus };
}

describe('CycleCountService.complete — stock integrity', () => {
  it('sets the batch to the counted quantity and records the adjustment from the CURRENT quantity', async () => {
    // Count started when the batch held 100; expected_quantity=100, counted=88 → snapshot variance=-12.
    // But a sale of 10 happened mid-count, so the batch is now 90. The real loss is only 2.
    const cc = {
      id: 1, name: 'CC1', status: 'in_progress',
      items: [{
        id: 10, status: 'counted', batch_id: 5, product_id: 2,
        counted_quantity: 88, variance: -12, expected_quantity: 100,
      }],
    };
    const batch = { id: 5, product_id: 2, quantity_base: 90, status: 'active', version: 1 };
    const { svc, batchRepo } = makeService(cc, batch);

    await svc.complete(1, true, 99);

    // Batch is set to the physical count
    expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(5, 88, 'active', 1);
    // Adjustment reflects the REAL delta (90 current − 88 counted = 2 removed), not -(-12)=12
    expect(batchRepo.insertAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ batch_id: 5, quantity_base: 2, type: 'correction' }),
    );
  });

  it('skips items whose current quantity already equals the count (no spurious adjustment)', async () => {
    const cc = {
      id: 1, name: 'CC1', status: 'in_progress',
      items: [{
        id: 10, status: 'counted', batch_id: 5, product_id: 2,
        counted_quantity: 50, variance: -5, expected_quantity: 55,
      }],
    };
    const batch = { id: 5, product_id: 2, quantity_base: 50, status: 'active', version: 1 };
    const { svc, batchRepo } = makeService(cc, batch);

    await svc.complete(1, true, 99);

    expect(batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    expect(batchRepo.insertAdjustment).not.toHaveBeenCalled();
  });
});
