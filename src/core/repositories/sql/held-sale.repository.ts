import type { BaseRepository } from './base.repository';
import type { IHeldSaleRepository } from '../../types/repositories';
import type { HeldSale } from '../../types/models';

export class HeldSaleRepository implements IHeldSaleRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(userId?: number): Promise<HeldSale[]> {
    const rows = userId
      ? await this.base.getAll<HeldSale>(
          `SELECT * FROM held_sales WHERE user_id = ? ORDER BY created_at DESC`,
          [userId]
        )
      : await this.base.getAll<HeldSale>(
          `SELECT * FROM held_sales ORDER BY created_at DESC`
        );
    // Parse items_json safely
    return rows.map((row) => {
      try {
        row.items = JSON.parse(row.items_json as string);
      } catch {
        (row as HeldSale & { _corrupted?: boolean })._corrupted = true;
      }
      return row;
    });
  }

  async save(data: { user_id: number; customer_note: string | null; items_json: string; total_amount: number }) {
    return await this.base.runImmediate(
      `INSERT INTO held_sales (user_id, customer_note, items_json, total_amount) VALUES (?, ?, ?, ?)`,
      [data.user_id, data.customer_note, data.items_json, data.total_amount]
    );
  }

  async delete(id: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM held_sales WHERE id = ?`,
      [id]
    );
  }
}
