import { BatchService } from '@core/services/batch.service';
import { ValidationError, NotFoundError, ConflictError, BusinessRuleError } from '@core/types/errors';
import {
  createMockBatchRepo, createMockProductRepo, createMockBus,
  sampleBatch, sampleProduct, runResult,
} from '../../helpers/mocks';

function createService() {
  const batchRepo   = createMockBatchRepo();
  const productRepo = createMockProductRepo();
  const bus         = createMockBus();
  const svc         = new BatchService(batchRepo as any, productRepo as any, bus);
  return { svc, batchRepo, productRepo, bus };
}

const createInput = {
  product_id: 1,
  batch_number: 'B001',
  expiry_date: '2027-12-31',
  quantity_base: 200,
  cost_per_parent: 5000,
  selling_price_parent: 8000,
} as any;

describe('BatchService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getByProduct / getById / getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getByProduct', () => {
    it('delegates to repo', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getByProduct.mockResolvedValue([sampleBatch]);
      expect(await svc.getByProduct(1)).toHaveLength(1);
      expect(batchRepo.getByProduct).toHaveBeenCalledWith(1);
    });

    it('throws ValidationError for invalid product id', async () => {
      const { svc } = createService();
      await expect(svc.getByProduct(0)).rejects.toThrow(ValidationError);
    });
  });

  describe('getById', () => {
    it('returns batch when found', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(sampleBatch);
      expect(await svc.getById(1)).toEqual(sampleBatch);
    });

    it('throws NotFoundError when batch does not exist', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(99)).rejects.toThrow(NotFoundError);
    });
  });

  describe('getAll', () => {
    it('delegates to repo', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getAll.mockResolvedValue([sampleBatch]);
      const result = await svc.getAll();
      expect(batchRepo.getAll).toHaveBeenCalledWith({});
      expect(result).toHaveLength(1);
    });

    it('passes filters to repo', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getAll.mockResolvedValue([]);
      await svc.getAll({ status: 'active' } as any);
      expect(batchRepo.getAll).toHaveBeenCalledWith({ status: 'active' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('creates batch and returns it', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      batchRepo.create.mockResolvedValue(runResult(3));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      const result = await svc.create(createInput, 1);
      expect(batchRepo.create).toHaveBeenCalled();
      expect(result.batch_number).toBe('B001');
    });

    it('throws NotFoundError when product does not exist', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(undefined);
      await expect(svc.create(createInput, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid expiry date format', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      await expect(svc.create({ ...createInput, expiry_date: '12-31-2027' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for zero quantity', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      await expect(svc.create({ ...createInput, quantity_base: 0 }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for negative cost', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      await expect(svc.create({ ...createInput, cost_per_parent: -100 }, 1)).rejects.toThrow(ValidationError);
    });

    it('auto-calculates child cost from parent when no override', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue({ ...sampleProduct, conversion_factor: 20 });
      batchRepo.create.mockResolvedValue(runResult(1));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      await svc.create({ ...createInput, cost_per_parent: 5000 }, 1);
      // 5000 / 20 = 250 (floor)
      expect(batchRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        cost_per_child_override: 250,
      }));
    });

    it('emits entity:mutated event on create', async () => {
      const { svc, batchRepo, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      batchRepo.create.mockResolvedValue(runResult(1));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      await svc.create(createInput, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_BATCH',
      }));
    });

    // ─── B7: past/blank expiry ─────────────────────────────────────────
    it('accepts a past expiry date (recording stock you already own)', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      batchRepo.create.mockResolvedValue(runResult(1));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      await expect(svc.create({ ...createInput, expiry_date: '2020-01-01' }, 1)).resolves.toBeDefined();
    });

    it('creates a batch with a past expiry as quarantine, not active (B7)', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      batchRepo.create.mockResolvedValue(runResult(1));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      await svc.create({ ...createInput, expiry_date: '2020-01-01' }, 1);
      expect(batchRepo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'quarantine' }));
    });

    it('creates a batch with a future expiry as active', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      batchRepo.create.mockResolvedValue(runResult(1));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      await svc.create({ ...createInput, expiry_date: '2099-06-30' }, 1);
      expect(batchRepo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // update
  // ═══════════════════════════════════════════════════════════════════════════
  describe('update', () => {
    it('updates batch and returns updated data', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById
        .mockResolvedValueOnce(sampleBatch)
        .mockResolvedValue({ ...sampleBatch, selling_price_parent: 9000 });

      const result = await svc.update(1, { selling_price_parent: 9000 } as any, 1);
      expect(batchRepo.update).toHaveBeenCalledWith(1, sampleBatch.version, expect.any(Object));
      expect(result.selling_price_parent).toBe(9000);
    });

    it('throws NotFoundError when batch does not exist', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(undefined);
      await expect(svc.update(99, {} as any, 1)).rejects.toThrow(NotFoundError);
    });

    it('re-activates a sold_out batch when quantity is restocked above zero', async () => {
      const { svc, batchRepo } = createService();
      const soldOut = { ...sampleBatch, status: 'sold_out' as const, quantity_base: 0 };
      batchRepo.getById.mockResolvedValue(soldOut);
      await svc.update(1, { quantity_base: 50, reason: 'Restocked' } as any, 1);
      expect(batchRepo.update).toHaveBeenCalledWith(
        1, soldOut.version,
        expect.objectContaining({ quantity_base: 50, status: 'active' }),
      );
    });

    it('marks an active batch sold_out when quantity drops to zero', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, status: 'active', quantity_base: 100 });
      await svc.update(1, { quantity_base: 0, reason: 'Sold out physically' } as any, 1);
      expect(batchRepo.update).toHaveBeenCalledWith(
        1, sampleBatch.version,
        expect.objectContaining({ quantity_base: 0, status: 'sold_out' }),
      );
    });

    it('throws ConflictError on version mismatch', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(sampleBatch); // version: 1
      await expect(svc.update(1, { version: 999 } as any, 1)).rejects.toThrow(ConflictError);
    });

    it('emits entity:mutated event on update', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getById.mockResolvedValue(sampleBatch);
      await svc.update(1, {} as any, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_BATCH',
      }));
    });

    it('allows cost_per_parent change even after sales (cost edits are no longer blocked)', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById
        .mockResolvedValueOnce(sampleBatch)
        .mockResolvedValue({ ...sampleBatch, cost_per_parent: 9999 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 200, txn_count: 3, adj_count: 0 });
      const result = await svc.update(1, { cost_per_parent: 9999 } as any, 1);
      expect(result.cost_per_parent).toBe(9999);
    });

    it('records a correction adjustment when the quantity is edited (audit + reconciliation)', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById
        .mockResolvedValueOnce({ ...sampleBatch, quantity_base: 200 })
        .mockResolvedValue({ ...sampleBatch, quantity_base: 180 });
      await svc.update(1, { quantity_base: 180, reason: 'Physical recount' } as any, 1);
      // 200 current − 180 new = 20 removed
      expect(batchRepo.insertAdjustment).toHaveBeenCalledWith(expect.objectContaining({
        batch_id: 1, quantity_base: 20, type: 'correction', reason: 'Physical recount',
      }));
    });

    it('throws ValidationError when quantity changes without a reason (B5)', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 200 });
      await expect(svc.update(1, { quantity_base: 180 } as any, 1)).rejects.toThrow(ValidationError);
    });

    it('does not require a reason when quantity is unchanged', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 200 });
      await expect(svc.update(1, { quantity_base: 200, batch_number: 'NEW-001' } as any, 1)).resolves.toBeDefined();
    });

    it('allows cost_per_parent change when batch has no sales', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById
        .mockResolvedValueOnce(sampleBatch)
        .mockResolvedValue({ ...sampleBatch, cost_per_parent: 600 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 200, txn_count: 0, adj_count: 0 });
      const result = await svc.update(1, { cost_per_parent: 600 } as any, 1);
      expect(batchRepo.update).toHaveBeenCalled();
      expect(result.cost_per_parent).toBe(600);
    });

    it('auto-recalculates child cost when cost_per_parent changes', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById
        .mockResolvedValueOnce({ ...sampleBatch, conversion_factor: 20 })
        .mockResolvedValue({ ...sampleBatch, cost_per_parent: 6000 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 200, txn_count: 0, adj_count: 0 });
      await svc.update(1, { cost_per_parent: 6000 } as any, 1);
      // 6000 / 20 = 300
      expect(batchRepo.update).toHaveBeenCalledWith(1, sampleBatch.version, expect.objectContaining({
        cost_per_child: 300,
      }));
    });

    it('auto-recalculates child selling price when selling_price_parent_override changes', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById
        .mockResolvedValueOnce({ ...sampleBatch, conversion_factor: 20 })
        .mockResolvedValue(sampleBatch);
      await svc.update(1, { selling_price_parent_override: 1000 } as any, 1);
      // 1000 / 20 = 50
      expect(batchRepo.update).toHaveBeenCalledWith(1, sampleBatch.version, expect.objectContaining({
        selling_price_child: 50,
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // reportDamage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('reportDamage', () => {
    it('deducts damaged quantity; remaining stock keeps its previous status', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 200 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      // Damaged units are removed from stock — the rest of the batch is still
      // sellable, so it stays 'active' (only drops to 'sold_out' at zero).
      await svc.reportDamage(1, 10, 'broken vials', 'damage', 1);
      expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 190, 'active', 1
      );
    });

    it('sets status to sold_out when quantity reaches 0', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 10 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reportDamage(1, 10, null, 'damage', 1);
      expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 0, 'sold_out', 1
      );
    });

    it('sets status to active for correction type', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 200 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reportDamage(1, 10, null, 'correction', 1);
      expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 190, 'active', 1
      );
    });

    it('throws ValidationError when deduction exceeds available quantity', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 5 });
      await expect(svc.reportDamage(1, 10, null, 'damage', 1)).rejects.toThrow(ValidationError);
    });

    it('throws ConflictError on optimistic lock failure', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 100 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(false);
      await expect(svc.reportDamage(1, 10, null, 'damage', 1)).rejects.toThrow(ConflictError);
    });

    it('throws NotFoundError when batch does not exist', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(undefined);
      await expect(svc.reportDamage(99, 10, null, 'damage', 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid adjustment type', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(sampleBatch);
      await expect(svc.reportDamage(1, 10, null, 'invalid' as any, 1)).rejects.toThrow(ValidationError);
    });

    it('inserts adjustment record', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 100 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reportDamage(1, 5, 'expired', 'expiry', 1);
      expect(batchRepo.insertAdjustment).toHaveBeenCalledWith(expect.objectContaining({
        batch_id: 1, quantity_base: 5, type: 'expiry',
      }));
    });

    it('emits entity:mutated and stock:changed events', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 100 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reportDamage(1, 10, null, 'damage', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'REPORT_DAMAGE',
      }));
      expect(bus.emit).toHaveBeenCalledWith('stock:changed', expect.objectContaining({
        batchId: 1, previousQuantity: 100, newQuantity: 90,
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getExpiring / getExpired
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getExpiring', () => {
    it('delegates to repo with clamped days', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getExpiring.mockResolvedValue([sampleBatch]);
      await svc.getExpiring(30);
      expect(batchRepo.getExpiring).toHaveBeenCalledWith(30);
    });

    it('clamps days to minimum 1', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getExpiring.mockResolvedValue([]);
      await svc.getExpiring(0);
      expect(batchRepo.getExpiring).toHaveBeenCalledWith(1);
    });

    it('clamps days to maximum 365', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getExpiring.mockResolvedValue([]);
      await svc.getExpiring(999);
      expect(batchRepo.getExpiring).toHaveBeenCalledWith(365);
    });
  });

  describe('getExpired', () => {
    it('returns expired batches', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getExpired.mockResolvedValue([sampleBatch]);
      expect(await svc.getExpired()).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // updateSellingPricesByProduct
  // ═══════════════════════════════════════════════════════════════════════════
  describe('updateSellingPricesByProduct', () => {
    it('computes base child price from product CF and passes to repo', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue({ ...sampleProduct, conversion_factor: 10 });
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(3);
      await svc.updateSellingPricesByProduct(1, 5000, null, 1);
      // base child = floor(5000 / 10) = 500; preserveOverrides = false so the
      // new price actually reaches the till (overrides win in FIFO otherwise — D1).
      expect(batchRepo.bulkUpdateSellingPrices).toHaveBeenCalledWith(1, 5000, 500, null, false);
    });

    it('emits event when batches are updated', async () => {
      const { svc, batchRepo, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(2);
      await svc.updateSellingPricesByProduct(1, 8000, null, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'BULK_UPDATE_BATCH_PRICES',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // create — base child price population
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create — child price auto-calculation', () => {
    it('passes both base and override child prices to repo', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue({ ...sampleProduct, conversion_factor: 10 });
      batchRepo.create.mockResolvedValue(runResult(1));
      batchRepo.getById.mockResolvedValue(sampleBatch);

      await svc.create({ ...createInput, cost_per_parent: 5000, selling_price_parent: 8000 } as any, 1);
      expect(batchRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        cost_per_child: 500,          // floor(5000 / 10)
        selling_price_child: 800,     // floor(8000 / 10)
        selling_price_parent_override: 8000,
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // deleteBatch — B1: must never hard-delete live stock with no adjustment trail
  // ═══════════════════════════════════════════════════════════════════════════
  describe('deleteBatch', () => {
    it('throws when the batch still has stock, even with no transaction/adjustment history', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 50 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 50, txn_count: 0, adj_count: 0 });
      await expect(svc.deleteBatch(1, 1)).rejects.toThrow(ValidationError);
      expect(batchRepo.deleteBatch).not.toHaveBeenCalled();
    });

    it('deletes a zero-quantity batch with no history', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 0 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 0, txn_count: 0, adj_count: 0 });
      await svc.deleteBatch(1, 1);
      expect(batchRepo.deleteBatch).toHaveBeenCalledWith(1);
    });

    it('still blocks deletion when transaction/adjustment history exists', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 0 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 0, txn_count: 3, adj_count: 0 });
      await expect(svc.deleteBatch(1, 1)).rejects.toThrow(ValidationError);
      expect(batchRepo.deleteBatch).not.toHaveBeenCalled();
    });

    it('records quantity_base in the audit oldValues so the loss is quantifiable', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 0 });
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 0, txn_count: 0, adj_count: 0 });
      await svc.deleteBatch(1, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'DELETE_BATCH',
        oldValues: expect.objectContaining({ quantity_base: 0 }),
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // reverseAdjustment (B6)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('reverseAdjustment', () => {
    const damageAdj = {
      id: 5, product_id: 1, batch_id: 1, quantity_base: 30,
      reason: 'Damaged in transit', type: 'damage' as const,
      user_id: 1, created_at: '2026-08-01', reverses_adjustment_id: null,
    };

    it('reverses a normal (positive) adjustment and restores the quantity', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getAdjustmentById.mockResolvedValue(damageAdj);
      batchRepo.getReversalOf.mockResolvedValue(undefined);
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 70, status: 'active' });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reverseAdjustment(5, 1);

      expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(1, 100, 'active', sampleBatch.version);
      expect(batchRepo.insertAdjustment).toHaveBeenCalledWith(expect.objectContaining({
        quantity_base: -30, reverses_adjustment_id: 5,
      }));
    });

    // B6: a cycle-count overage is legitimately stored negative too — the
    // old sign heuristic ("negative = is a reversal") permanently blocked
    // this from ever being reversed.
    it('reverses a negative (overage) adjustment that is NOT itself a reversal', async () => {
      const { svc, batchRepo } = createService();
      const overageAdj = { ...damageAdj, id: 6, quantity_base: -15, type: 'correction' as const, reason: 'Cycle count overage' };
      batchRepo.getAdjustmentById.mockResolvedValue(overageAdj);
      batchRepo.getReversalOf.mockResolvedValue(undefined);
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 70, status: 'active' });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reverseAdjustment(6, 1);

      expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(1, 55, 'active', sampleBatch.version);
      expect(batchRepo.insertAdjustment).toHaveBeenCalledWith(expect.objectContaining({
        quantity_base: 15, reverses_adjustment_id: 6,
      }));
    });

    it('refuses to reverse a row that is itself a reversal', async () => {
      const { svc, batchRepo } = createService();
      const reversalRow = { ...damageAdj, id: 7, reverses_adjustment_id: 5 };
      batchRepo.getAdjustmentById.mockResolvedValue(reversalRow);
      await expect(svc.reverseAdjustment(7, 1)).rejects.toThrow(BusinessRuleError);
      expect(batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    });

    it('refuses to reverse an adjustment that was already reversed', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getAdjustmentById.mockResolvedValue(damageAdj);
      batchRepo.getReversalOf.mockResolvedValue({ ...damageAdj, id: 8, reverses_adjustment_id: 5 });
      await expect(svc.reverseAdjustment(5, 1)).rejects.toThrow(BusinessRuleError);
      expect(batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the adjustment does not exist', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getAdjustmentById.mockResolvedValue(undefined);
      await expect(svc.reverseAdjustment(999, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError on optimistic lock failure', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getAdjustmentById.mockResolvedValue(damageAdj);
      batchRepo.getReversalOf.mockResolvedValue(undefined);
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 70, status: 'active' });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(false);
      await expect(svc.reverseAdjustment(5, 1)).rejects.toThrow(ConflictError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // update — I3: audit log must capture the previous value of changed fields
  // ═══════════════════════════════════════════════════════════════════════════
  describe('update — audit oldValues (I3)', () => {
    it('captures the previous value of every field the patch changes', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, cost_per_parent: 500, version: 1 });
      batchRepo.update.mockResolvedValue(true);
      await svc.update(1, { cost_per_parent: 700, version: 1 } as any, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_BATCH',
        oldValues: expect.objectContaining({ cost_per_parent: 500 }),
        newValues: expect.objectContaining({ cost_per_parent: 700 }),
      }));
    });
  });
});
