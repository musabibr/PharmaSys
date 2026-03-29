import { BaseRepository } from './base.repository';
import type { RecurringExpense, CreateRecurringExpenseInput } from '../../types/models';

export class RecurringExpenseRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(): Promise<RecurringExpense[]> {
    return await this.base.getAll<RecurringExpense>(
      `SELECT re.*, ec.name as category_name, u.username as created_by_username,
              (SELECT MAX(e.expense_date) FROM expenses e
               WHERE e.recurring_expense_id = re.id AND e.is_recurring = 1) as last_generated_date
       FROM recurring_expenses re
       LEFT JOIN expense_categories ec ON re.category_id = ec.id
       LEFT JOIN users u ON re.created_by = u.id
       ORDER BY re.name`
    );
  }

  async getActive(): Promise<RecurringExpense[]> {
    return await this.base.getAll<RecurringExpense>(
      `SELECT re.*, ec.name as category_name,
              (SELECT MAX(e.expense_date) FROM expenses e
               WHERE e.recurring_expense_id = re.id AND e.is_recurring = 1) as last_generated_date
       FROM recurring_expenses re
       LEFT JOIN expense_categories ec ON re.category_id = ec.id
       WHERE re.is_active = 1
       ORDER BY re.name`
    );
  }

  async getById(id: number): Promise<RecurringExpense | undefined> {
    return await this.base.getOne<RecurringExpense>(
      `SELECT re.*, ec.name as category_name, u.username as created_by_username,
              (SELECT MAX(e.expense_date) FROM expenses e
               WHERE e.recurring_expense_id = re.id AND e.is_recurring = 1) as last_generated_date
       FROM recurring_expenses re
       LEFT JOIN expense_categories ec ON re.category_id = ec.id
       LEFT JOIN users u ON re.created_by = u.id
       WHERE re.id = ?`,
      [id]
    );
  }

  async create(data: CreateRecurringExpenseInput, userId: number) {
    const dayOfMonth = data.amount_type === 'monthly' ? (data.day_of_month ?? 1) : 1;
    return await this.base.runImmediate(
      `INSERT INTO recurring_expenses (name, category_id, amount_type, amount, payment_method, day_of_month, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.name, data.category_id, data.amount_type, data.amount, data.payment_method ?? 'cash', dayOfMonth, userId]
    );
  }

  async update(id: number, data: CreateRecurringExpenseInput): Promise<void> {
    const dayOfMonth = data.amount_type === 'monthly' ? (data.day_of_month ?? 1) : 1;
    await this.base.runImmediate(
      `UPDATE recurring_expenses
       SET name = ?, category_id = ?, amount_type = ?, amount = ?, payment_method = ?, day_of_month = ?
       WHERE id = ?`,
      [data.name, data.category_id, data.amount_type, data.amount, data.payment_method ?? 'cash', dayOfMonth, id]
    );
  }

  async delete(id: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM recurring_expenses WHERE id = ?`,
      [id]
    );
  }

  async setActive(id: number, isActive: boolean): Promise<void> {
    await this.base.runImmediate(
      `UPDATE recurring_expenses SET is_active = ? WHERE id = ?`,
      [isActive ? 1 : 0, id]
    );
  }

  async hasGeneratedExpenses(id: number): Promise<boolean> {
    const row = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM expenses WHERE recurring_expense_id = ?`,
      [id]
    );
    return (row?.cnt ?? 0) > 0;
  }

  async getGeneratedDates(recurringId: number, startDate: string, endDate: string): Promise<string[]> {
    const rows = await this.base.getAll<{ expense_date: string }>(
      `SELECT DISTINCT expense_date FROM expenses
       WHERE recurring_expense_id = ? AND expense_date BETWEEN ? AND ?`,
      [recurringId, startDate, endDate]
    );
    return rows.map(r => r.expense_date);
  }

  async getLastGeneratedDate(id: number): Promise<string | null> {
    const row = await this.base.getOne<{ last_date: string | null }>(
      `SELECT MAX(expense_date) as last_date FROM expenses
       WHERE recurring_expense_id = ? AND is_recurring = 1`,
      [id]
    );
    return row?.last_date ?? null;
  }
}
