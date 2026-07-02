import { BatchService } from '@core/services/batch.service';
import { ValidationError } from '@core/types/errors';
import { createMockBatchRepo, createMockProductRepo, createMockBus } from '../../helpers/mocks';
import type { BulkPriceUpdateOptions, LatestBatchPricing } from '@core/types/models';

function createService() {
  const batchRepo   = createMockBatchRepo();
  const productRepo = createMockProductRepo();
  const bus         = createMockBus();
  const svc         = new BatchService(batchRepo as any, productRepo as any, bus);
  return { svc, batchRepo, productRepo, bus };
}

const P1: LatestBatchPricing = {
  product_id: 1, product_name: 'Amoxicillin', category_id: 5, category_name: 'Antibiotics',
  conversion_factor: 10, latest_cost: 1000, current_sell: 1150,
};
const P2: LatestBatchPricing = {
  product_id: 2, product_name: 'Vitamin C', category_id: 7, category_name: 'Supplements',
  conversion_factor: 3, latest_cost: 1000, current_sell: 1000,
};

const opts = (o: Partial<BulkPriceUpdateOptions>): BulkPriceUpdateOptions => ({
  mode: 'margin_over_cost', percent: 20, rounding: 100, ...o,
});

describe('BatchService — bulk margin price update', () => {
  describe('previewBulkPriceUpdate', () => {
    it('margin mode: new parent = latest cost x (1 + percent), rounded', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1]);
      const [row] = await svc.previewBulkPriceUpdate(opts({ mode: 'margin_over_cost', percent: 20, rounding: 100 }));
      expect(row.basis_cost).toBe(1000);
      expect(row.new_sell_parent).toBe(1200); // 1000 * 1.2 = 1200
      expect(row.new_sell_child).toBe(120);   // divideToChild(1200, 10)
    });

    it('increase mode uses the current sell price as the basis', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1]);
      const [row] = await svc.previewBulkPriceUpdate(opts({ mode: 'increase_current', percent: 20, rounding: 1 }));
      expect(row.basis_cost).toBe(1150);
      expect(row.new_sell_parent).toBe(1380); // 1150 * 1.2
    });

    it('rounds to the nearest step (1 / 50 / 100)', async () => {
      const { svc, batchRepo } = createService();
      const row = { ...P1, latest_cost: 1000, current_sell: 0 };
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([row]);

      const r1 = await svc.previewBulkPriceUpdate(opts({ percent: 15, rounding: 1 }));
      expect(r1[0].new_sell_parent).toBe(1150);
      const r50 = await svc.previewBulkPriceUpdate(opts({ percent: 15, rounding: 50 }));
      expect(r50[0].new_sell_parent).toBe(1150);
      const r100 = await svc.previewBulkPriceUpdate(opts({ percent: 15, rounding: 100 }));
      expect(r100[0].new_sell_parent).toBe(1200); // 1150 → nearest 100
    });

    it('never returns below one rounding step (min clamp)', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([{ ...P1, latest_cost: 20, current_sell: 0 }]);
      const [row] = await svc.previewBulkPriceUpdate(opts({ percent: 0, rounding: 100 }));
      expect(row.new_sell_parent).toBe(100); // 20 would round to 0 → clamped to 100
    });

    it('derives the child price by floor division of the parent by CF', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([{ ...P2, latest_cost: 1000, conversion_factor: 3 }]);
      const [row] = await svc.previewBulkPriceUpdate(opts({ percent: 0, rounding: 1 }));
      expect(row.new_sell_parent).toBe(1000);
      expect(row.new_sell_child).toBe(333); // floor(1000 / 3)
    });

    it('computes change_pct against the current sell price', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1]);
      const [row] = await svc.previewBulkPriceUpdate(opts({ percent: 20, rounding: 100 }));
      expect(row.change_pct).toBeCloseTo(4.3, 1); // (1200 - 1150) / 1150
    });

    it('excludes products by id', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1, P2]);
      const rows = await svc.previewBulkPriceUpdate(opts({ exclude_product_ids: [2] }));
      expect(rows.map((r) => r.product_id)).toEqual([1]);
    });

    it('excludes products by category id', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1, P2]);
      const rows = await svc.previewBulkPriceUpdate(opts({ exclude_category_ids: [7] }));
      expect(rows.map((r) => r.product_id)).toEqual([1]);
    });

    it('does not write during preview', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1, P2]);
      await svc.previewBulkPriceUpdate(opts({}));
      expect(batchRepo.bulkUpdateSellingPrices).not.toHaveBeenCalled();
      expect(bus.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['invalid mode', { mode: 'nope' } as any],
      ['percent too low', { percent: -95 }],
      ['percent too high', { percent: 501 }],
      ['percent not finite', { percent: NaN }],
      ['invalid rounding', { rounding: 25 } as any],
    ])('throws ValidationError for %s', async (_label, patch) => {
      const { svc } = createService();
      await expect(svc.previewBulkPriceUpdate(opts(patch))).rejects.toThrow(ValidationError);
    });
  });

  describe('applyBulkPriceUpdate', () => {
    it('calls bulkUpdateSellingPrices once per included product and emits a single event', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1, P2]);
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(2);

      const result = await svc.applyBulkPriceUpdate(opts({}), 42);

      expect(batchRepo.bulkUpdateSellingPrices).toHaveBeenCalledTimes(2);
      expect(result.updatedProducts).toBe(2);
      expect(result.updatedBatches).toBe(4); // 2 products x 2 batches each
      expect(bus.emit).toHaveBeenCalledTimes(1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'BULK_MARGIN_PRICE_UPDATE',
      }));
    });

    it('passes the computed parent + child prices to the repo', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1]);
      await svc.applyBulkPriceUpdate(opts({ percent: 20, rounding: 100 }), 1);
      expect(batchRepo.bulkUpdateSellingPrices).toHaveBeenCalledWith(1, 1200, 120, 120, false);
    });

    it('validates options before applying', async () => {
      const { svc, batchRepo } = createService();
      await expect(svc.applyBulkPriceUpdate(opts({ rounding: 7 as any }), 1)).rejects.toThrow(ValidationError);
      expect(batchRepo.getLatestBatchPricingPerProduct).not.toHaveBeenCalled();
    });
  });
});
