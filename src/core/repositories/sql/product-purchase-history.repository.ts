import type { BaseRepository } from './base.repository';
import type { PurchasePaymentStatus } from '../../types/models';

export interface ProductPurchaseLine {
  purchase_item_id: number;
  purchase_id: number;
  purchase_number: string;
  invoice_reference: string | null;
  purchase_date: string;
  supplier_id: number | null;
  supplier_name: string | null;
  payment_status: PurchasePaymentStatus;
  entered_by: string | null;
  quantity_received: number;
  bonus_qty: number;
  conversion_factor: number;
  cost_per_parent: number;
  discount_pct: number;
  line_total: number;
  allocated_adjustment: number;
  effective_cost_per_parent: number;
  selling_price_parent: number;
  batch_id: number | null;
  batch_number: string | null;
  expiry_date: string | null;
  shelf_life_days: number | null;
  batch_remaining_base: number | null;
  batch_status: string | null;
  source_name: string | null;
  previous_cost: number | null;
}

export interface ProductPurchaseHistoryFilters {
  start_date?: string;
  end_date?: string;
  supplier_id?: number;
  payment_status?: PurchasePaymentStatus;
  in_stock_only?: boolean;
  limit?: number;
}

export interface ParkedLineMention {
  pending_item_id: number;
  purchase_id: number;
  purchase_number: string;
  purchase_date: string;
  supplier_name: string | null;
  raw_data: string;
}

/**
 * Read side of "product purchase lookup" (PL1–PL5): every invoice line for a
 * product with what happened to it since. Read-only. Invoice lines here carry
 * no bonus, discount or invoice-level charges, so the effective cost is the
 * invoice cost.
 */
export class ProductPurchaseHistoryRepository {
  constructor(private readonly base: BaseRepository) {}

  async getLines(productId: number, filters: ProductPurchaseHistoryFilters = {}): Promise<ProductPurchaseLine[]> {
    // Filters apply after "previous cost" is computed over the product's whole history.
    const outer: string[] = [];
    const params: unknown[] = [productId];
    if (filters.start_date) { outer.push('purchase_date >= ?'); params.push(filters.start_date); }
    if (filters.end_date) { outer.push('purchase_date <= ?'); params.push(filters.end_date); }
    if (filters.supplier_id) { outer.push('supplier_id = ?'); params.push(filters.supplier_id); }
    if (filters.payment_status) { outer.push('payment_status = ?'); params.push(filters.payment_status); }
    if (filters.in_stock_only) outer.push(`batch_remaining_base > 0 AND batch_status <> 'sold_out'`);
    const limit = filters.limit ? Math.min(Math.max(Math.trunc(filters.limit), 1), 5000) : 5000;
    params.push(limit);

    return await this.base.getAll<ProductPurchaseLine>(
      `WITH lines AS (
         SELECT pi.id AS purchase_item_id, pu.id AS purchase_id, pu.purchase_number, pu.invoice_reference,
                pu.purchase_date, pu.supplier_id, s.name AS supplier_name, pu.payment_status,
                u.full_name AS entered_by,
                pi.quantity_received, 0 AS bonus_qty,
                COALESCE(NULLIF(pi.conversion_factor_snapshot, 0), 1) AS conversion_factor,
                pi.cost_per_parent, 0 AS discount_pct,
                pi.line_total, 0 AS allocated_adjustment,
                pi.cost_per_parent AS effective_cost_per_parent,
                pi.selling_price_parent, pi.batch_id, pi.batch_number, pi.expiry_date,
                CASE WHEN pi.expiry_date IS NOT NULL AND pi.expiry_date <> '2099-12-31'
                     THEN CAST(julianday(pi.expiry_date) - julianday(pu.purchase_date) AS INTEGER) END AS shelf_life_days,
                b.quantity_base AS batch_remaining_base, b.status AS batch_status,
                NULL AS source_name,
                LAG(pi.cost_per_parent) OVER (ORDER BY pu.purchase_date, pi.id) AS previous_cost
         FROM purchase_items pi
         JOIN purchases pu ON pu.id = pi.purchase_id
         LEFT JOIN suppliers s ON s.id = pu.supplier_id
         LEFT JOIN users u ON u.id = pu.user_id
         LEFT JOIN batches b ON b.id = pi.batch_id
         WHERE pi.product_id = ?
       )
       SELECT * FROM lines
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY purchase_date DESC, purchase_item_id DESC
       LIMIT ?`,
      params
    );
  }

  /** Parked (not yet completed) invoice lines whose text mentions the product. */
  async getParkedMentions(terms: readonly string[], limit = 20): Promise<ParkedLineMention[]> {
    const usable = [...new Set(terms.map(t => t.trim()).filter(t => t.length >= 3))].slice(0, 3);
    if (usable.length === 0) return [];
    const pattern = (t: string) => `%${t.replace(/[%_\\]/g, '\\$&')}%`;
    return await this.base.getAll<ParkedLineMention>(
      `SELECT ppi.id AS pending_item_id, pu.id AS purchase_id, pu.purchase_number, pu.purchase_date,
              s.name AS supplier_name, ppi.raw_data
       FROM purchase_pending_items ppi
       JOIN purchases pu ON pu.id = ppi.purchase_id
       LEFT JOIN suppliers s ON s.id = pu.supplier_id
       WHERE ${usable.map(() => `ppi.raw_data LIKE ? ESCAPE '\\'`).join(' OR ')}
       ORDER BY pu.purchase_date DESC LIMIT ?`,
      [...usable.map(pattern), limit]
    );
  }
}
