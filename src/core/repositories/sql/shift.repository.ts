import type { BaseRepository } from './base.repository';
import type { IShiftRepository } from '../../types/repositories';
import type { Shift, ShiftFilters, ShiftExpectedCash, ShiftReport, PaginatedResult, Transaction, Expense, CashDrop } from '../../types/models';
import { NotFoundError } from '../../types/errors';

export class ShiftRepository implements IShiftRepository {
  constructor(private readonly base: BaseRepository) {}

  async getCurrent(userId: number): Promise<Shift | undefined> {
    return await this.base.getOne<Shift>(
      `SELECT s.*, u.username
       FROM shifts s JOIN users u ON s.user_id = u.id
       WHERE s.user_id = ? AND s.status = 'open'`,
      [userId]
    );
  }

  async findOpenByUser(userId: number): Promise<Shift | undefined> {
    return await this.base.getOne<Shift>(
      `SELECT * FROM shifts WHERE user_id = ? AND status = 'open'`,
      [userId]
    );
  }

  async getById(id: number): Promise<Shift | undefined> {
    return await this.base.getOne<Shift>(
      `SELECT s.*, u.username FROM shifts s JOIN users u ON s.user_id = u.id WHERE s.id = ?`,
      [id]
    );
  }

  async getAll(filters: ShiftFilters): Promise<PaginatedResult<Shift>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.start_date) { conditions.push("s.opened_at >= ?"); params.push(filters.start_date + ' 00:00:00'); }
    if (filters.end_date)   { conditions.push("s.opened_at <= ?"); params.push(filters.end_date + ' 23:59:59'); }
    if (filters.user_id)    { conditions.push("s.user_id = ?");    params.push(filters.user_id); }
    if (filters.status)     { conditions.push("s.status = ?");     params.push(filters.status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(200, filters.limit ?? 50);
    const offset = (page - 1) * limit;

    const countRow = await this.base.getOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM shifts s ${where}`, [...params]
    );
    const total = countRow?.total ?? 0;

    const data = await this.base.getAll<Shift>(
      `SELECT s.*, u.username
       FROM shifts s JOIN users u ON s.user_id = u.id
       ${where}
       ORDER BY s.opened_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async open(userId: number, openingAmount: number) {
    return await this.base.runImmediate(
      `INSERT INTO shifts (user_id, opened_at, opening_amount, status)
       VALUES (?, datetime('now'), ?, 'open')`,
      [userId, openingAmount]
    );
  }

  async close(id: number, data: {
    expected_cash: number;
    actual_cash: number;
    variance: number;
    variance_type: string;
    notes: string | null;
  }): Promise<void> {
    await this.base.runImmediate(
      `UPDATE shifts
       SET closed_at = datetime('now'), expected_cash = ?, actual_cash = ?,
           variance = ?, variance_type = ?, notes = ?, status = 'closed'
       WHERE id = ?`,
      [data.expected_cash, data.actual_cash, data.variance, data.variance_type, data.notes, id]
    );
  }

  async getExpectedCash(shiftId: number): Promise<ShiftExpectedCash> {
    const shift = await this.base.getOne<{ opening_amount: number }>(
      'SELECT opening_amount FROM shifts WHERE id = ?', [shiftId]
    );
    if (!shift) throw new NotFoundError('Shift', shiftId);

    const cashIn  = await this.base.getOne<{ total: number }>(
      `SELECT COALESCE(SUM(cash_tendered), 0) as total FROM transactions
       WHERE shift_id = ? AND is_voided = 0 AND transaction_type = 'sale'`,
      [shiftId]
    );
    const cashOut = await this.base.getOne<{ total: number }>(
      `SELECT COALESCE(SUM(cash_tendered), 0) as total FROM transactions
       WHERE shift_id = ? AND is_voided = 0 AND transaction_type = 'return'`,
      [shiftId]
    );
    const cashExp = await this.base.getOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses
       WHERE shift_id = ? AND (payment_method = 'cash' OR payment_method IS NULL)
         AND id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)`,
      [shiftId]
    );
    const cashDrops = await this.base.getOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM cash_drops WHERE shift_id = ?`,
      [shiftId]
    );

    const opening  = shift.opening_amount ?? 0;
    const salesCash   = cashIn?.total ?? 0;
    const returnsCash = cashOut?.total ?? 0;
    const expenses    = cashExp?.total ?? 0;
    const drops       = cashDrops?.total ?? 0;
    const expected    = Math.round(opening + salesCash - returnsCash - expenses - drops);

    return {
      opening_amount: opening,
      total_cash_sales: salesCash,
      total_cash_returns: returnsCash,
      total_cash_expenses: expenses,
      total_cash_drops: drops,
      expected_cash: expected,
    };
  }

  async getReport(shiftId: number): Promise<ShiftReport | undefined> {
    const shift = await this.getById(shiftId);
    if (!shift) return undefined;

    const transactions = await this.base.getAll<Transaction>(
      `SELECT t.*, u.username FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.shift_id = ? ORDER BY t.created_at DESC`,
      [shiftId]
    );
    const expenses = await this.base.getAll<Expense>(
      `SELECT e.*, ec.name as category_name FROM expenses e
       JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.shift_id = ?
         AND e.id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)`,
      [shiftId]
    );
    const cashDrops = await this.base.getAll<CashDrop>(
      `SELECT cd.*, u.username FROM cash_drops cd
       JOIN users u ON cd.user_id = u.id
       WHERE cd.shift_id = ?`,
      [shiftId]
    );

    const sales    = transactions.filter(t => t.transaction_type === 'sale'   && !t.is_voided);
    const returns_ = transactions.filter(t => t.transaction_type === 'return' && !t.is_voided);

    return {
      shift,
      transactions,
      expenses,
      cash_drops: cashDrops,
      summary: {
        total_sales:     sales.reduce((s, t)    => s + t.total_amount, 0),
        total_returns:   returns_.reduce((s, t) => s + t.total_amount, 0),
        total_expenses:  expenses.reduce((s, e) => s + e.amount, 0),
        total_cash_drops: cashDrops.reduce((s, d) => s + d.amount, 0),
        transaction_count: sales.length,
      },
    };
  }

  /**
   * Return the IDs of the user's most recent N shifts (open or closed),
   * ordered newest-first.
   */
  async getLastNShiftIds(userId: number, n: number): Promise<number[]> {
    const rows = await this.base.getAll<{ id: number }>(
      `SELECT id FROM shifts WHERE user_id = ? ORDER BY opened_at DESC LIMIT ?`,
      [userId, n]
    );
    return rows.map(r => r.id);
  }

  async findStaleShifts(maxAgeHours: number = 24): Promise<Shift[]> {
    return await this.base.getAll<Shift>(
      `SELECT s.*, u.username
       FROM shifts s JOIN users u ON s.user_id = u.id
       WHERE s.status = 'open'
         AND s.opened_at < datetime('now', '-' || ? || ' hours')`,
      [maxAgeHours]
    );
  }

  async getLastClosedCash(userId: number): Promise<number> {
    // Cash drawer is shared — show the LAST person's closing amount (any user)
    // so the next pharmacist can verify the physical cash in the drawer
    const row = await this.base.getOne<{ actual_cash: number }>(
      `SELECT actual_cash FROM shifts
       WHERE status = 'closed' AND actual_cash IS NOT NULL
       ORDER BY closed_at DESC LIMIT 1`
    );
    return row?.actual_cash ?? 0;
  }
}
