import { BatchService } from '@core/services/batch.service';
import { ValidationError, NotFoundError } from '@core/types/errors';
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
  mode: 'markup_over_cost', percent: 20, rounding: 100, ...o,
});

describe('BatchService — bulk margin price update', () => {
  describe('previewBulkPriceUpdate', () => {
    it('markup mode (D3): new parent = latest cost x (1 + percent), rounded', async () => {
      const { svc, batchRepo } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1]);
      const [row] = await svc.previewBulkPriceUpdate(opts({ mode: 'markup_over_cost', percent: 20, rounding: 100 }));
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

    // ─── D4: bulk price updates must be reversible ──────────────────────
    it('captures each product\'s prior price in oldValues (D4)', async () => {
      const { svc, batchRepo, bus } = createService();
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1, P2]);
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(2);

      await svc.applyBulkPriceUpdate(opts({}), 42);

      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        oldValues: {
          products: [
            { product_id: 1, selling_price_parent: 1150 }, // P1.current_sell
            { product_id: 2, selling_price_parent: 1000 }, // P2.current_sell
          ],
        },
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

  describe('applyManualPriceUpdate', () => {
    it('derives the small-unit price from the parent by floor division when omitted', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue({ id: 1, conversion_factor: 3 });
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(2);

      const result = await svc.applyManualPriceUpdate([{ product_id: 1, selling_price_parent: 1000 }], 7);

      // derived child = floor(1000 / 3) = 333
      expect(batchRepo.bulkUpdateSellingPrices).toHaveBeenCalledWith(1, 1000, 333, 333, false);
      expect(result).toEqual({ updatedProducts: 1, updatedBatches: 2 });
    });

    it('uses the explicit small-unit price when provided', async () => {
      const { svc, batchRepo, productRepo } = createService();
      productRepo.getById.mockResolvedValue({ id: 1, conversion_factor: 10 });
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(1);

      await svc.applyManualPriceUpdate([{ product_id: 1, selling_price_parent: 1200, selling_price_child: 150 }], 7);

      // base child stays floor(1200/10)=120; the explicit 150 becomes the override
      expect(batchRepo.bulkUpdateSellingPrices).toHaveBeenCalledWith(1, 1200, 120, 150, false);
    });

    it('emits a single BULK_MANUAL_PRICE_UPDATE event for the whole batch', async () => {
      const { svc, batchRepo, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue({ id: 1, conversion_factor: 1 });
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(1);

      await svc.applyManualPriceUpdate([
        { product_id: 1, selling_price_parent: 500 },
        { product_id: 2, selling_price_parent: 700 },
      ], 7);

      expect(bus.emit).toHaveBeenCalledTimes(1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'BULK_MANUAL_PRICE_UPDATE',
      }));
    });

    // ─── D4: manual price updates must be reversible too ───────────────
    it('captures each product\'s prior price in oldValues (D4)', async () => {
      const { svc, batchRepo, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue({ id: 1, conversion_factor: 1 });
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([P1, P2]);
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(1);

      await svc.applyManualPriceUpdate([
        { product_id: 1, selling_price_parent: 500 },
        { product_id: 2, selling_price_parent: 700 },
      ], 7);

      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        oldValues: {
          products: [
            { product_id: 1, selling_price_parent: 1150 },
            { product_id: 2, selling_price_parent: 1000 },
          ],
        },
      }));
    });

    it('records 0 as the prior price for a product with no pricing history yet', async () => {
      const { svc, batchRepo, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue({ id: 9, conversion_factor: 1 });
      batchRepo.getLatestBatchPricingPerProduct.mockResolvedValue([]); // no history
      batchRepo.bulkUpdateSellingPrices.mockResolvedValue(1);

      await svc.applyManualPriceUpdate([{ product_id: 9, selling_price_parent: 500 }], 7);

      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        oldValues: { products: [{ product_id: 9, selling_price_parent: 0 }] },
      }));
    });

    it('rejects an empty list and non-positive prices', async () => {
      const { svc } = createService();
      await expect(svc.applyManualPriceUpdate([], 7)).rejects.toThrow(ValidationError);
      await expect(svc.applyManualPriceUpdate([{ product_id: 1, selling_price_parent: 0 }], 7))
        .rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError for an unknown product', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(undefined);
      await expect(svc.applyManualPriceUpdate([{ product_id: 99, selling_price_parent: 100 }], 7))
        .rejects.toThrow(NotFoundError);
    });
  });
});
