import { BatchService } from '@core/services/batch.service';
import { ValidationError, NotFoundError, ConflictError } from '@core/types/errors';
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
      expect(batchRepo.update).toHaveBeenCalledWith(1, expect.any(Object));
      expect(result.selling_price_parent).toBe(9000);
    });

    it('throws NotFoundError when batch does not exist', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(undefined);
      await expect(svc.update(99, {} as any, 1)).rejects.toThrow(NotFoundError);
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

    it('blocks cost_per_parent change when batch has sales', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue(sampleBatch);
      batchRepo.getBatchDeleteInfo.mockResolvedValue({ quantity_base: 200, txn_count: 3, adj_count: 0 });
      await expect(svc.update(1, { cost_per_parent: 9999 } as any, 1)).rejects.toThrow(ValidationError);
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
      expect(batchRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({
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
      expect(batchRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({
        selling_price_child: 50,
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // reportDamage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('reportDamage', () => {
    it('deducts quantity and updates status to quarantine for damage', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 200 });
      batchRepo.updateQuantityOptimistic.mockResolvedValue(true);

      await svc.reportDamage(1, 10, 'broken vials', 'damage', 1);
      expect(batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 190, 'quarantine', 1
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
      // base child = floor(5000 / 10) = 500
      expect(batchRepo.bulkUpdateSellingPrices).toHaveBeenCalledWith(1, 5000, 500, null);
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
});
