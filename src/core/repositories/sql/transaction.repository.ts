import type { BaseRepository } from './base.repository';
import type { ITransactionRepository, ITransactionInsertData, ITransactionItemInsertData } from '../../types/repositories';
import type { Transaction, TransactionItem, TransactionFilters, PaginatedResult, ReturnedQuantityMap } from '../../types/models';
import { PAGINATION } from '../../common/constants';

export class TransactionRepository implements ITransactionRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(filters: TransactionFilters): Promise<PaginatedResult<Transaction>> {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (filters.start_date)     { conditions.push("DATE(t.created_at) >= ?"); params.push(filters.start_date); }
    if (filters.end_date)       { conditions.push("DATE(t.created_at) <= ?"); params.push(filters.end_date); }
    if (filters.transaction_type) { conditions.push("t.transaction_type = ?"); params.push(filters.transaction_type); }
    if (filters.user_id)        { conditions.push("t.user_id = ?");           params.push(filters.user_id); }
    if (filters.shift_id)       { conditions.push("t.shift_id = ?");          params.push(filters.shift_id); }
    if (filters.payment_method) { conditions.push("t.payment_method = ?");    params.push(filters.payment_method); }
    if (filters.is_voided != null) {
      conditions.push("t.is_voided = ?");
      params.push(filters.is_voided ? 1 : 0);
    }
    if (filters.min_amount != null) { conditions.push("t.total_amount >= ?"); params.push(filters.min_amount); }
    if (filters.max_amount != null) { conditions.push("t.total_amount <= ?"); params.push(filters.max_amount); }
    if (filters.search) {
      const q = `%${String(filters.search).slice(0, 100)}%`;
      conditions.push(`(t.transaction_number = ? OR t.customer_name LIKE ? OR t.customer_phone LIKE ? OR t.reference_number LIKE ?)`);
      params.push(String(filters.search).slice(0, 100), q, q, q);
    }

    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, filters.limit ?? PAGINATION.DEFAULT_LIMIT));
    const offset = (page - 1) * limit;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRow = await this.base.getOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM transactions t ${where}`,
      [...params]
    );
    const total = countRow?.count ?? 0;

    const data = await this.base.getAll<Transaction>(
      `SELECT t.*, u.username
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getById(id: number): Promise<Transaction | undefined> {
    const txn = await this.base.getOne<Transaction>(
      `SELECT t.*, u.username
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.id = ?`,
      [id]
    );
    if (txn) {
      txn.items = await this.getItems(id);
    }
    return txn;
  }

  async getItems(transactionId: number): Promise<TransactionItem[]> {
    return await this.base.getAll<TransactionItem>(
      `SELECT ti.*, p.name as product_name, p.parent_unit, p.child_unit,
              p.conversion_factor, b.batch_number
       FROM transaction_items ti
       JOIN products p ON ti.product_id = p.id
       JOIN batches b ON ti.batch_id = b.id
       WHERE ti.transaction_id = ?`,
      [transactionId]
    );
  }

  async insert(data: ITransactionInsertData): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO transactions (
         transaction_number, user_id, shift_id, transaction_type,
         subtotal, discount_amount, tax_amount, total_amount,
         payment_method, bank_name, reference_number,
         cash_tendered, payment,
         customer_name, customer_phone, notes,
         parent_transaction_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.transaction_number, data.user_id, data.shift_id, data.transaction_type,
        data.subtotal, data.discount_amount, data.tax_amount, data.total_amount,
        data.payment_method, data.bank_name, data.reference_number,
        data.cash_tendered, data.payment,
        data.customer_name, data.customer_phone, data.notes,
        data.parent_transaction_id,
      ]
    );
  }

  async insertItem(data: ITransactionItemInsertData): Promise<void> {
    await this.base.rawRun(
      `INSERT INTO transaction_items (
         transaction_id, product_id, batch_id, quantity_base,
         unit_type, unit_price, cost_price, discount_percent,
         line_total, gross_profit, conversion_factor_snapshot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.transaction_id, data.product_id, data.batch_id, data.quantity_base,
        data.unit_type, data.unit_price, data.cost_price, data.discount_percent,
        data.line_total, data.gross_profit, data.conversion_factor_snapshot,
      ]
    );
  }

  async markVoided(id: number, reason: string, voidedBy: number): Promise<void> {
    await this.base.rawRun(
      `UPDATE transactions
       SET is_voided = 1, void_reason = ?, voided_by = ?, voided_at = datetime('now')
       WHERE id = ?`,
      [reason, voidedBy, id]
    );
  }

  async getReturnedQuantities(originalTransactionId: number): Promise<ReturnedQuantityMap> {
    const rows = await this.base.getAll<{ batch_id: number; unit_type: string; returned_base: number }>(
      `SELECT ti.batch_id, ti.unit_type, SUM(ti.quantity_base) as returned_base
       FROM transactions t
       JOIN transaction_items ti ON ti.transaction_id = t.id
       WHERE t.parent_transaction_id = ? AND t.transaction_type = 'return' AND t.is_voided = 0
       GROUP BY ti.batch_id, ti.unit_type`,
      [originalTransactionId]
    );
    const map: ReturnedQuantityMap = {};
    for (const r of rows) {
      map[`${r.batch_id}_${r.unit_type}`] = r.returned_base;
    }
    return map;
  }

  async getNextNumber(prefix: string): Promise<string> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const like = `${prefix}-${today}-%`;
    const last = await this.base.getOne<{ transaction_number: string }>(
      `SELECT transaction_number FROM transactions
       WHERE transaction_number LIKE ? ORDER BY id DESC LIMIT 1`,
      [like]
    );
    if (last) {
      const parts = last.transaction_number.split('-');
      const seq = parseInt(parts[parts.length - 1] ?? '0', 10) + 1;
      return `${prefix}-${today}-${String(seq).padStart(4, '0')}`;
    }
    return `${prefix}-${today}-0001`;
  }
}
