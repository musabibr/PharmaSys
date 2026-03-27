import type { BaseRepository } from './base.repository';
import type { IProductRepository } from '../../types/repositories';
import type { Product, ProductFilters, PaginatedResult, CreateProductInput, UpdateProductInput, BulkCreateProductInput } from '../../types/models';
import { Money } from '../../common/money';
import { PAGINATION } from '../../common/constants';

export class ProductRepository implements IProductRepository {
  constructor(private readonly base: BaseRepository) {}

  private static readonly STOCK_SUBQUERY =
    `COALESCE((SELECT SUM(b.quantity_base) FROM batches b
      WHERE b.product_id = p.id AND b.status = 'active' AND b.quantity_base > 0), 0) as total_stock_base`;

  /** Effective parent selling price from the first FIFO (oldest-expiry) active batch. */
  private static readonly SELL_PRICE_SUBQUERY =
    `COALESCE((SELECT CASE WHEN b.selling_price_parent_override > 0
                           THEN b.selling_price_parent_override
                           ELSE b.selling_price_parent END
              FROM batches b
              WHERE b.product_id = p.id AND b.status = 'active' AND b.quantity_base > 0
              ORDER BY b.expiry_date ASC, b.id ASC LIMIT 1), 0) as selling_price,
     COALESCE((SELECT CASE WHEN b.selling_price_child_override > 0
                           THEN b.selling_price_child_override
                           ELSE COALESCE(b.selling_price_child, 0) END
              FROM batches b
              WHERE b.product_id = p.id AND b.status = 'active' AND b.quantity_base > 0
              ORDER BY b.expiry_date ASC, b.id ASC LIMIT 1), 0) as selling_price_child`;

  async getAll(search?: string): Promise<Product[]> {
    if (search) return this.search(search);
    return await this.base.getAll<Product>(
      `SELECT p.*, c.name as category_name, ${ProductRepository.STOCK_SUBQUERY},
              ${ProductRepository.SELL_PRICE_SUBQUERY}
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = 1
       ORDER BY p.name`
    );
  }

  async getList(filters: ProductFilters): Promise<PaginatedResult<Product>> {
    const conditions: string[] = ['p.is_active = 1'];
    const params: unknown[] = [];

    if (filters.search) {
      const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
      const like = `%${escaped}%`;
      conditions.push(`(p.name LIKE ? OR p.generic_name LIKE ? OR p.barcode LIKE ?)`);
      params.push(like, like, like);
    }
    if (filters.category_id) {
      conditions.push('p.category_id = ?');
      params.push(filters.category_id);
    }

    const page  = Math.max(1, filters.page ?? 1);
    const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, filters.limit ?? PAGINATION.DEFAULT_LIMIT));
    const offset = (page - 1) * limit;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const sortCol = filters.sort_by === 'created_at' ? 'p.created_at' : 'p.name';
    const sortDir = filters.sort_dir === 'desc' ? 'DESC' : 'ASC';

    const countRow = await this.base.getOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM products p ${where}`,
      [...params]
    );
    const total = countRow?.count ?? 0;

    const data = await this.base.getAll<Product>(
      `SELECT p.*, c.name as category_name, ${ProductRepository.STOCK_SUBQUERY},
              ${ProductRepository.SELL_PRICE_SUBQUERY}
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  async getById(id: number): Promise<Product | undefined> {
    return await this.base.getOne<Product>(
      `SELECT p.*, c.name as category_name, ${ProductRepository.STOCK_SUBQUERY},
              ${ProductRepository.SELL_PRICE_SUBQUERY}
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ?`,
      [id]
    );
  }

  async search(query: string): Promise<Product[]> {
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const like = `%${escaped}%`;
    return await this.base.getAll<Product>(
      `SELECT p.*, c.name as category_name, ${ProductRepository.STOCK_SUBQUERY},
              ${ProductRepository.SELL_PRICE_SUBQUERY}
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = 1
         AND (p.name LIKE ? OR p.generic_name LIKE ? OR p.barcode LIKE ?)
       ORDER BY p.name
       LIMIT 100`,
      [like, like, like]
    );
  }

  async findByName(name: string): Promise<Product | undefined> {
    return await this.base.getOne<Product>(
      `SELECT p.*, c.name as category_name, ${ProductRepository.STOCK_SUBQUERY},
              ${ProductRepository.SELL_PRICE_SUBQUERY}
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = 1 AND LOWER(TRIM(p.name)) = LOWER(TRIM(?))`,
      [name]
    );
  }

  async findByBarcode(barcode: string): Promise<Product | undefined> {
    return await this.base.getOne<Product>(
      `SELECT p.*, c.name as category_name, ${ProductRepository.STOCK_SUBQUERY},
              ${ProductRepository.SELL_PRICE_SUBQUERY}
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = 1 AND p.barcode = ?`,
      [barcode]
    );
  }

  async create(data: CreateProductInput, categoryId: number | null) {
    return await this.base.runImmediate(
      `INSERT INTO products (name, generic_name, usage_instructions, category_id,
       barcode, parent_unit, child_unit, conversion_factor, min_stock_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.generic_name ?? null,
        data.usage_instructions ?? null,
        categoryId,
        data.barcode ?? null,
        data.parent_unit ?? 'Box',
        data.child_unit ?? 'Strip',
        data.conversion_factor ?? 1,
        data.min_stock_level ?? 0,
      ]
    );
  }

  async update(id: number, data: UpdateProductInput): Promise<void> {
    await this.base.runImmediate(
      `UPDATE products SET
         name = COALESCE(?, name),
         generic_name = COALESCE(?, generic_name),
         usage_instructions = COALESCE(?, usage_instructions),
         category_id = ${'category_id' in data ? '?' : 'category_id'},
         barcode = COALESCE(?, barcode),
         parent_unit = COALESCE(?, parent_unit),
         child_unit = COALESCE(?, child_unit),
         conversion_factor = COALESCE(?, conversion_factor),
         min_stock_level = COALESCE(?, min_stock_level),
         is_active = COALESCE(?, is_active),
         updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [
        data.name ?? null,
        data.generic_name ?? null,
        data.usage_instructions ?? null,
        ...('category_id' in data ? [data.category_id ?? null] : []),
        data.barcode ?? null,
        data.parent_unit ?? null,
        data.child_unit ?? null,
        data.conversion_factor ?? null,
        data.min_stock_level ?? null,
        data.is_active !== undefined ? (data.is_active ? 1 : 0) : null,
        id,
      ]
    );
  }

  async softDelete(id: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE products SET is_active = 0, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [id]
    );
  }

  async hasActiveBatches(id: number): Promise<boolean> {
    // Check ANY batch with stock (active, quarantine, or sold_out with remaining quantity)
    // Also check batches referenced by transactions or adjustments
    const row = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM batches
       WHERE product_id = ? AND (quantity_base > 0 OR
         EXISTS (SELECT 1 FROM transaction_items WHERE batch_id = batches.id) OR
         EXISTS (SELECT 1 FROM inventory_adjustments WHERE batch_id = batches.id))`,
      [id]
    );
    return (row?.cnt ?? 0) > 0;
  }

  async getDeleteInfo(id: number): Promise<{ has_stock: boolean; batch_count: number; txn_count: number }> {
    const stockRow = await this.base.getOne<{ qty: number; batches: number }>(
      `SELECT COALESCE(SUM(quantity_base), 0) as qty, COUNT(*) as batches
       FROM batches WHERE product_id = ? AND quantity_base > 0`,
      [id]
    );
    const txnRow = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(DISTINCT ti.transaction_id) as cnt
       FROM transaction_items ti JOIN batches b ON b.id = ti.batch_id WHERE b.product_id = ?`,
      [id]
    );
    return {
      has_stock: (stockRow?.qty ?? 0) > 0,
      batch_count: stockRow?.batches ?? 0,
      txn_count: txnRow?.cnt ?? 0,
    };
  }

  async bulkCreate(items: BulkCreateProductInput[]): Promise<Array<{ success: boolean; name: string; error?: string }>> {
    const results: Array<{ success: boolean; name: string; error?: string }> = [];

    await this.base.inTransaction(async () => {
      for (const item of items) {
        try {
          // Resolve or create category
          let categoryId: number | null = null;
          if (item.category_name) {
            const cat = await this.base.getOne<{ id: number }>(
              `SELECT id FROM categories WHERE name = ?`,
              [item.category_name]
            );
            if (cat) {
              categoryId = cat.id;
            } else {
              const catResult = await this.base.run(
                `INSERT INTO categories (name) VALUES (?)`,
                [item.category_name]
              );
              categoryId = catResult.lastInsertRowid;
            }
          }

          // Insert product
          const prodResult = await this.base.run(
            `INSERT INTO products (name, generic_name, category_id, barcode,
             parent_unit, child_unit, conversion_factor, min_stock_level)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.name,
              item.generic_name ?? null,
              categoryId,
              item.barcode ?? null,
              item.parent_unit ?? 'Box',
              item.child_unit ?? 'Strip',
              item.conversion_factor ?? 1,
              item.min_stock_level ?? 0,
            ]
          );

          // Insert initial batch
          const cf = item.conversion_factor ?? 1;
          const costChild = Money.divideToChild(item.cost_per_parent, cf);
          const sellChild = Money.divideToChild(item.selling_price_parent, cf);

          await this.base.run(
            `INSERT INTO batches (product_id, batch_number, expiry_date, quantity_base,
             cost_per_parent, cost_per_child, cost_per_child_override,
             selling_price_parent, selling_price_child,
             selling_price_parent_override, selling_price_child_override, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              prodResult.lastInsertRowid,
              item.batch_number ?? null,
              item.expiry_date,
              item.quantity_base,
              item.cost_per_parent,
              costChild,
              costChild,
              item.selling_price_parent,
              sellChild,
              item.selling_price_parent,
              sellChild,
            ]
          );

          results.push({ success: true, name: item.name });
        } catch (err) {
          results.push({ success: false, name: item.name, error: (err as Error).message });
        }
      }
    });

    this.base.save();
    return results;
  }
}
