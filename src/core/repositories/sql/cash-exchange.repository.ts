import type { BaseRepository } from './base.repository';
import type { ICashExchangeRepository } from '../../types/repositories';
import type {
  CashExchange,
  CashExchangeFilters,
  CreateCashExchangeInput,
  PaginatedResult,
} from '../../types/models';
import { PAGINATION } from '../../common/constants';

/** Pure data-access repository for the independent bank-to-cash exchange ledger. */
export class CashExchangeRepository implements ICashExchangeRepository {
  constructor(private readonly base: BaseRepository) {}

  async getById(id: number): Promise<CashExchange | undefined> {
    return await this.base.getOne<CashExchange>(
      `SELECT ce.*, u.username,
              t.transaction_number,
              t.is_voided AS linked_transaction_is_voided
       FROM cash_exchanges ce
       JOIN users u ON u.id = ce.user_id
       LEFT JOIN transactions t ON t.id = ce.linked_transaction_id
       WHERE ce.id = ?`,
      [id],
    );
  }

  async getAll(filters: CashExchangeFilters): Promise<PaginatedResult<CashExchange>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.start_date) {
      conditions.push('DATE(ce.created_at) >= ?');
      params.push(filters.start_date);
    }
    if (filters.end_date) {
      conditions.push('DATE(ce.created_at) <= ?');
      params.push(filters.end_date);
    }
    if (filters.user_id) {
      conditions.push('ce.user_id = ?');
      params.push(filters.user_id);
    }
    if (filters.shift_id) {
      conditions.push('ce.shift_id = ?');
      params.push(filters.shift_id);
    }
    if (filters.linked_transaction_id) {
      conditions.push('ce.linked_transaction_id = ?');
      params.push(filters.linked_transaction_id);
    }
    if (filters.search?.trim()) {
      const q = `%${filters.search.trim()}%`;
      conditions.push(`(
        ce.bank_name LIKE ? OR ce.reference_number LIKE ? OR
        ce.customer_name LIKE ? OR ce.customer_phone LIKE ? OR
        t.transaction_number LIKE ?
      )`);
      params.push(q, q, q, q, q);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(
      PAGINATION.MAX_LIMIT,
      Math.max(PAGINATION.MIN_LIMIT, Number(filters.limit) || PAGINATION.DEFAULT_LIMIT),
    );
    const offset = (page - 1) * limit;

    const count = await this.base.getOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM cash_exchanges ce
       LEFT JOIN transactions t ON t.id = ce.linked_transaction_id
       ${where}`,
      params,
    );

    const data = await this.base.getAll<CashExchange>(
      `SELECT ce.*, u.username,
              t.transaction_number,
              t.is_voided AS linked_transaction_is_voided
       FROM cash_exchanges ce
       JOIN users u ON u.id = ce.user_id
       LEFT JOIN transactions t ON t.id = ce.linked_transaction_id
       ${where}
       ORDER BY ce.created_at DESC, ce.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const total = count?.total ?? 0;
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  async create(data: CreateCashExchangeInput & {
    user_id: number;
    shift_id: number | null;
    linked_transaction_id: number | null;
  }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO cash_exchanges (
         linked_transaction_id, shift_id, user_id,
         bank_name, reference_number, bank_amount, cash_amount,
         customer_name, customer_phone, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.linked_transaction_id,
        data.shift_id,
        data.user_id,
        data.bank_name,
        data.reference_number,
        data.bank_amount,
        data.cash_amount,
        data.customer_name ?? null,
        data.customer_phone ?? null,
        data.notes ?? null,
      ],
    );
  }
}
