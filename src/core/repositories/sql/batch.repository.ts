import type { BaseRepository } from './base.repository';
import type { IBatchRepository, IFIFOBatch } from '../../types/repositories';
import type {
  Batch, BatchStatus, CreateBatchInput, UpdateBatchInput,
  InventoryAdjustment, AdjustmentFilters, AdjustmentType, BatchFilters,
} from '../../types/models';
import { Money } from '../../common/money';

export class BatchRepository implements IBatchRepository {
  constructor(private readonly base: BaseRepository) {}

  async getByProduct(productId: number): Promise<Batch[]> {
    return await this.base.getAll<Batch>(
      `SELECT b.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor
       FROM batches b
       JOIN products p ON b.product_id = p.id
       WHERE b.product_id = ?
       ORDER BY b.expiry_date, b.id`,
      [productId]
    );
  }

  async getById(id: number): Promise<Batch | undefined> {
    return await this.base.getOne<Batch>(
      `SELECT b.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor
       FROM batches b
       JOIN products p ON b.product_id = p.id
       WHERE b.id = ?`,
      [id]
    );
  }

  async getAvailableByProduct(productId: number): Promise<IFIFOBatch[]> {
    return await this.base.getAll<IFIFOBatch>(
      `SELECT b.id, b.product_id, b.quantity_base, b.expiry_date,
              b.cost_per_parent, b.cost_per_child, b.cost_per_child_override,
              b.selling_price_parent, b.selling_price_child,
              b.selling_price_parent_override, b.selling_price_child_override,
              b.status, b.version, p.conversion_factor
       FROM batches b
       JOIN products p ON b.product_id = p.id
       WHERE b.product_id = ? AND b.status = 'active' AND b.quantity_base > 0
         AND b.expiry_date > date('now')
       ORDER BY b.expiry_date, b.id`,
      [productId]
    );
  }

  async getAllAvailable(filters: { categoryId?: number; search?: string } = {}): Promise<Batch[]> {
    let sql = `SELECT b.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor,
               c.name as category_name
               FROM batches b
               JOIN products p ON b.product_id = p.id
               LEFT JOIN categories c ON p.category_id = c.id
               WHERE b.quantity_base > 0
                 AND b.status = 'active'`;
    const params: unknown[] = [];

    if (filters.categoryId) {
      sql += ' AND p.category_id = ?';
      params.push(filters.categoryId);
    }

    if (filters.search) {
      const term = `%${filters.search}%`;
      sql += ' AND (p.name LIKE ? ESCAPE "\\" OR p.generic_name LIKE ? ESCAPE "\\" OR p.barcode LIKE ? ESCAPE "\\" OR b.batch_number LIKE ? ESCAPE "\\")';
      params.push(term, term, term, term);
    }

    sql += ' ORDER BY p.name ASC, b.expiry_date ASC';

    return await this.base.getAll<Batch>(sql, params);
  }

  async getAll(filters: BatchFilters = {}): Promise<Batch[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) { conditions.push('b.status = ?');              params.push(filters.status); }
    if (filters.category_id) { conditions.push('p.category_id = ?');   params.push(filters.category_id); }
    if (filters.search) {
      const like = `%${filters.search.replace(/[%_\\]/g, '\\$&')}%`;
      conditions.push('(p.name LIKE ? OR b.batch_number LIKE ?)');
      params.push(like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(500, filters.limit ?? 100);
    const offset = (page - 1) * limit;

    return await this.base.getAll<Batch>(
      `SELECT b.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor
       FROM batches b
       JOIN products p ON b.product_id = p.id
       ${where}
       ORDER BY b.expiry_date, p.name
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
  }

  async create(data: CreateBatchInput) {
    const cf = data.quantity_base; // will be stored as base units directly
    const costChild = data.cost_per_child_override
      ? data.cost_per_child_override
      : Money.divideToChild(data.cost_per_parent, 1); // actual cf injected by service
    const sellChild = data.selling_price_child_override
      ? data.selling_price_child_override
      : 0;

    return await this.base.runImmediate(
      `INSERT INTO batches (product_id, batch_number, expiry_date, quantity_base,
       cost_per_parent, cost_per_child, cost_per_child_override,
       selling_price_parent, selling_price_child,
       selling_price_parent_override, selling_price_child_override, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        data.product_id,
        data.batch_number ?? null,
        data.expiry_date,
        data.quantity_base,
        data.cost_per_parent,
        costChild,
        data.cost_per_child_override ?? costChild,
        data.selling_price_parent ?? null,
        sellChild,
        data.selling_price_parent ?? 0,
        data.selling_price_child_override ?? sellChild,
      ]
    );
  }

  async update(id: number, data: Partial<UpdateBatchInput>): Promise<void> {
    await this.base.runImmediate(
      `UPDATE batches SET
         batch_number = COALESCE(?, batch_number),
         expiry_date = COALESCE(?, expiry_date),
         cost_per_parent = COALESCE(?, cost_per_parent),
         selling_price_parent = COALESCE(?, selling_price_parent),
         selling_price_parent_override = COALESCE(?, selling_price_parent_override),
         cost_per_child_override = COALESCE(?, cost_per_child_override),
         selling_price_child_override = COALESCE(?, selling_price_child_override),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ?`,
      [
        data.batch_number ?? null,
        data.expiry_date ?? null,
        data.cost_per_parent ?? null,
        data.selling_price_parent ?? null,
        data.selling_price_parent_override ?? null,
        data.cost_per_child_override ?? null,
        data.selling_price_child_override ?? null,
        data.status ?? null,
        id,
      ]
    );
  }

  /**
   * Atomically update batch quantity with optimistic locking.
   * Returns false if the version has changed (concurrent modification detected).
   */
  async updateQuantityOptimistic(
    id: number,
    newQuantityBase: number,
    newStatus: BatchStatus,
    expectedVersion: number
  ): Promise<boolean> {
    const changes = await this.base.runAndGetChanges(
      `UPDATE batches
       SET quantity_base = ?, status = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ?`,
      [newQuantityBase, newStatus, id, expectedVersion]
    );
    return changes > 0;
  }

  async getExpiring(days: number): Promise<Batch[]> {
    return await this.base.getAll<Batch>(
      `SELECT b.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor
       FROM batches b
       JOIN products p ON b.product_id = p.id
       WHERE b.status = 'active'
         AND b.quantity_base > 0
         AND b.expiry_date > date('now')
         AND b.expiry_date <= date('now', ?)
       ORDER BY b.expiry_date, p.name`,
      [`+${days} days`]
    );
  }

  async getExpired(): Promise<Batch[]> {
    return await this.base.getAll<Batch>(
      `SELECT b.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor
       FROM batches b
       JOIN products p ON b.product_id = p.id
       WHERE b.expiry_date <= date('now') AND b.status = 'active' AND b.quantity_base > 0
       ORDER BY b.expiry_date, p.name`
    );
  }

  async insertAdjustment(data: {
    product_id: number;
    batch_id: number;
    quantity_base: number;
    reason: string | null;
    type: AdjustmentType;
    user_id: number;
  }) {
    return await this.base.run(
      `INSERT INTO inventory_adjustments
       (product_id, batch_id, quantity_base, reason, type, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.product_id, data.batch_id, data.quantity_base, data.reason, data.type, data.user_id]
    );
  }

  async getAdjustments(filters: AdjustmentFilters = {}): Promise<InventoryAdjustment[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.product_id) { conditions.push('ia.product_id = ?'); params.push(filters.product_id); }
    if (filters.batch_id)   { conditions.push('ia.batch_id = ?');   params.push(filters.batch_id); }
    if (filters.type)       { conditions.push('ia.type = ?');        params.push(filters.type); }
    if (filters.start_date) { conditions.push("ia.created_at >= ?"); params.push(filters.start_date + ' 00:00:00'); }
    if (filters.end_date)   { conditions.push("ia.created_at <= ?"); params.push(filters.end_date + ' 23:59:59'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return await this.base.getAll<InventoryAdjustment>(
      `SELECT ia.*, p.name as product_name, b.batch_number, u.username
       FROM inventory_adjustments ia
       LEFT JOIN products p ON ia.product_id = p.id
       LEFT JOIN batches b ON ia.batch_id = b.id
       LEFT JOIN users u ON ia.user_id = u.id
       ${where}
       ORDER BY ia.created_at DESC`,
      params
    );
  }
}
