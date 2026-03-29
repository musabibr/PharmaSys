import { ExpenseService } from '@core/services/expense.service';
import { ValidationError, NotFoundError, BusinessRuleError } from '@core/types/errors';
import {
  createMockExpenseRepo, createMockShiftRepo, createMockBus,
  sampleShift, runResult,
} from '../../helpers/mocks';

const sampleCategory = { id: 1, name: 'Utilities', created_at: '2026-01-01' };
const sampleExpense  = {
  id: 1, category_id: 1, amount: 5000,
  expense_date: '2026-02-25', description: 'Electric bill',
  payment_method: 'cash' as const, user_id: 1, shift_id: 1,
  is_recurring: 0, is_revoked: 0,
  category_name: 'Utilities', username: 'admin',
  created_at: '2026-02-25',
};
const sampleDrop = {
  id: 1, shift_id: 1, amount: 2000, reason: 'Safe drop',
  user_id: 1, username: 'admin', created_at: '2026-02-25',
};

function createService() {
  const expenseRepo = createMockExpenseRepo();
  const shiftRepo   = createMockShiftRepo();
  const bus         = createMockBus();
  const svc         = new ExpenseService(expenseRepo as any, shiftRepo as any, bus);
  return { svc, expenseRepo, shiftRepo, bus };
}

describe('ExpenseService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getCategories
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getCategories', () => {
    it('returns all expense categories', async () => {
      const { svc, expenseRepo } = createService();
      expenseRepo.getCategories.mockResolvedValue([sampleCategory]);
      const result = await svc.getCategories();
      expect(result).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createCategory
  // ═══════════════════════════════════════════════════════════════════════════
  describe('createCategory', () => {
    it('creates category and returns it', async () => {
      const { svc, expenseRepo } = createService();
      expenseRepo.createCategory.mockResolvedValue(runResult(2));
      expenseRepo.getCategoryById.mockResolvedValue({ id: 2, name: 'Transport', created_at: '2026-01-01' });

      const result = await svc.createCategory('Transport', 1);
      expect(result.name).toBe('Transport');
      expect(expenseRepo.createCategory).toHaveBeenCalledWith('Transport');
    });

    it('throws ValidationError for empty name', async () => {
      const { svc } = createService();
      await expect(svc.createCategory('', 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on create', async () => {
      const { svc, expenseRepo, bus } = createService();
      expenseRepo.createCategory.mockResolvedValue(runResult(2));
      expenseRepo.getCategoryById.mockResolvedValue({ id: 2, name: 'Transport', created_at: '2026-01-01' });

      await svc.createCategory('Transport', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_EXPENSE_CATEGORY',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('delegates to repo.getAll with filters', async () => {
      const { svc, expenseRepo } = createService();
      const paginated = { data: [sampleExpense], total: 1, page: 1, limit: 20, totalPages: 1 };
      expenseRepo.getAll.mockResolvedValue(paginated);

      const result = await svc.getAll({ category_id: 1 });
      expect(expenseRepo.getAll).toHaveBeenCalledWith({ category_id: 1 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create', () => {
    const validInput = {
      category_id: 1,
      amount: 5000,
      expense_date: '2026-02-25',
      description: 'Electric bill',
      payment_method: 'cash' as const,
    };

    it('creates expense and returns it', async () => {
      const { svc, expenseRepo, shiftRepo } = createService();
      expenseRepo.getCategoryById.mockResolvedValue(sampleCategory);
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      expenseRepo.create.mockResolvedValue(runResult(1));
      expenseRepo.getById.mockResolvedValue(sampleExpense);

      const result = await svc.create(validInput, 1);
      expect(result.amount).toBe(5000);
      expect(expenseRepo.create).toHaveBeenCalled();
    });

    it('creates expense without open shift (links to null shift)', async () => {
      const { svc, expenseRepo, shiftRepo } = createService();
      expenseRepo.getCategoryById.mockResolvedValue(sampleCategory);
      shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      expenseRepo.create.mockResolvedValue(runResult(1));
      expenseRepo.getById.mockResolvedValue({ ...sampleExpense, shift_id: null });

      await svc.create(validInput, 1);
      const createArgs = expenseRepo.create.mock.calls[0];
      expect(createArgs[2]).toBeNull(); // shift_id
    });

    it('throws ValidationError for invalid category_id', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, category_id: 0 }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for non-positive amount', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, amount: 0 }, 1)).rejects.toThrow(ValidationError);
      await expect(svc.create({ ...validInput, amount: -100 }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid date format', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, expense_date: 'not-a-date' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when category does not exist', async () => {
      const { svc, expenseRepo } = createService();
      expenseRepo.getCategoryById.mockResolvedValue(undefined);
      await expect(svc.create(validInput, 1)).rejects.toThrow(NotFoundError);
    });

    it('emits entity:mutated on create', async () => {
      const { svc, expenseRepo, shiftRepo, bus } = createService();
      expenseRepo.getCategoryById.mockResolvedValue(sampleCategory);
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      expenseRepo.create.mockResolvedValue(runResult(1));
      expenseRepo.getById.mockResolvedValue(sampleExpense);

      await svc.create(validInput, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_EXPENSE',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // delete
  // ═══════════════════════════════════════════════════════════════════════════
  describe('delete', () => {
    it('deletes expense by id', async () => {
      const { svc, expenseRepo } = createService();
      expenseRepo.getById.mockResolvedValue(sampleExpense);
      await svc.delete(1, 1);
      expect(expenseRepo.delete).toHaveBeenCalledWith(1);
    });

    it('throws ValidationError for invalid id', async () => {
      const { svc } = createService();
      await expect(svc.delete(0, 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on delete', async () => {
      const { svc, expenseRepo, bus } = createService();
      expenseRepo.getById.mockResolvedValue(sampleExpense);
      await svc.delete(1, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'DELETE_EXPENSE',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createCashDrop
  // ═══════════════════════════════════════════════════════════════════════════
  describe('createCashDrop', () => {
    it('creates cash drop and returns it', async () => {
      const { svc, expenseRepo, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      expenseRepo.createCashDrop.mockResolvedValue(runResult(1));
      expenseRepo.getCashDropById.mockResolvedValue(sampleDrop);

      const result = await svc.createCashDrop({ amount: 2000, reason: 'Safe drop' }, 1);
      expect(result.amount).toBe(2000);
    });

    it('throws BusinessRuleError when no open shift', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      await expect(svc.createCashDrop({ amount: 1000 }, 1)).rejects.toThrow(BusinessRuleError);
    });

    it('throws ValidationError for non-positive amount', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      await expect(svc.createCashDrop({ amount: 0 }, 1)).rejects.toThrow(ValidationError);
      await expect(svc.createCashDrop({ amount: -100 }, 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on cash drop', async () => {
      const { svc, expenseRepo, shiftRepo, bus } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      expenseRepo.createCashDrop.mockResolvedValue(runResult(1));
      expenseRepo.getCashDropById.mockResolvedValue(sampleDrop);

      await svc.createCashDrop({ amount: 2000 }, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_CASH_DROP',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getCashDrops
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getCashDrops', () => {
    it('delegates to repo.getCashDrops', async () => {
      const { svc, expenseRepo } = createService();
      expenseRepo.getCashDrops.mockResolvedValue([sampleDrop]);

      const result = await svc.getCashDrops(1);
      expect(expenseRepo.getCashDrops).toHaveBeenCalledWith(1);
      expect(result).toHaveLength(1);
    });
  });
});
