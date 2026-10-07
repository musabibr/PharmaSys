import type { BaseRepository } from './base.repository';
import type { PaginatedResult } from '../../types/models';
import { TODAY_SQL } from '../../common/expiry';

export type PurchaseOrderStatus = 'draft' | 'sent' | 'closed' | 'cancelled';
export type ReceiptStatus = 'none' | 'partial' | 'complete';

export interface PurchaseOrder {
  id: number;
  po_number: string;
  supplier_id: number;
  status: PurchaseOrderStatus;
  order_date: string;
  expected_date: string | null;
  notes: string | null;
  user_id: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  // Joined / computed
  supplier_name?: string;
  supplier_phone?: string | null;
  username?: string | null;
  lines?: number;
  ordered_units?: number;
  received_units?: number;
  expected_value?: number;
  invoices?: number;
}

export interface PurchaseOrderItem {
  id: number;
  po_id: number;
  product_id: number;
  quantity: number;
  expected_cost_parent: number | null;
  notes: string | null;
  // Joined / computed
  product_name?: string;
  parent_unit?: string | null;
  child_unit?: string | null;
  conversion_factor?: number;
  /** Boxes received on invoices linked to this line. */
  received_quantity?: number;
  /** Quantity-weighted cost per box actually invoiced. */
  invoiced_cost_parent?: number | null;
  sellable_base?: number;
}

export interface PurchaseOrderFilters {
  supplier_id?: number;
  status?: PurchaseOrderStatus;
  search?: string;
  page?: number;
  limit?: number;
}

const HEADER = `
  SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, u.username,
         (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS lines,
         (SELECT COALESCE(SUM(i.quantity), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS ordered_units,
         (SELECT COALESCE(SUM(CASE WHEN r.received > i.quantity THEN i.quantity ELSE r.received END), 0)
            FROM purchase_order_items i
            JOIN (SELECT pi.po_item_id, SUM(pi.quantity_received) AS received FROM purchase_items pi
                  WHERE pi.po_item_id IS NOT NULL GROUP BY pi.po_item_id) r ON r.po_item_id = i.id
           WHERE i.po_id = po.id) AS received_units,
         (SELECT COALESCE(SUM(i.quantity * COALESCE(i.expected_cost_parent, 0)), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS expected_value,
         (SELECT COUNT(*) FROM purchases pu WHERE pu.purchase_order_id = po.id) AS invoices
  FROM purchase_orders po
  JOIN suppliers s ON s.id = po.supplier_id
  LEFT JOIN users u ON u.id = po.user_id`;

export class PurchaseOrderRepository {
  constructor(private readonly base: BaseRepository) {}

  async nextNumber(datePrefix: string): Promise<string> {
    const last = await this.base.getOne<{ po_number: string }>(
      `SELECT po_number FROM purchase_orders WHERE po_number LIKE ? ORDER BY id DESC LIMIT 1`, [`PO-${datePrefix}-%`]
    );
    const seq = last ? (parseInt(last.po_number.split('-').pop() ?? '0', 10) || 0) + 1 : 1;
    return `PO-${datePrefix}-${String(seq).padStart(3, '0')}`;
  }

  async insert(data: { po_number: string; supplier_id: number; order_date: string; expected_date: string | null; notes: string | null; user_id: number }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO purchase_orders (po_number, supplier_id, order_date, expected_date, notes, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [data.po_number, data.supplier_id, data.order_date, data.expected_date, data.notes, data.user_id]
    );
  }

  async updateHeader(id: number, data: { supplier_id: number; order_date: string; expected_date: string | null; notes: string | null }): Promise<void> {
    await this.base.run(
      `UPDATE purchase_orders SET supplier_id = ?, order_date = ?, expected_date = ?, notes = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [data.supplier_id, data.order_date, data.expected_date, data.notes, id]
    );
  }

  async replaceItems(poId: number, items: ReadonlyArray<{ product_id: number; quantity: number; expected_cost_parent: number | null; notes: string | null }>): Promise<void> {
    await this.base.run(`DELETE FROM purchase_order_items WHERE po_id = ?`, [poId]);
    for (const i of items) {
      await this.base.run(
        `INSERT INTO purchase_order_items (po_id, product_id, quantity, expected_cost_parent, notes) VALUES (?, ?, ?, ?, ?)`,
        [poId, i.product_id, i.quantity, i.expected_cost_parent, i.notes]
      );
    }
  }

  /** Compare-and-set status change. */
  async setStatus(id: number, from: readonly PurchaseOrderStatus[], to: PurchaseOrderStatus, extra: { sent?: boolean; closed?: boolean; reason?: string | null } = {}): Promise<number> {
    return await this.base.runAndGetChanges(
      `UPDATE purchase_orders SET status = ?, updated_at = datetime('now', 'localtime')
         ${extra.sent ? `, sent_at = datetime('now', 'localtime')` : ''}
         ${extra.closed ? `, closed_at = datetime('now', 'localtime'), close_reason = ?` : ''}
       WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
      [to, ...(extra.closed ? [extra.reason ?? null] : []), id, ...from]
    );
  }

  async getById(id: number): Promise<PurchaseOrder | undefined> {
    return await this.base.getOne<PurchaseOrder>(`${HEADER} WHERE po.id = ?`, [id]);
  }

  async getItems(poId: number): Promise<PurchaseOrderItem[]> {
    return await this.base.getAll<PurchaseOrderItem>(
      `SELECT i.*, p.name AS product_name, p.parent_unit, p.child_unit, COALESCE(NULLIF(p.conversion_factor, 0), 1) AS conversion_factor,
              COALESCE(r.received, 0) AS received_quantity, r.invoiced_cost_parent,
              COALESCE((SELECT SUM(b.quantity_base) FROM batches b WHERE b.product_id = p.id AND b.quantity_base > 0
                        AND b.status = 'active' AND b.expiry_date >= ${TODAY_SQL}), 0) AS sellable_base
       FROM purchase_order_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN (
         SELECT pi.po_item_id, SUM(pi.quantity_received) AS received,
                SUM(pi.cost_per_parent * pi.quantity_received) * 1.0 / NULLIF(SUM(pi.quantity_received), 0) AS invoiced_cost_parent
         FROM purchase_items pi WHERE pi.po_item_id IS NOT NULL GROUP BY pi.po_item_id
       ) r ON r.po_item_id = i.id
       WHERE i.po_id = ?
       ORDER BY p.name`,
      [poId]
    );
  }

  async getLinkedPurchases(poId: number): Promise<Array<{ id: number; purchase_number: string; invoice_reference: string | null; purchase_date: string; total_amount: number }>> {
    return await this.base.getAll(
      `SELECT id, purchase_number, invoice_reference, purchase_date, total_amount FROM purchases WHERE purchase_order_id = ? ORDER BY purchase_date, id`,
      [poId]
    );
  }

  async list(filters: PurchaseOrderFilters): Promise<PaginatedResult<PurchaseOrder>> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filters.supplier_id) { where.push('po.supplier_id = ?'); params.push(filters.supplier_id); }
    if (filters.status) { where.push('po.status = ?'); params.push(filters.status); }
    const search = filters.search?.trim();
    if (search) {
      const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      where.push(`(po.po_number LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.po_id = po.id AND p.name LIKE ? ESCAPE '\\'))`);
      params.push(like, like, like);
    }
    const limit = Math.min(Math.max(Math.floor(Number(filters.limit) || 20), 1), 100);
    const page = Math.max(Math.floor(Number(filters.page) || 1), 1);
    const total = (await this.base.getOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE ${where.join(' AND ')}`, params
    ))?.c ?? 0;
    const data = await this.base.getAll<PurchaseOrder>(
      `${HEADER} WHERE ${where.join(' AND ')} ORDER BY po.order_date DESC, po.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  /** Attach an invoice to an order: every line for an ordered product points at its order line. */
  async linkPurchase(purchaseId: number, poId: number): Promise<number> {
    await this.base.run(`UPDATE purchases SET purchase_order_id = ? WHERE id = ?`, [poId, purchaseId]);
    return await this.base.runAndGetChanges(
      `UPDATE purchase_items SET po_item_id = (SELECT i.id FROM purchase_order_items i WHERE i.po_id = ? AND i.product_id = purchase_items.product_id)
       WHERE purchase_id = ? AND po_item_id IS NULL
         AND EXISTS (SELECT 1 FROM purchase_order_items i WHERE i.po_id = ? AND i.product_id = purchase_items.product_id)`,
      [poId, purchaseId, poId]
    );
  }

  /** Last invoice cost per box for each product, from this supplier first, any supplier otherwise. */
  async getLastCosts(productIds: readonly number[], supplierId: number): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (productIds.length === 0) return out;
    const rows = await this.base.getAll<{ product_id: number; same: number | null; any_cost: number | null }>(
      `SELECT p.id AS product_id,
              (SELECT pi.cost_per_parent FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
               WHERE pi.product_id = p.id AND pu.supplier_id = ? ORDER BY pu.purchase_date DESC, pi.id DESC LIMIT 1) AS same,
              (SELECT pi.cost_per_parent FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
               WHERE pi.product_id = p.id ORDER BY pu.purchase_date DESC, pi.id DESC LIMIT 1) AS any_cost
       FROM products p WHERE p.id IN (${productIds.map(() => '?').join(',')})`,
      [supplierId, ...productIds]
    );
    for (const r of rows) {
      const cost = r.same ?? r.any_cost;
      if (cost !== null && cost > 0) out.set(r.product_id, Math.round(cost * 1000) / 1000);
    }
    return out;
  }
}
