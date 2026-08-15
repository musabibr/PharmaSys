import type { BaseRepository } from './base.repository';
import type { IAuditRepository } from '../../types/repositories';
import type { AuditLog, AuditLogFilters, PaginatedResult } from '../../types/models';

// Resolves the human-meaningful name for the row an audit event touched.
// record_id alone means nothing to a pharmacist/cashier: for table_name=
// 'batches' it's a batch id (an internal surrogate key with no shelf
// meaning), so it's resolved through to the product name it belongs to.
// Correlated subqueries, not a JOIN, because table_name decides which table
// record_id even refers to — a plain JOIN can't switch tables per row.
const PRODUCT_NAME_SQL = `
  CASE
    WHEN al.table_name = 'products' THEN (SELECT p.name FROM products p WHERE p.id = al.record_id)
    WHEN al.table_name = 'batches'  THEN (SELECT p.name FROM batches b JOIN products p ON p.id = b.product_id WHERE b.id = al.record_id)
    ELSE NULL
  END AS product_name`;
const BATCH_NUMBER_SQL = `
  CASE WHEN al.table_name = 'batches' THEN (SELECT b.batch_number FROM batches b WHERE b.id = al.record_id) ELSE NULL END AS batch_number`;

export class AuditRepository implements IAuditRepository {
  constructor(private readonly base: BaseRepository) {}

  async log(
    userId: number | null,
    action: string,
    tableName: string | null,
    recordId: number | null,
    oldValues?: Record<string, unknown> | null,
    newValues?: Record<string, unknown> | null
  ): Promise<void> {
    await this.base.rawRun(
      `INSERT INTO audit_logs (user_id, action, table_name, record_id, old_values, new_values)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        action,
        tableName,
        recordId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
      ]
    );
  }

  async getAll(filters: AuditLogFilters): Promise<PaginatedResult<AuditLog>> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.start_date) { conditions.push("al.created_at >= ?"); params.push(filters.start_date + ' 00:00:00'); }
    if (filters.end_date)   { conditions.push("al.created_at <= ?"); params.push(filters.end_date + ' 23:59:59'); }
    if (filters.user_id)    { conditions.push("al.user_id = ?");     params.push(filters.user_id); }
    if (filters.action) {
      // Support comma-separated multiple actions (e.g., "LOGIN,LOGOUT,CREATE_SALE")
      const actions = String(filters.action).split(',').map((a: string) => a.trim()).filter(Boolean);
      if (actions.length === 1) {
        conditions.push("al.action = ?");
        params.push(actions[0]);
      } else if (actions.length > 1) {
        conditions.push(`al.action IN (${actions.map(() => '?').join(',')})`);
        params.push(...actions);
      }
    }
    if (filters.table_name) { conditions.push("al.table_name = ?");  params.push(filters.table_name); }
    if (filters.record_id)  { conditions.push("al.record_id = ?");   params.push(filters.record_id); }
    if (filters.search && filters.search.trim()) {
      // Server-side, over the actual result set — not just the current page
      // (a client-side filter over one page of 25 rows can confidently
      // report "no matches" while thousands of matching rows sit on other
      // pages — see I5).
      conditions.push(
        `(al.action LIKE ? OR u.username LIKE ? OR al.old_values LIKE ? OR al.new_values LIKE ?)`
      );
      const like = `%${filters.search.trim()}%`;
      params.push(like, like, like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await this.base.getOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id ${where}`,
      [...params]
    );
    const total = countRow?.total ?? 0;

    const rows = await this.base.getAll<AuditLog>(
      `SELECT al.*, u.username, ${PRODUCT_NAME_SQL}, ${BATCH_NUMBER_SQL}
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * The audit log is the ONLY record of product/batch edits — it isn't log
   * rotation, it's the inventory paper trail. Purging is restricted to
   * high-volume, low-value rows (auth events; anything with no table_name)
   * so a routine cleanup can never delete the row a return needs to recover
   * a deleted batch's expiry (getDeletedBatchExpiry) or the history I4/I1
   * are built on (I8).
   */
  async purgeOlderThan(days: number): Promise<number> {
    const result = await this.base.run(
      `DELETE FROM audit_logs
       WHERE created_at < datetime('now', ?)
         AND (table_name IS NULL OR table_name NOT IN ('products', 'batches', 'transactions'))`,
      [`-${days} days`]
    );
    return result.changes;
  }

  /**
   * Full audit trail for one product: its own field edits (table_name=
   * 'products') plus every event against any batch that belongs to it
   * (table_name='batches', joined through batches.product_id — a batch
   * event's record_id is a batch id, so it can't be found by product_id
   * alone). This is what I4's "product history" panel needs beyond what
   * getAll()'s single-table record_id filter (I1) can express, and it only
   * exists because I2 first made table_name reliable for product-level
   * re-price events (PROPAGATE_SELLING_PRICE, CASCADE_CF_CHANGE, ...).
   */
  async getProductHistory(productId: number, limit = 100): Promise<AuditLog[]> {
    const cap = Math.min(500, Math.max(1, limit));
    return await this.base.getAll<AuditLog>(
      `SELECT al.*, u.username, ${PRODUCT_NAME_SQL}, ${BATCH_NUMBER_SQL} FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE (al.table_name = 'products' AND al.record_id = ?)
          OR (al.table_name = 'batches' AND al.record_id IN (
                SELECT id FROM batches WHERE product_id = ?
              ))
       ORDER BY al.created_at DESC
       LIMIT ?`,
      [productId, productId, cap]
    );
  }

  async getDeletedBatchExpiry(batchId: number): Promise<string | undefined> {
    const log = await this.base.getOne<{ old_values: string }>(
      `SELECT old_values FROM audit_logs 
       WHERE table_name = 'batches' AND action = 'DELETE_BATCH' AND record_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [batchId]
    );
    if (!log || !log.old_values) return undefined;
    try {
      const parsed = JSON.parse(log.old_values);
      return parsed.expiry_date;
    } catch {
      return undefined;
    }
  }
}
