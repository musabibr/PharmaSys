import type { BaseRepository } from './base.repository';
import type { CycleCount, CycleCountItem } from '../../types/models';

export class CycleCountRepository {
  constructor(private readonly base: BaseRepository) {}

  async inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return await this.base.inTransaction(work);
  }

  async getAll(): Promise<CycleCount[]> {
    return await this.base.getAll<CycleCount>(
      `SELECT c.*, u1.username as created_by_username, u2.username as assigned_to_username
       FROM cycle_counts c
       LEFT JOIN users u1 ON c.created_by = u1.id
       LEFT JOIN users u2 ON c.assigned_to = u2.id
       ORDER BY c.created_at DESC`
    );
  }

  async getById(id: number): Promise<CycleCount | undefined> {
    const cc = await this.base.getOne<CycleCount>(
      `SELECT c.*, u1.username as created_by_username, u2.username as assigned_to_username
       FROM cycle_counts c
       LEFT JOIN users u1 ON c.created_by = u1.id
       LEFT JOIN users u2 ON c.assigned_to = u2.id
       WHERE c.id = ?`,
      [id]
    );
    if (!cc) return undefined;
    
    const items = await this.base.getAll<CycleCountItem>(
      `SELECT i.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor, b.batch_number
       FROM cycle_count_items i
       JOIN products p ON i.product_id = p.id
       LEFT JOIN batches b ON i.batch_id = b.id
       WHERE i.cycle_count_id = ?
       ORDER BY p.name, b.expiry_date`,
      [id]
    );
    cc.items = items;
    return cc;
  }

  async create(data: { name: string; created_by: number; assigned_to?: number; notes?: string }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO cycle_counts (name, created_by, assigned_to, notes)
       VALUES (?, ?, ?, ?)`,
      [data.name, data.created_by, data.assigned_to ?? null, data.notes ?? null]
    );
  }

  async updateStatus(id: number, status: string, timestampField?: 'started_at' | 'completed_at'): Promise<void> {
    const timeSet = timestampField ? `, ${timestampField} = datetime('now', 'localtime')` : '';
    await this.base.runImmediate(
      `UPDATE cycle_counts SET status = ?${timeSet} WHERE id = ?`,
      [status, id]
    );
  }

  async addItems(items: Array<{ cycle_count_id: number; product_id: number; batch_id: number | null; expected_quantity: number }>): Promise<void> {
    for (const item of items) {
      await this.base.run(
        `INSERT INTO cycle_count_items (cycle_count_id, product_id, batch_id, expected_quantity)
         VALUES (?, ?, ?, ?)`,
        [item.cycle_count_id, item.product_id, item.batch_id, item.expected_quantity]
      );
    }
  }

  async updateItemCount(id: number, counted_quantity: number, variance: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE cycle_count_items
       SET counted_quantity = ?, variance = ?, status = 'counted'
       WHERE id = ?`,
      [counted_quantity, variance, id]
    );
  }

  async getItemById(id: number): Promise<CycleCountItem | undefined> {
    return await this.base.getOne<CycleCountItem>(
      `SELECT * FROM cycle_count_items WHERE id = ?`,
      [id]
    );
  }
}
