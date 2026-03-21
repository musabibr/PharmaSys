import { HeldSaleService } from '@core/services/held-sale.service';
import { ValidationError } from '@core/types/errors';
import {
  createMockHeldSaleRepo, createMockBus, runResult,
} from '../../helpers/mocks';

const sampleHeldSale = {
  id: 1, user_id: 1, customer_note: 'Hold for John',
  items_json: '[{"product_id":1,"quantity":2,"unit_price":4000}]',
  total_amount: 8000, created_at: '2026-02-25',
};

function createService() {
  const repo = createMockHeldSaleRepo();
  const bus  = createMockBus();
  const svc  = new HeldSaleService(repo as any, bus);
  return { svc, repo, bus };
}

describe('HeldSaleService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('returns held sales for a user', async () => {
      const { svc, repo } = createService();
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      const result = await svc.getAll(1);
      expect(repo.getAll).toHaveBeenCalledWith(1);
      expect(result).toHaveLength(1);
    });

    it('returns all held sales when no userId', async () => {
      const { svc, repo } = createService();
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      const result = await svc.getAll();
      expect(repo.getAll).toHaveBeenCalledWith(undefined);
      expect(result).toHaveLength(1);
    });

    it('returns empty array when no held sales', async () => {
      const { svc, repo } = createService();
      repo.getAll.mockResolvedValue([]);
      expect(await svc.getAll(1)).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // save
  // ═══════════════════════════════════════════════════════════════════════════
  describe('save', () => {
    it('saves held sale and returns it', async () => {
      const { svc, repo } = createService();
      repo.save.mockResolvedValue(runResult(1));
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      const result = await svc.save(1, [{ product_id: 1, quantity: 2, unit_price: 4000 }], 'Hold for John');
      expect(repo.save).toHaveBeenCalled();
      expect(result.total_amount).toBe(8000);
    });

    it('calculates total from items automatically', async () => {
      const { svc, repo } = createService();
      repo.save.mockResolvedValue(runResult(1));
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      await svc.save(1, [{ product_id: 1, quantity: 3, unit_price: 1000 }]);
      const saveCall = repo.save.mock.calls[0][0];
      expect(saveCall.total_amount).toBe(3000);
    });

    it('serializes items as JSON', async () => {
      const { svc, repo } = createService();
      repo.save.mockResolvedValue(runResult(1));
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      const items = [{ product_id: 1, quantity: 2, unit_price: 4000 }];
      await svc.save(1, items);

      const saveCall = repo.save.mock.calls[0][0];
      expect(saveCall.items_json).toBe(JSON.stringify(items));
    });

    it('uses null for customer_note when omitted', async () => {
      const { svc, repo } = createService();
      repo.save.mockResolvedValue(runResult(1));
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      await svc.save(1, [{ product_id: 1, quantity: 1, unit_price: 5000 }]);
      const saveCall = repo.save.mock.calls[0][0];
      expect(saveCall.customer_note).toBeNull();
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.save(0, [{ product_id: 1 }])).rejects.toThrow(ValidationError);
    });

    it('throws Error for empty items array', async () => {
      const { svc } = createService();
      await expect(svc.save(1, [])).rejects.toThrow('Cart cannot be empty');
    });

    it('throws Error when items is not an array', async () => {
      const { svc } = createService();
      await expect(svc.save(1, null as any)).rejects.toThrow();
    });

    it('emits entity:mutated on save', async () => {
      const { svc, repo, bus } = createService();
      repo.save.mockResolvedValue(runResult(1));
      repo.getAll.mockResolvedValue([sampleHeldSale]);

      await svc.save(1, [{ product_id: 1, quantity: 2, unit_price: 4000 }]);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'HOLD_SALE',
        newValues: expect.objectContaining({ item_count: 1 }),
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // delete
  // ═══════════════════════════════════════════════════════════════════════════
  describe('delete', () => {
    it('deletes held sale by id', async () => {
      const { svc, repo } = createService();
      await svc.delete(1, 1);
      expect(repo.delete).toHaveBeenCalledWith(1);
    });

    it('throws ValidationError for invalid id', async () => {
      const { svc } = createService();
      await expect(svc.delete(0, 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on delete', async () => {
      const { svc, bus } = createService();
      await svc.delete(1, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'DELETE_HELD_SALE',
        recordId: 1,
      }));
    });
  });
});
