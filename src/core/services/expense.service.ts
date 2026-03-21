import type { ExpenseRepository } from '../repositories/sql/expense.repository';
import type { ShiftRepository }   from '../repositories/sql/shift.repository';
import type { SettingsRepository } from '../repositories/sql/settings.repository';
import type { EventBus }          from '../events/event-bus';
import type { Expense, ExpenseCategory, CashDrop, ExpenseFilters, CreateExpenseInput, CreateCashDropInput, PaginatedResult } from '../types/models';
import { Validate }               from '../common/validation';
import { NotFoundError, BusinessRuleError, ValidationError, InternalError } from '../types/errors';
import { Money }                  from '../common/money';

export class ExpenseService {
  constructor(
    private readonly repo:      ExpenseRepository,
    private readonly shiftRepo: ShiftRepository,
    private readonly bus:       EventBus,
    private readonly settingsRepo?: SettingsRepository
  ) {}

  async getCategories(): Promise<ExpenseCategory[]> {
    return await this.repo.getCategories();
  }

  async createCategory(name: string, userId: number): Promise<ExpenseCategory> {
    const cleaned = Validate.requiredString(name, 'Category name', 100);
    const result  = await this.repo.createCategory(cleaned);
    this.bus.emit('entity:mutated', {
      action: 'CREATE_EXPENSE_CATEGORY', table: 'expense_categories',
      recordId: result.lastInsertRowid, userId,
      newValues: { name: cleaned },
    });
    return (await this.repo.getCategoryById(result.lastInsertRowid))!;
  }

  async updateCategory(id: number, name: string, userId: number): Promise<ExpenseCategory> {
    Validate.id(id);
    const cleaned = Validate.requiredString(name, 'Category name', 100);
    const existing = await this.repo.getCategoryById(id);
    if (!existing) throw new NotFoundError('Expense category', id);
    await this.repo.updateCategory(id, cleaned);
    this.bus.emit('entity:mutated', {
      action: 'UPDATE_CATEGORY', table: 'expense_categories',
      recordId: id, userId,
      oldValues: { name: existing.name }, newValues: { name: cleaned },
    });
    return (await this.repo.getCategoryById(id))!;
  }

  async deleteCategory(id: number, userId: number): Promise<void> {
    Validate.id(id);
    const existing = await this.repo.getCategoryById(id);
    if (!existing) throw new NotFoundError('Expense category', id);
    const usage = await this.repo.getCategoryUsageCount(id);
    if (usage > 0) {
      throw new BusinessRuleError(`Cannot delete category "${existing.name}" — it is used by ${usage} expense(s).`);
    }
    await this.repo.deleteCategory(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_EXPENSE', table: 'expense_categories',
      recordId: id, userId,
      oldValues: { name: existing.name },
    });
  }

  async update(id: number, data: Partial<CreateExpenseInput>, userId: number): Promise<Expense> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('Expense', id);

    if (data.amount !== undefined) {
      data.amount = Money.round(Validate.positiveNumber(data.amount, 'Amount'));
    }
    if (data.expense_date !== undefined) {
      data.expense_date = Validate.dateString(data.expense_date, 'Expense date');
    }
    if (data.category_id !== undefined) {
      const cat = await this.repo.getCategoryById(data.category_id);
      if (!cat) throw new NotFoundError('Expense category', data.category_id);
    }

    await this.repo.update(id, data);
    this.bus.emit('entity:mutated', {
      action: 'UPDATE_EXPENSE', table: 'expenses',
      recordId: id, userId,
      oldValues: { amount: existing.amount }, newValues: data as Record<string, unknown>,
    });

    const updated = await this.repo.getById(id);
    if (!updated) throw new InternalError('Failed to retrieve updated expense');
    return updated;
  }

  async getAll(filters: ExpenseFilters): Promise<PaginatedResult<Expense>> {
    return await this.repo.getAll(filters);
  }

  async create(data: CreateExpenseInput, userId: number): Promise<Expense> {
    Validate.id(data.category_id, 'Category');
    const amount = Money.round(Validate.positiveNumber(data.amount, 'Amount'));
    const expenseDate = Validate.dateString(data.expense_date, 'Expense date');

    const allowedMethods = ['cash', 'bank_transfer'];
    const paymentMethod = data.payment_method ?? 'cash';
    if (!allowedMethods.includes(paymentMethod)) {
      throw new ValidationError(`Invalid payment method: ${paymentMethod}. Must be one of: ${allowedMethods.join(', ')}`, 'payment_method');
    }

    const cat = await this.repo.getCategoryById(data.category_id);
    if (!cat) throw new NotFoundError('Expense category', data.category_id);

    const shift = await this.shiftRepo.findOpenByUser(userId);

    const result = await this.repo.create(
      { ...data, amount, expense_date: expenseDate, payment_method: paymentMethod },
      userId,
      shift?.id ?? null
    );

    const newId = result.lastInsertRowid as number;

    this.bus.emit('entity:mutated', {
      action: 'CREATE_EXPENSE', table: 'expenses',
      recordId: newId, userId,
      newValues: { amount, category: cat.name, date: expenseDate },
    });

    const created = await this.repo.getById(newId);
    if (!created) throw new InternalError('Failed to retrieve created expense');
    return created;
  }

  async delete(id: number, userId: number): Promise<void> {
    Validate.id(id);
    await this.repo.delete(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_EXPENSE', table: 'expenses',
      recordId: id, userId,
    });
  }

  async createCashDrop(data: CreateCashDropInput, userId: number): Promise<CashDrop> {
    // Cash drops require shifts — they track cash leaving the drawer during a shift
    const shiftsEnabled = this.settingsRepo
      ? (await this.settingsRepo.get('shifts_enabled')) !== 'false'
      : true;
    if (!shiftsEnabled) {
      throw new BusinessRuleError('Cash drops are only available when shifts are enabled.');
    }

    const amount = Money.round(Validate.positiveNumber(data.amount, 'Amount'));
    const shift  = await this.shiftRepo.findOpenByUser(userId);
    if (!shift) throw new BusinessRuleError('No open shift. Open a shift before creating a cash drop.');

    const result = await this.repo.createCashDrop({ ...data, amount }, userId, shift.id);

    const newId = result.lastInsertRowid as number;

    this.bus.emit('entity:mutated', {
      action: 'CREATE_CASH_DROP', table: 'cash_drops',
      recordId: newId, userId,
      newValues: { amount, shift_id: shift.id },
    });

    const created = await this.repo.getCashDropById(newId);
    if (!created) throw new InternalError('Failed to retrieve created cash drop');
    return created;
  }

  async getCashDrops(shiftId: number): Promise<CashDrop[]> {
    return await this.repo.getCashDrops(shiftId);
  }
}
