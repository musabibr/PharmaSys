import { CategoryService } from '@core/services/category.service';
import { ValidationError, NotFoundError } from '@core/types/errors';
import {
  createMockCategoryRepo, createMockAuditRepo, createMockBus, runResult,
} from '../../helpers/mocks';

const sampleCategory = { id: 1, name: 'Painkillers', created_at: '2026-01-01' };

function createService() {
  const categoryRepo = createMockCategoryRepo();
  const auditRepo    = createMockAuditRepo();
  const bus          = createMockBus();
  const svc          = new CategoryService(categoryRepo as any, auditRepo as any, bus);
  return { svc, categoryRepo, auditRepo, bus };
}

describe('CategoryService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('returns all categories', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getAll.mockResolvedValue([sampleCategory]);
      const result = await svc.getAll();
      expect(result).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getById
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getById', () => {
    it('returns category when found', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue(sampleCategory);
      expect(await svc.getById(1)).toEqual(sampleCategory);
    });

    it('throws NotFoundError when category does not exist', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(99)).rejects.toThrow(NotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('creates new category and returns it', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.findByName.mockResolvedValue(undefined);
      categoryRepo.create.mockResolvedValue(runResult(2));
      categoryRepo.getById.mockResolvedValue({ id: 2, name: 'Antibiotics', created_at: '2026-01-01' });

      const result = await svc.create('Antibiotics', 1);
      expect(result.name).toBe('Antibiotics');
      expect(categoryRepo.create).toHaveBeenCalledWith('Antibiotics');
    });

    it('returns existing category when name already exists (idempotent)', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.findByName.mockResolvedValue(sampleCategory);

      const result = await svc.create('Painkillers', 1);
      expect(result).toEqual(sampleCategory);
      expect(categoryRepo.create).not.toHaveBeenCalled();
    });

    it('throws ValidationError for empty name', async () => {
      const { svc } = createService();
      await expect(svc.create('', 1)).rejects.toThrow(ValidationError);
      await expect(svc.create('  ', 1)).rejects.toThrow(ValidationError);
    });

    it('trims whitespace from name before creating', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.findByName.mockResolvedValue(undefined);
      categoryRepo.create.mockResolvedValue(runResult(3));
      categoryRepo.getById.mockResolvedValue({ id: 3, name: 'Vitamins', created_at: '2026-01-01' });

      await svc.create('  Vitamins  ', 1);
      expect(categoryRepo.create).toHaveBeenCalledWith('Vitamins');
    });

    it('emits entity:mutated on new creation', async () => {
      const { svc, categoryRepo, bus } = createService();
      categoryRepo.findByName.mockResolvedValue(undefined);
      categoryRepo.create.mockResolvedValue(runResult(2));
      categoryRepo.getById.mockResolvedValue({ id: 2, name: 'Antibiotics', created_at: '2026-01-01' });

      await svc.create('Antibiotics', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_CATEGORY',
        newValues: { name: 'Antibiotics' },
      }));
    });

    it('does not emit event when category already exists', async () => {
      const { svc, categoryRepo, bus } = createService();
      categoryRepo.findByName.mockResolvedValue(sampleCategory);

      await svc.create('Painkillers', 1);
      expect(bus.emit).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // update
  // ═══════════════════════════════════════════════════════════════════════════
  describe('update', () => {
    it('updates category name and returns it', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById
        .mockResolvedValueOnce(sampleCategory)
        .mockResolvedValue({ ...sampleCategory, name: 'Pain Relief' });

      const result = await svc.update(1, 'Pain Relief', 1);
      expect(categoryRepo.update).toHaveBeenCalledWith(1, 'Pain Relief');
      expect(result.name).toBe('Pain Relief');
    });

    it('throws NotFoundError when category does not exist', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue(undefined);
      await expect(svc.update(99, 'X', 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid id', async () => {
      const { svc } = createService();
      await expect(svc.update(0, 'X', 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty name', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.getById.mockResolvedValue(sampleCategory);
      await expect(svc.update(1, '', 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on update', async () => {
      const { svc, categoryRepo, bus } = createService();
      categoryRepo.getById
        .mockResolvedValueOnce(sampleCategory)
        .mockResolvedValue({ ...sampleCategory, name: 'Updated' });

      await svc.update(1, 'Updated', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_CATEGORY',
        oldValues: { name: 'Painkillers' },
        newValues: { name: 'Updated' },
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // findOrCreate
  // ═══════════════════════════════════════════════════════════════════════════
  describe('findOrCreate', () => {
    it('returns existing category by name', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.findByName.mockResolvedValue(sampleCategory);

      const result = await svc.findOrCreate('Painkillers', 1);
      expect(result).toEqual(sampleCategory);
      expect(categoryRepo.create).not.toHaveBeenCalled();
    });

    it('creates and returns new category when not found', async () => {
      const { svc, categoryRepo } = createService();
      categoryRepo.findByName.mockResolvedValue(undefined);
      categoryRepo.create.mockResolvedValue(runResult(5));
      categoryRepo.getById.mockResolvedValue({ id: 5, name: 'Vitamins', created_at: '2026-01-01' });

      const result = await svc.findOrCreate('Vitamins', 1);
      expect(result.name).toBe('Vitamins');
      expect(categoryRepo.create).toHaveBeenCalledWith('Vitamins');
    });

    it('throws ValidationError for empty name', async () => {
      const { svc } = createService();
      await expect(svc.findOrCreate('', 1)).rejects.toThrow(ValidationError);
    });
  });
});
