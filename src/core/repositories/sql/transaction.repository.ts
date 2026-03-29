import type { BaseRepository } from './base.repository';
import type { ITransactionRepository, ITransactionInsertData, ITransactionItemInsertData } from '../../types/repositories';
import type { Transaction, TransactionItem, TransactionFilters, PaginatedResult, ReturnedQuantityMap, ProductSaleRecord, ProductSaleFilters } from '../../types/models';
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

    const countRow = await this.base.getOne<{ count: number; agg_sales: number; agg_returns: number }>(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(CASE WHEN t.transaction_type='sale'   AND t.is_voided=0 THEN t.total_amount ELSE 0 END), 0) as agg_sales,
              COALESCE(SUM(CASE WHEN t.transaction_type='return' AND t.is_voided=0 THEN t.total_amount ELSE 0 END), 0) as agg_returns
       FROM transactions t ${where}`,
      [...params]
    );
    const total = countRow?.count ?? 0;
    const agg_sales = countRow?.agg_sales ?? 0;
    const agg_returns = countRow?.agg_returns ?? 0;

    const data = await this.base.getAll<Transaction>(
      `SELECT t.*, u.username, COALESCE(ret.returned_amount, 0) AS returned_amount
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN (
         SELECT parent_transaction_id, SUM(total_amount) AS returned_amount
         FROM transactions
         WHERE transaction_type = 'return' AND is_voided = 0
           AND parent_transaction_id IS NOT NULL
         GROUP BY parent_transaction_id
       ) ret ON ret.parent_transaction_id = t.id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit), agg_sales, agg_returns };
  }

  async getById(id: number): Promise<Transaction | undefined> {
    const txn = await this.base.getOne<Transaction>(
      `SELECT t.*, u.username, COALESCE(ret.returned_amount, 0) AS returned_amount
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN (
         SELECT parent_transaction_id, SUM(total_amount) AS returned_amount
         FROM transactions
         WHERE transaction_type = 'return' AND is_voided = 0
           AND parent_transaction_id IS NOT NULL
         GROUP BY parent_transaction_id
       ) ret ON ret.parent_transaction_id = t.id
       WHERE t.id = ?`,
      [id]
    );
    if (txn) {
      txn.items = await this.getItems(id);
      if (txn.transaction_type === 'sale') {
        txn.returns = await this.getReturnsByParent(id);
      }
    }
    return txn;
  }

  private async getReturnsByParent(parentId: number): Promise<Transaction[]> {
    return await this.base.getAll<Transaction>(
      `SELECT t.*, u.username
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.parent_transaction_id = ? AND t.transaction_type = 'return' AND t.is_voided = 0
       ORDER BY t.created_at ASC`,
      [parentId]
    );
  }

  async getItems(transactionId: number): Promise<TransactionItem[]> {
    return await this.base.getAll<TransactionItem>(
      `SELECT ti.*, p.name as product_name, p.parent_unit, p.child_unit,
              p.conversion_factor, p.is_active as product_is_active, b.batch_number
       FROM transaction_items ti
       LEFT JOIN products p ON ti.product_id = p.id
       LEFT JOIN batches b ON ti.batch_id = b.id
       WHERE ti.transaction_id = ?`,
      [transactionId]
    );
  }

  async getSalesByProduct(filters: ProductSaleFilters): Promise<PaginatedResult<ProductSaleRecord>> {
    const conditions = ['t.is_voided = 0', "t.transaction_type IN ('sale','return')"];
    const params: unknown[] = [];

    if (filters.product_ids && filters.product_ids.length > 0) {
      const placeholders = filters.product_ids.map(() => '?').join(',');
      conditions.push(`ti.product_id IN (${placeholders})`);
      params.push(...filters.product_ids);
    }
    if (filters.batch_id !== undefined)   { conditions.push('ti.batch_id = ?');          params.push(filters.batch_id); }
    if (filters.user_id !== undefined)    { conditions.push('t.user_id = ?');             params.push(filters.user_id); }
    if (filters.start_date)               { conditions.push("DATE(t.created_at) >= ?"); params.push(filters.start_date); }
    if (filters.end_date)                 { conditions.push("DATE(t.created_at) <= ?"); params.push(filters.end_date); }
    if (filters.transaction_type)         { conditions.push('t.transaction_type = ?');  params.push(filters.transaction_type); }

    const where  = `WHERE ${conditions.join(' AND ')}`;
    const page   = Math.max(1, filters.page  ?? 1);
    const limit  = Math.min(100, filters.limit ?? 25);
    const offset = (page - 1) * limit;

    const countRow = await this.base.getOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       ${where}`,
      [...params]
    );
    const total = countRow?.count ?? 0;

    const data = await this.base.getAll<ProductSaleRecord>(
      `SELECT ti.id as item_id, ti.transaction_id, ti.product_id,
              ti.batch_id, ti.quantity_base, ti.unit_type,
              ti.unit_price, ti.line_total, ti.conversion_factor_snapshot,
              t.transaction_number, t.transaction_type, t.created_at,
              t.customer_name, t.payment_method,
              u.username,
              p.name as product_name, p.parent_unit, p.child_unit,
              b.batch_number
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       JOIN users        u ON t.user_id = u.id
       JOIN products     p ON ti.product_id = p.id
       LEFT JOIN batches b ON ti.batch_id = b.id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async insert(data: ITransactionInsertData): Promise<number> {
    const params = [
      data.transaction_number, data.user_id, data.shift_id, data.transaction_type,
      data.subtotal, data.discount_amount, data.tax_amount, data.total_amount,
      data.payment_method, data.bank_name, data.reference_number,
      data.cash_tendered, data.payment,
      data.customer_name, data.customer_phone, data.notes,
      data.parent_transaction_id,
    ];

    if (data.created_at) {
      params.push(data.created_at);
      return await this.base.runReturningId(
        `INSERT INTO transactions (
           transaction_number, user_id, shift_id, transaction_type,
           subtotal, discount_amount, tax_amount, total_amount,
           payment_method, bank_name, reference_number,
           cash_tendered, payment,
           customer_name, customer_phone, notes,
           parent_transaction_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params
      );
    }

    return await this.base.runReturningId(
      `INSERT INTO transactions (
         transaction_number, user_id, shift_id, transaction_type,
         subtotal, discount_amount, tax_amount, total_amount,
         payment_method, bank_name, reference_number,
         cash_tendered, payment,
         customer_name, customer_phone, notes,
         parent_transaction_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
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
       SET is_voided = 1, void_reason = ?, voided_by = ?, voided_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [reason, voidedBy, id]
    );
  }

  async getReturnedQuantities(originalTransactionId: number): Promise<ReturnedQuantityMap> {
    // Key is batch_id only (not batch_id+unit_type) so that cross-unit returns
    // (e.g. returning strips from a box purchase) share the same base-unit pool.
    const rows = await this.base.getAll<{ batch_id: number; returned_base: number }>(
      `SELECT ti.batch_id, SUM(ti.quantity_base) as returned_base
       FROM transactions t
       JOIN transaction_items ti ON ti.transaction_id = t.id
       WHERE t.parent_transaction_id = ? AND t.transaction_type = 'return' AND t.is_voided = 0
       GROUP BY ti.batch_id`,
      [originalTransactionId]
    );
    const map: ReturnedQuantityMap = {};
    for (const r of rows) {
      map[`${r.batch_id}`] = r.returned_base;
    }
    return map;
  }

  async getNextNumber(prefix: string): Promise<string> {
    const n = new Date();
    const today = `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
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
