import type { BaseRepository } from './base.repository';
import type { IExpenseRepository } from '../../types/repositories';
import type { Expense, ExpenseCategory, CashDrop, ExpenseFilters, CreateExpenseInput, CreateCashDropInput, PaginatedResult } from '../../types/models';
import { PAGINATION } from '../../common/constants';

export class ExpenseRepository implements IExpenseRepository {
  constructor(private readonly base: BaseRepository) {}

  async getCategories(): Promise<ExpenseCategory[]> {
    return await this.base.getAll<ExpenseCategory>(
      `SELECT id, name FROM expense_categories ORDER BY name`
    );
  }

  async getCategoryById(id: number): Promise<ExpenseCategory | undefined> {
    return await this.base.getOne<ExpenseCategory>(
      `SELECT id, name FROM expense_categories WHERE id = ?`,
      [id]
    );
  }

  async createCategory(name: string) {
    return await this.base.runImmediate(
      `INSERT INTO expense_categories (name) VALUES (?)`,
      [name]
    );
  }

  async updateCategory(id: number, name: string): Promise<void> {
    await this.base.runImmediate(
      `UPDATE expense_categories SET name = ? WHERE id = ?`,
      [name, id]
    );
  }

  async deleteCategory(id: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM expense_categories WHERE id = ?`,
      [id]
    );
  }

  async getCategoryUsageCount(id: number): Promise<number> {
    const row = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM expenses WHERE category_id = ?
         AND id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)`,
      [id]
    );
    return row?.cnt ?? 0;
  }

  async update(id: number, data: Partial<CreateExpenseInput>): Promise<void> {
    await this.base.runImmediate(
      `UPDATE expenses SET
         category_id = COALESCE(?, category_id),
         amount = COALESCE(?, amount),
         description = COALESCE(?, description),
         expense_date = COALESCE(?, expense_date),
         payment_method = COALESCE(?, payment_method)
       WHERE id = ?`,
      [
        data.category_id ?? null,
        data.amount ?? null,
        data.description ?? null,
        data.expense_date ?? null,
        data.payment_method ?? null,
        id,
      ]
    );
  }

  async getById(id: number): Promise<Expense | undefined> {
    return await this.base.getOne<Expense>(
      `SELECT e.*, ec.name as category_name, u.username
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       LEFT JOIN users u ON e.user_id = u.id
       WHERE e.id = ?`,
      [id]
    );
  }

  async getAll(filters: ExpenseFilters): Promise<PaginatedResult<Expense>> {
    const conditions: string[] = [
      // Exclude supplier payment expenses — those are tracked in purchase_payments
      'e.id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)',
    ];
    const params: unknown[] = [];

    if (filters.start_date)  { conditions.push("e.expense_date >= ?"); params.push(filters.start_date); }
    if (filters.end_date)    { conditions.push("e.expense_date <= ?"); params.push(filters.end_date); }
    if (filters.category_id) { conditions.push("e.category_id = ?");  params.push(Number(filters.category_id)); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const page  = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, Number(filters.limit) || PAGINATION.DEFAULT_LIMIT));
    const offset = (page - 1) * limit;

    const countRow = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM expenses e ${where}`,
      [...params]
    );
    const total = countRow?.cnt ?? 0;

    const data = await this.base.getAll<Expense>(
      `SELECT e.*, ec.name as category_name, u.username
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       LEFT JOIN users u ON e.user_id = u.id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  async create(data: CreateExpenseInput, userId: number, shiftId: number | null) {
    return await this.base.runImmediate(
      `INSERT INTO expenses (category_id, amount, description, expense_date, payment_method, user_id, shift_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.category_id,
        data.amount,
        data.description ?? null,
        data.expense_date,
        data.payment_method ?? 'cash',
        userId,
        shiftId,
      ]
    );
  }

  async delete(id: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM expenses WHERE id = ?`,
      [id]
    );
  }

  async getCashDropById(id: number): Promise<CashDrop | undefined> {
    return await this.base.getOne<CashDrop>(
      `SELECT cd.*, u.username FROM cash_drops cd
       JOIN users u ON cd.user_id = u.id
       WHERE cd.id = ?`,
      [id]
    );
  }

  async createCashDrop(data: CreateCashDropInput, userId: number, shiftId: number) {
    return await this.base.runImmediate(
      `INSERT INTO cash_drops (shift_id, amount, reason, user_id) VALUES (?, ?, ?, ?)`,
      [shiftId, data.amount, data.reason ?? null, userId]
    );
  }

  async getCashDrops(shiftId: number): Promise<CashDrop[]> {
    return await this.base.getAll<CashDrop>(
      `SELECT cd.*, u.username FROM cash_drops cd
       JOIN users u ON cd.user_id = u.id
       WHERE cd.shift_id = ?
       ORDER BY cd.created_at DESC`,
      [shiftId]
    );
  }
}
