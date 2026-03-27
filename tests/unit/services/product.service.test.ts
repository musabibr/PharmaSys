import { ProductService } from '@core/services/product.service';
import { ValidationError, NotFoundError } from '@core/types/errors';
import {
  createMockProductRepo, createMockCategoryRepo, createMockBatchRepo,
  createMockBus, sampleProduct, runResult,
} from '../../helpers/mocks';

function createService() {
  const productRepo  = createMockProductRepo();
  // add softDelete to mock since it's called by service delete()
  (productRepo as any).softDelete = jest.fn();
  const categoryRepo = createMockCategoryRepo();
  const batchRepo    = createMockBatchRepo();
  const bus          = createMockBus();

  const svc = new ProductService(
    productRepo as any, categoryRepo as any, batchRepo as any, bus
  );
  return { svc, productRepo, categoryRepo, batchRepo, bus };
}

describe('ProductService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getAll / search
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('delegates to repo.getAll when no search query', async () => {
      const { svc, productRepo } = createService();
      productRepo.getAll.mockResolvedValue([sampleProduct]);
      const result = await svc.getAll();
      expect(productRepo.getAll).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('delegates to repo.search when query is provided', async () => {
      const { svc, productRepo } = createService();
      productRepo.search.mockResolvedValue([sampleProduct]);
      const result = await svc.getAll('para');
      expect(productRepo.search).toHaveBeenCalledWith('para');
      expect(result).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('returns empty array for blank query', async () => {
      const { svc } = createService();
      expect(await svc.search('   ')).toEqual([]);
      expect(await svc.search('')).toEqual([]);
    });

    it('trims and delegates to repo.search', async () => {
      const { svc, productRepo } = createService();
      productRepo.search.mockResolvedValue([sampleProduct]);
      await svc.search('  aspirin  ');
      expect(productRepo.search).toHaveBeenCalledWith('aspirin');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getById
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getById', () => {
    it('returns product when found', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      const result = await svc.getById(1);
      expect(result.name).toBe('Paracetamol');
    });

    it('throws NotFoundError when product does not exist', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(99)).rejects.toThrow(NotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create', () => {
    const validInput = {
      name: 'Aspirin', category_id: 1,
      conversion_factor: 10,
    } as any;

    it('creates product and returns it', async () => {
      const { svc, productRepo, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue({ id: 1, name: 'OTC' });
      productRepo.create.mockResolvedValue(runResult(5));
      productRepo.getById.mockResolvedValue({ ...sampleProduct, id: 5, name: 'Aspirin' });

      const result = await svc.create(validInput, 1);
      expect(result.name).toBe('Aspirin');
      expect(productRepo.create).toHaveBeenCalled();
    });

    it('throws ValidationError for empty name', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, name: '' }, 1)).rejects.toThrow(ValidationError);
      await expect(svc.create({ ...validInput, name: '  ' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when category does not exist', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue(undefined);
      await expect(svc.create(validInput, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for non-integer conversion factor', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue({ id: 1, name: 'OTC' });
      await expect(svc.create({ ...validInput, conversion_factor: 1.5 }, 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated event on create', async () => {
      const { svc, productRepo, categoryRepo, bus } = createService();
      categoryRepo.getById.mockResolvedValue({ id: 1, name: 'OTC' });
      productRepo.create.mockResolvedValue(runResult(5));
      productRepo.getById.mockResolvedValue({ ...sampleProduct, id: 5 });

      await svc.create(validInput, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_PRODUCT',
      }));
    });

    it('creates product without category when category_id is omitted', async () => {
      const { svc, productRepo, categoryRepo } = createService();
      productRepo.create.mockResolvedValue(runResult(6));
      productRepo.getById.mockResolvedValue({ ...sampleProduct, id: 6 });

      await svc.create({ name: 'Generic Drug' } as any, 1);
      expect(categoryRepo.getById).not.toHaveBeenCalled();
      expect(productRepo.create).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // update
  // ═══════════════════════════════════════════════════════════════════════════
  describe('update', () => {
    it('updates product and returns updated data', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById
        .mockResolvedValueOnce(sampleProduct)        // existence check
        .mockResolvedValue({ ...sampleProduct, name: 'Paracetamol XR' }); // final fetch

      const result = await svc.update(1, { name: 'Paracetamol XR' } as any, 1);
      expect(productRepo.update).toHaveBeenCalledWith(1, expect.any(Object));
      expect(result.name).toBe('Paracetamol XR');
    });

    it('throws NotFoundError when product does not exist', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(undefined);
      await expect(svc.update(99, { name: 'X' } as any, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError when new category does not exist', async () => {
      const { svc, productRepo, categoryRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      categoryRepo.getById.mockResolvedValue(undefined);
      await expect(svc.update(1, { category_id: 99 } as any, 1)).rejects.toThrow(NotFoundError);
    });

    it('emits entity:mutated event on update', async () => {
      const { svc, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      await svc.update(1, { name: 'Updated' } as any, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_PRODUCT',
      }));
    });

    it('cascades conversion_factor change to batch child prices', async () => {
      const { svc, productRepo, batchRepo, bus } = createService();
      productRepo.getById
        .mockResolvedValueOnce({ ...sampleProduct, conversion_factor: 20 })
        .mockResolvedValue({ ...sampleProduct, conversion_factor: 10 });
      batchRepo.recalculateChildPricesForProduct.mockResolvedValue(3);

      const result = await svc.update(1, { conversion_factor: 10 } as any, 1);
      expect(batchRepo.recalculateChildPricesForProduct).toHaveBeenCalledWith(1, 10);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CASCADE_CF_CHANGE',
        oldValues: { conversion_factor: 20 },
        newValues: { conversion_factor: 10 },
      }));
      expect(result.conversion_factor).toBe(10);
    });

    it('does not cascade when conversion_factor is unchanged', async () => {
      const { svc, productRepo, batchRepo } = createService();
      productRepo.getById.mockResolvedValue({ ...sampleProduct, conversion_factor: 20 });

      await svc.update(1, { conversion_factor: 20 } as any, 1);
      expect(batchRepo.recalculateChildPricesForProduct).not.toHaveBeenCalled();
    });

    it('rejects non-integer conversion_factor', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      await expect(svc.update(1, { conversion_factor: 1.5 } as any, 1)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // delete
  // ═══════════════════════════════════════════════════════════════════════════
  describe('delete', () => {
    it('soft-deletes product when no active batches', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      productRepo.hasActiveBatches.mockResolvedValue(false);

      await svc.delete(1, 1);
      expect((productRepo as any).softDelete).toHaveBeenCalledWith(1);
    });

    it('throws ValidationError when product has active batches', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      productRepo.hasActiveBatches.mockResolvedValue(true);

      await expect(svc.delete(1, 1)).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when product does not exist', async () => {
      const { svc, productRepo } = createService();
      productRepo.getById.mockResolvedValue(undefined);
      await expect(svc.delete(99, 1)).rejects.toThrow(NotFoundError);
    });

    it('emits entity:mutated event on delete', async () => {
      const { svc, productRepo, bus } = createService();
      productRepo.getById.mockResolvedValue(sampleProduct);
      productRepo.hasActiveBatches.mockResolvedValue(false);

      await svc.delete(1, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'DELETE_PRODUCT',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // bulkCreate
  // ═══════════════════════════════════════════════════════════════════════════
  describe('bulkCreate', () => {
    it('throws ValidationError for empty array', async () => {
      const { svc } = createService();
      await expect(svc.bulkCreate([], 1)).rejects.toThrow(ValidationError);
    });

    it('delegates to repo.bulkCreate and emits event', async () => {
      const { svc, productRepo, bus } = createService();
      productRepo.bulkCreate.mockResolvedValue([
        { success: true, name: 'Drug A' },
        { success: true, name: 'Drug B' },
      ]);

      const results = await svc.bulkCreate([{} as any, {} as any], 1);
      expect(results).toHaveLength(2);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'BULK_CREATE_PRODUCTS',
        newValues: { count: 2 },
      }));
    });

    it('does not emit event when all items fail', async () => {
      const { svc, productRepo, bus } = createService();
      productRepo.bulkCreate.mockResolvedValue([
        { success: false, name: 'Drug A', error: 'duplicate' },
      ]);

      await svc.bulkCreate([{} as any], 1);
      expect(bus.emit).not.toHaveBeenCalled();
    });
  });
});
