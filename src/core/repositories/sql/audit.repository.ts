import type { BaseRepository } from './base.repository';
import type { IAuditRepository } from '../../types/repositories';
import type { AuditLog, AuditLogFilters, PaginatedResult } from '../../types/models';

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
    // Fire-and-forget: don't block on save for audit logs
    this.base['scheduleSaveFn']?.();
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

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await this.base.getOne<{ total: number }>(
      `SELECT COUNT(*) as total FROM audit_logs al ${where}`,
      [...params]
    );
    const total = countRow?.total ?? 0;

    const rows = await this.base.getAll<AuditLog>(
      `SELECT al.*, u.username
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async purgeOlderThan(days: number): Promise<number> {
    const result = await this.base.run(
      `DELETE FROM audit_logs WHERE created_at < datetime('now', ?)`,
      [`-${days} days`]
    );
    return result.changes;
  }
}
