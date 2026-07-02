import type { BaseRepository } from './base.repository';
import type { IPurchaseRepository } from '../../types/repositories';
import type {
  Purchase, PurchaseItem, PurchasePayment, PurchaseFilters,
  PaginatedResult, PurchasePaymentStatus, AgingPayment, UpcomingPayment,
  UpdatePurchaseInput, PurchasePendingItem, EnrichedPendingItem,
  SupplierProductFilters, SupplierProductRecord,
  ProductSupplierRecord,
} from '../../types/models';
import { PAGINATION } from '../../common/constants';

export class PurchaseRepository implements IPurchaseRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(filters: PurchaseFilters): Promise<PaginatedResult<Purchase>> {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (filters.start_date)     { conditions.push("p.purchase_date >= ?");   params.push(filters.start_date); }
    if (filters.end_date)       { conditions.push("p.purchase_date <= ?");   params.push(filters.end_date); }
    if (filters.supplier_id)    { conditions.push("p.supplier_id = ?");      params.push(filters.supplier_id); }
    if (filters.payment_status) { conditions.push("p.payment_status = ?");   params.push(filters.payment_status); }
    if (filters.payment_status_exclude) { conditions.push("p.payment_status != ?"); params.push(filters.payment_status_exclude); }
    if (filters.has_pending === true) { conditions.push("(SELECT COUNT(*) FROM purchase_pending_items ppi WHERE ppi.purchase_id = p.id) > 0"); }
    if (filters.search) {
      const q = `%${String(filters.search).slice(0, 100)}%`;
      conditions.push(`(p.purchase_number LIKE ? OR p.invoice_reference LIKE ? OR s.name LIKE ?)`);
      params.push(q, q, q);
    }

    const page  = Math.max(1, filters.page ?? 1);
    const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, filters.limit ?? PAGINATION.DEFAULT_LIMIT));
    const offset = (page - 1) * limit;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRow = await this.base.getOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM purchases p
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       ${where}`,
      [...params]
    );
    const total = countRow?.count ?? 0;

    const data = await this.base.getAll<Purchase>(
      `SELECT p.*,
              s.name as supplier_name,
              u.username,
              (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS items_count,
              (SELECT COUNT(*) FROM purchase_pending_items ppi WHERE ppi.purchase_id = p.id) AS pending_items_count
       FROM purchases p
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       JOIN users u ON p.user_id = u.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getById(id: number): Promise<Purchase | undefined> {
    const purchase = await this.base.getOne<Purchase>(
      `SELECT p.*,
              s.name as supplier_name,
              u.username,
              (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS items_count,
              (SELECT COUNT(*) FROM purchase_pending_items ppi WHERE ppi.purchase_id = p.id) AS pending_items_count
       FROM purchases p
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       JOIN users u ON p.user_id = u.id
       WHERE p.id = ?`,
      [id]
    );
    if (purchase) {
      purchase.items = await this.getItems(id);
      purchase.payments = await this.getPayments(id);
    }
    return purchase;
  }

  async getByIdempotencyKey(key: string): Promise<Purchase | undefined> {
    const purchase = await this.base.getOne<Purchase>(
      `SELECT p.*,
              s.name as supplier_name,
              u.username,
              (SELECT COUNT(*) FROM purchase_pending_items ppi WHERE ppi.purchase_id = p.id) AS pending_items_count
       FROM purchases p
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       JOIN users u ON p.user_id = u.id
       WHERE p.idempotency_key = ?`,
      [key]
    );
    if (purchase) {
      purchase.items = await this.getItems(purchase.id);
      purchase.payments = await this.getPayments(purchase.id);
    }
    return purchase;
  }

  async getItems(purchaseId: number): Promise<PurchaseItem[]> {
    return await this.base.getAll<PurchaseItem>(
      `SELECT pi.*, p.name as product_name, p.parent_unit, p.child_unit, p.conversion_factor
       FROM purchase_items pi
       JOIN products p ON pi.product_id = p.id
       WHERE pi.purchase_id = ?
       ORDER BY pi.id`,
      [purchaseId]
    );
  }

  async getPayments(purchaseId: number): Promise<PurchasePayment[]> {
    return await this.base.getAll<PurchasePayment>(
      `SELECT pp.*, u.username as paid_by_username
       FROM purchase_payments pp
       LEFT JOIN users u ON pp.paid_by_user_id = u.id
       WHERE pp.purchase_id = ?
       ORDER BY pp.due_date`,
      [purchaseId]
    );
  }

  async insert(data: {
    purchase_number: string;
    supplier_id: number | null;
    invoice_reference: string | null;
    purchase_date: string;
    total_amount: number;
    total_paid: number;
    payment_status: PurchasePaymentStatus;
    alert_days_before: number;
    notes: string | null;
    user_id: number;
    idempotency_key?: string | null;
  }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO purchases (
         purchase_number, supplier_id, invoice_reference, purchase_date,
         total_amount, total_paid, payment_status, alert_days_before, notes, user_id, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.purchase_number, data.supplier_id, data.invoice_reference,
        data.purchase_date, data.total_amount, data.total_paid,
        data.payment_status, data.alert_days_before, data.notes, data.user_id,
        data.idempotency_key ?? null,
      ]
    );
  }

  async insertItem(data: {
    purchase_id: number;
    product_id: number;
    batch_id: number | null;
    quantity_received: number;
    cost_per_parent: number;
    selling_price_parent: number;
    line_total: number;
    expiry_date: string | null;
    batch_number: string | null;
  }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO purchase_items (
         purchase_id, product_id, batch_id, quantity_received,
         cost_per_parent, selling_price_parent, line_total,
         expiry_date, batch_number
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.purchase_id, data.product_id, data.batch_id,
        data.quantity_received, data.cost_per_parent,
        data.selling_price_parent, data.line_total,
        data.expiry_date, data.batch_number,
      ]
    );
  }

  async insertPayment(data: {
    purchase_id: number;
    due_date: string;
    amount: number;
    is_paid: number;
    paid_date: string | null;
    payment_method: string | null;
    reference_number: string | null;
    expense_id: number | null;
    paid_by_user_id: number | null;
  }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO purchase_payments (
         purchase_id, due_date, amount, is_paid, paid_date,
         payment_method, reference_number, expense_id, paid_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.purchase_id, data.due_date, data.amount, data.is_paid,
        data.paid_date, data.payment_method, data.reference_number,
        data.expense_id, data.paid_by_user_id,
      ]
    );
  }

  async markPaymentPaid(
    paymentId: number,
    paidDate: string,
    paymentMethod: string,
    expenseId: number | null,
    userId: number,
    referenceNumber: string | null = null,
    paidAmount: number | null = null,
  ): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_payments
       SET is_paid = 1, paid_date = ?, payment_method = ?,
           reference_number = ?, expense_id = ?, paid_by_user_id = ?,
           paid_amount = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [paidDate, paymentMethod, referenceNumber, expenseId, userId, paidAmount, paymentId]
    );
  }

  async deleteUnpaidPayments(purchaseId: number): Promise<number> {
    const result = await this.base.runImmediate(
      `DELETE FROM purchase_payments WHERE purchase_id = ? AND is_paid = 0`,
      [purchaseId]
    );
    return result.changes ?? 0;
  }

  async updateTotals(
    purchaseId: number,
    totalPaid: number,
    status: PurchasePaymentStatus,
  ): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchases
       SET total_paid = ?, payment_status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [totalPaid, status, purchaseId]
    );
  }

  async getPaymentById(paymentId: number): Promise<PurchasePayment | undefined> {
    return await this.base.getOne<PurchasePayment>(
      `SELECT pp.*, pu.purchase_number, s.name as supplier_name,
              u.username as paid_by_username
       FROM purchase_payments pp
       JOIN purchases pu ON pp.purchase_id = pu.id
       LEFT JOIN suppliers s ON pu.supplier_id = s.id
       LEFT JOIN users u ON pp.paid_by_user_id = u.id
       WHERE pp.id = ?`,
      [paymentId]
    );
  }

  async getPaidTotal(purchaseId: number): Promise<number> {
    const row = await this.base.getOne<{ total: number }>(
      `SELECT COALESCE(SUM(CASE WHEN paid_amount IS NOT NULL THEN paid_amount ELSE amount END), 0) as total
       FROM purchase_payments
       WHERE purchase_id = ? AND is_paid = 1`,
      [purchaseId]
    );
    return row?.total ?? 0;
  }

  async getUnpaidPayments(purchaseId: number): Promise<PurchasePayment[]> {
    return await this.base.getAll<PurchasePayment>(
      `SELECT * FROM purchase_payments
       WHERE purchase_id = ? AND is_paid = 0
       ORDER BY due_date ASC, id ASC`,
      [purchaseId]
    );
  }

  async updatePaymentAmount(paymentId: number, newAmount: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_payments SET amount = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [newAmount, paymentId]
    );
  }

  async updatePaymentDueDate(paymentId: number, newDate: string): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_payments SET due_date = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [newDate, paymentId]
    );
  }

  async updatePayment(paymentId: number, data: {
    amount?: number;
    due_date?: string;
    payment_method?: string | null;
    reference_number?: string | null;
    paid_date?: string | null;
    paid_amount?: number | null;
    is_paid?: number;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (data.amount !== undefined)           { sets.push('amount = ?');           params.push(data.amount); }
    if (data.due_date !== undefined)         { sets.push('due_date = ?');         params.push(data.due_date); }
    if (data.payment_method !== undefined)   { sets.push('payment_method = ?');   params.push(data.payment_method); }
    if (data.reference_number !== undefined) { sets.push('reference_number = ?'); params.push(data.reference_number); }
    if (data.paid_date !== undefined)        { sets.push('paid_date = ?');        params.push(data.paid_date); }
    if (data.paid_amount !== undefined)      { sets.push('paid_amount = ?');      params.push(data.paid_amount); }
    if (data.is_paid !== undefined)          { sets.push('is_paid = ?');          params.push(data.is_paid); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now', 'localtime')");
    params.push(paymentId);
    await this.base.runImmediate(
      `UPDATE purchase_payments SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
  }

  async deletePayment(paymentId: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM purchase_payments WHERE id = ?`,
      [paymentId]
    );
  }

  async getItemById(itemId: number): Promise<PurchaseItem | undefined> {
    return await this.base.getOne<PurchaseItem>(
      `SELECT pi.*, p.name as product_name FROM purchase_items pi
       LEFT JOIN products p ON pi.product_id = p.id
       WHERE pi.id = ?`,
      [itemId]
    );
  }

  async updateItem(itemId: number, data: {
    quantity_received?: number;
    cost_per_parent?: number;
    selling_price_parent?: number;
    line_total?: number;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (data.quantity_received !== undefined)   { sets.push('quantity_received = ?');   params.push(data.quantity_received); }
    if (data.cost_per_parent !== undefined)     { sets.push('cost_per_parent = ?');     params.push(data.cost_per_parent); }
    if (data.selling_price_parent !== undefined){ sets.push('selling_price_parent = ?'); params.push(data.selling_price_parent); }
    if (data.line_total !== undefined)          { sets.push('line_total = ?');          params.push(data.line_total); }
    if (sets.length === 0) return;
    params.push(itemId);
    await this.base.runImmediate(
      `UPDATE purchase_items SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
  }

  async deleteItem(itemId: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM purchase_items WHERE id = ?`,
      [itemId]
    );
  }

  async updateTotalAmount(purchaseId: number, newTotal: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchases SET total_amount = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [newTotal, purchaseId]
    );
  }

  async update(id: number, data: UpdatePurchaseInput): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (data.supplier_id !== undefined) { sets.push('supplier_id = ?');       params.push(data.supplier_id); }
    if (data.invoice_reference !== undefined) { sets.push('invoice_reference = ?'); params.push(data.invoice_reference); }
    if (data.purchase_date !== undefined) { sets.push('purchase_date = ?');     params.push(data.purchase_date); }
    if (data.notes !== undefined) { sets.push('notes = ?');               params.push(data.notes); }
    if (data.alert_days_before !== undefined) { sets.push('alert_days_before = ?'); params.push(data.alert_days_before); }
    if (data.total_amount !== undefined) { sets.push('total_amount = ?'); params.push(data.total_amount); }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now', 'localtime')");
    params.push(id);

    await this.base.runImmediate(
      `UPDATE purchases SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
  }

  async delete(id: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM purchases WHERE id = ?`,
      [id]
    );
  }

  async hasPaidPayments(id: number): Promise<boolean> {
    const row = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM purchase_payments WHERE purchase_id = ? AND is_paid = 1`,
      [id]
    );
    return (row?.cnt ?? 0) > 0;
  }

  async getNextNumber(datePrefix: string): Promise<string> {
    const like = `PUR-${datePrefix}-%`;
    const last = await this.base.getOne<{ purchase_number: string }>(
      `SELECT purchase_number FROM purchases
       WHERE purchase_number LIKE ? ORDER BY id DESC LIMIT 1`,
      [like]
    );
    if (last) {
      const parts = last.purchase_number.split('-');
      const seq = parseInt(parts[parts.length - 1] ?? '0', 10) + 1;
      return `PUR-${datePrefix}-${String(seq).padStart(3, '0')}`;
    }
    return `PUR-${datePrefix}-001`;
  }

  async getItemBatchIds(purchaseId: number): Promise<number[]> {
    const rows = await this.base.getAll<{ batch_id: number }>(
      `SELECT batch_id FROM purchase_items WHERE purchase_id = ? AND batch_id IS NOT NULL`,
      [purchaseId]
    );
    return rows.map(r => r.batch_id);
  }

  async deleteBatchIfOrphan(batchId: number): Promise<void> {
    // Check ALL FK references before deleting:
    // - transaction_items (sales/returns)
    // - inventory_adjustments (damage/expiry reports)
    // purchase_items are already CASCADE-deleted when this runs inside deletePurchase.
    const refs = await this.base.getOne<{ cnt: number }>(
      `SELECT (
         (SELECT COUNT(*) FROM transaction_items WHERE batch_id = ?) +
         (SELECT COUNT(*) FROM inventory_adjustments WHERE batch_id = ?)
       ) as cnt`,
      [batchId, batchId]
    );
    if ((refs?.cnt ?? 0) === 0) {
      await this.base.runImmediate(
        `DELETE FROM batches WHERE id = ?`,
        [batchId]
      );
    } else {
      // Can't delete — soft-delete instead (zero stock, mark sold_out)
      await this.base.runImmediate(
        `UPDATE batches SET quantity_base = 0, status = 'sold_out', updated_at = datetime('now', 'localtime') WHERE id = ?`,
        [batchId]
      );
    }
  }

  async getAgingPayments(): Promise<AgingPayment[]> {
    return await this.base.getAll<AgingPayment>(
      `SELECT
         pp.id as payment_id,
         pp.purchase_id,
         pu.purchase_number,
         s.name as supplier_name,
         pu.invoice_reference,
         pp.due_date,
         pp.amount,
         CAST(JULIANDAY('now', 'localtime') - JULIANDAY(pp.due_date) AS INTEGER) as days_overdue,
         pu.purchase_date
       FROM purchase_payments pp
       JOIN purchases pu ON pp.purchase_id = pu.id
       LEFT JOIN suppliers s ON pu.supplier_id = s.id
       WHERE pp.is_paid = 0
         AND pp.due_date < DATE('now')
       ORDER BY pp.due_date ASC`
    );
  }

  async getOverdueSummary(): Promise<{ count: number; total: number }> {
    const row = await this.base.getOne<{ count: number; total: number }>(
      `SELECT COUNT(*) as count, COALESCE(SUM(pp.amount), 0) as total
       FROM purchase_payments pp
       WHERE pp.is_paid = 0
         AND pp.due_date < DATE('now')`
    );
    return row ?? { count: 0, total: 0 };
  }

  async getUpcomingPayments(): Promise<UpcomingPayment[]> {
    return await this.base.getAll<UpcomingPayment>(
      `SELECT
         pp.id as payment_id,
         pp.purchase_id,
         pu.purchase_number,
         s.name as supplier_name,
         pu.invoice_reference,
         pp.due_date,
         pp.amount,
         CAST(JULIANDAY(pp.due_date) - JULIANDAY('now', 'localtime') AS INTEGER) as days_until_due
       FROM purchase_payments pp
       JOIN purchases pu ON pp.purchase_id = pu.id
       LEFT JOIN suppliers s ON pu.supplier_id = s.id
       WHERE pp.is_paid = 0
         AND pp.due_date >= DATE('now')
         AND JULIANDAY(pp.due_date) - JULIANDAY('now', 'localtime') <= pu.alert_days_before
       ORDER BY pp.due_date ASC`
    );
  }

  async getUpcomingSummary(): Promise<{ count: number; total: number }> {
    const row = await this.base.getOne<{ count: number; total: number }>(
      `SELECT COUNT(*) as count, COALESCE(SUM(pp.amount), 0) as total
       FROM purchase_payments pp
       JOIN purchases pu ON pp.purchase_id = pu.id
       WHERE pp.is_paid = 0
         AND pp.due_date >= DATE('now')
         AND JULIANDAY(pp.due_date) - JULIANDAY('now', 'localtime') <= pu.alert_days_before`
    );
    return row ?? { count: 0, total: 0 };
  }

  // ─── Pending Items ───────────────────────────────────────────────────────────

  async insertPendingItem(data: { purchase_id: number; raw_data: string; notes?: string }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO purchase_pending_items (purchase_id, raw_data, notes) VALUES (?, ?, ?)`,
      [data.purchase_id, data.raw_data, data.notes ?? null]
    );
  }

  async getPendingItems(purchaseId: number): Promise<PurchasePendingItem[]> {
    return await this.base.getAll<PurchasePendingItem>(
      `SELECT * FROM purchase_pending_items WHERE purchase_id = ? ORDER BY id ASC`,
      [purchaseId]
    );
  }

  async getPendingItemById(id: number): Promise<PurchasePendingItem | undefined> {
    return await this.base.getOne<PurchasePendingItem>(
      `SELECT * FROM purchase_pending_items WHERE id = ?`,
      [id]
    );
  }

  async deletePendingItem(id: number): Promise<void> {
    await this.base.runImmediate(
      `DELETE FROM purchase_pending_items WHERE id = ?`,
      [id]
    );
  }

  async hasPendingItems(purchaseId: number): Promise<boolean> {
    const row = await this.base.getOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM purchase_pending_items WHERE purchase_id = ?`,
      [purchaseId]
    );
    return (row?.cnt ?? 0) > 0;
  }

  async updatePendingItem(id: number, rawData: string, notes?: string | null): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_pending_items SET raw_data = ?, notes = ? WHERE id = ?`,
      [rawData, notes ?? null, id]
    );
  }

  // ─── Merge support ──────────────────────────────────────────────────────────

  async reparentItems(fromPurchaseId: number, toPurchaseId: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_items SET purchase_id = ? WHERE purchase_id = ?`,
      [toPurchaseId, fromPurchaseId]
    );
  }

  async reparentPayments(fromPurchaseId: number, toPurchaseId: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_payments SET purchase_id = ? WHERE purchase_id = ?`,
      [toPurchaseId, fromPurchaseId]
    );
  }

  async reparentPendingItems(fromPurchaseId: number, toPurchaseId: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_pending_items SET purchase_id = ? WHERE purchase_id = ?`,
      [toPurchaseId, fromPurchaseId]
    );
  }

  async getAllPendingItems(filters: { search?: string; supplier_id?: number; page?: number; limit?: number }): Promise<PaginatedResult<EnrichedPendingItem>> {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filters.supplier_id) { conditions.push('p.supplier_id = ?'); params.push(filters.supplier_id); }
    if (filters.search) {
      const q = `%${String(filters.search).slice(0, 100)}%`;
      conditions.push('(ppi.raw_data LIKE ? OR p.purchase_number LIKE ? OR p.invoice_reference LIKE ? OR s.name LIKE ?)');
      params.push(q, q, q, q);
    }
    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(100, Math.max(5, filters.limit ?? 20));
    const offset = (page - 1) * limit;
    const where = `WHERE ${conditions.join(' AND ')}`;
    const countRow = await this.base.getOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM purchase_pending_items ppi JOIN purchases p ON ppi.purchase_id = p.id LEFT JOIN suppliers s ON p.supplier_id = s.id ${where}`,
      [...params]
    );
    const total = countRow?.count ?? 0;
    const data = await this.base.getAll<EnrichedPendingItem>(
      `SELECT ppi.*, p.purchase_number, p.invoice_reference, s.name as supplier_name, p.supplier_id
       FROM purchase_pending_items ppi
       JOIN purchases p ON ppi.purchase_id = p.id
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       ${where}
       ORDER BY ppi.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Products by Supplier (smart inventory view) ───────────────────────────

  async getProductsBySupplier(
    supplierId: number,
    filters: SupplierProductFilters,
  ): Promise<PaginatedResult<SupplierProductRecord>> {
    const startDate = filters.start_date ?? '0001-01-01';
    const endDate   = filters.end_date   ?? '9999-12-31';

    const conditions: string[] = ['1=1'];
    const havingConditions: string[] = [];
    const params: unknown[] = [];

    if (!filters.include_inactive) {
      conditions.push('p.is_active = 1');
    }

    if (filters.search) {
      const escaped = String(filters.search).replace(/[%_\\]/g, '\\$&').slice(0, 100);
      const like = `%${escaped}%`;
      conditions.push("(p.name LIKE ? OR p.generic_name LIKE ? OR p.barcode LIKE ?)");
      params.push(like, like, like);
    }

    if (filters.min_cost != null && Number.isFinite(filters.min_cost)) {
      conditions.push('COALESCE(lc.cost_per_parent, 0) >= ?');
      params.push(Math.round(filters.min_cost));
    }
    if (filters.max_cost != null && Number.isFinite(filters.max_cost)) {
      conditions.push('COALESCE(lc.cost_per_parent, 0) <= ?');
      params.push(Math.round(filters.max_cost));
    }

    // Stock-status filter — applied as HAVING/WHERE on derived columns
    switch (filters.stock_status) {
      case 'in_stock':
        conditions.push('COALESCE(cs.stock, 0) > 0');
        break;
      case 'out_of_stock':
        conditions.push('COALESCE(cs.stock, 0) = 0');
        break;
      case 'low_stock':
        conditions.push('COALESCE(cs.stock, 0) > 0 AND COALESCE(cs.stock, 0) < p.min_stock_level');
        break;
      case 'expired':
        // Product has stock in expired-only batches: lifetime-stock > active-stock
        conditions.push(`EXISTS (
          SELECT 1 FROM batches bx
          WHERE bx.product_id = p.id AND bx.quantity_base > 0 AND bx.expiry_date < date('now')
        )`);
        break;
      default:
        break;
    }

    // Smart presets — compound conditions
    switch (filters.preset) {
      case 'out_of_stock':
        conditions.push('COALESCE(cs.stock, 0) = 0');
        break;
      case 'low_stock':
        conditions.push('COALESCE(cs.stock, 0) > 0 AND COALESCE(cs.stock, 0) < p.min_stock_level');
        break;
      case 'never_reordered':
        conditions.push('COALESCE(sl.cnt, 0) = 1');
        break;
      case 'sole_source':
        conditions.push('COALESCE(scp.cnt, 0) = 1');
        break;
      case 'price_increased':
        conditions.push('lc.cost_per_parent IS NOT NULL AND pc.cost_per_parent IS NOT NULL AND lc.cost_per_parent > pc.cost_per_parent');
        break;
      case 'price_decreased':
        conditions.push('lc.cost_per_parent IS NOT NULL AND pc.cost_per_parent IS NOT NULL AND pc.cost_per_parent > 0 AND lc.cost_per_parent < pc.cost_per_parent');
        break;
      case 'slow_movers':
        conditions.push("COALESCE(cs.stock, 0) > 0 AND (ls.last_sale_date IS NULL OR ls.last_sale_date < datetime('now', '-90 days'))");
        break;
      case 'best_margin':
        // Margin > 30% — surfaces products where this supplier's last cost gives a healthy markup
        conditions.push("COALESCE(lc.cost_per_parent, 0) > 0 AND COALESCE(fs.price, 0) > 0 AND ((COALESCE(fs.price, 0) - COALESCE(lc.cost_per_parent, 0)) * 100.0 / COALESCE(lc.cost_per_parent, 1)) >= 30");
        break;
      case 'approaching_expiry':
        conditions.push("bme.expiry IS NOT NULL AND bme.expiry <= date('now', '+90 days')");
        break;
      default:
        break;
    }

    // Sort
    let orderBy: string;
    switch (filters.sort_by) {
      case 'name_asc':           orderBy = 'p.name ASC'; break;
      case 'total_qty_desc':     orderBy = 'wa.total_qty_bought DESC'; break;
      case 'total_spent_desc':   orderBy = 'wa.total_spent DESC'; break;
      case 'avg_cost_desc':      orderBy = '(wa.total_spent * 1.0 / NULLIF(wa.total_qty_bought, 0)) DESC'; break;
      case 'last_cost_desc':     orderBy = 'COALESCE(lc.cost_per_parent, 0) DESC'; break;
      case 'last_purchased_desc':
      default:                   orderBy = 'wa.last_purchase_date DESC'; break;
    }

    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, filters.limit ?? PAGINATION.DEFAULT_LIMIT));
    const offset = (page - 1) * limit;

    const where = `WHERE ${conditions.join(' AND ')}` + (havingConditions.length ? ' AND ' + havingConditions.join(' AND ') : '');

    // CTE block — prepared once, parameter list determines runtime values.
    // Three placeholders for the supplier_id (used in 3 different CTEs).
    const cteBlock = `
      WITH supplier_window AS (
        SELECT pi.product_id, pi.cost_per_parent, pi.quantity_received, pi.line_total, pu.purchase_date
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pu.supplier_id = ?
          AND pu.purchase_date >= ?
          AND pu.purchase_date <= ?
      ),
      supplier_lifetime AS (
        SELECT pi.product_id, COUNT(*) as cnt
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pu.supplier_id = ?
        GROUP BY pi.product_id
      ),
      window_aggs AS (
        SELECT product_id,
               MIN(purchase_date) as first_purchase_date,
               MAX(purchase_date) as last_purchase_date,
               SUM(quantity_received) as total_qty_bought,
               SUM(line_total) as total_spent,
               COUNT(*) as purchase_count
        FROM supplier_window
        GROUP BY product_id
      ),
      costs_ranked AS (
        SELECT product_id, cost_per_parent, purchase_date,
               ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY purchase_date DESC, ROWID DESC) as rn
        FROM supplier_window
      ),
      last_cost AS (SELECT product_id, cost_per_parent FROM costs_ranked WHERE rn = 1),
      prev_cost AS (SELECT product_id, cost_per_parent FROM costs_ranked WHERE rn = 2),
      supplier_count_per_product AS (
        SELECT pi.product_id, COUNT(DISTINCT pu.supplier_id) as cnt
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pu.supplier_id IS NOT NULL
        GROUP BY pi.product_id
      ),
      last_sale AS (
        SELECT ti.product_id, MAX(t.created_at) as last_sale_date
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.is_voided = 0 AND t.transaction_type = 'sale'
        GROUP BY ti.product_id
      ),
      current_stock AS (
        SELECT product_id, SUM(quantity_base) as stock
        FROM batches
        WHERE status = 'active' AND quantity_base > 0 AND expiry_date >= date('now')
        GROUP BY product_id
      ),
      batch_min_expiry AS (
        SELECT pi.product_id, MIN(b.expiry_date) as expiry
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        JOIN batches b ON b.id = pi.batch_id
        WHERE pu.supplier_id = ? AND b.status = 'active' AND b.quantity_base > 0
        GROUP BY pi.product_id
      ),
      fifo_sell AS (
        SELECT b.product_id,
               MAX(CASE WHEN b.selling_price_parent_override > 0
                        THEN b.selling_price_parent_override
                        ELSE b.selling_price_parent END) as price
        FROM batches b
        WHERE b.status = 'active' AND b.quantity_base > 0 AND b.expiry_date >= date('now')
        GROUP BY b.product_id
      )
    `;

    // Three supplier_id substitutions for: supplier_window, supplier_lifetime, batch_min_expiry
    const cteParams: unknown[] = [supplierId, startDate, endDate, supplierId, supplierId];

    // --- Count query ---
    const countSql = `${cteBlock}
      SELECT COUNT(*) as count
      FROM products p
      JOIN window_aggs wa ON wa.product_id = p.id
      LEFT JOIN supplier_lifetime sl ON sl.product_id = p.id
      LEFT JOIN last_cost lc ON lc.product_id = p.id
      LEFT JOIN prev_cost pc ON pc.product_id = p.id
      LEFT JOIN supplier_count_per_product scp ON scp.product_id = p.id
      LEFT JOIN last_sale ls ON ls.product_id = p.id
      LEFT JOIN current_stock cs ON cs.product_id = p.id
      LEFT JOIN batch_min_expiry bme ON bme.product_id = p.id
      LEFT JOIN fifo_sell fs ON fs.product_id = p.id
      ${where}`;

    const countRow = await this.base.getOne<{ count: number }>(countSql, [...cteParams, ...params]);
    const total = countRow?.count ?? 0;

    // --- Data query ---
    const dataSql = `${cteBlock}
      SELECT
        p.id as product_id, p.name as product_name, p.generic_name, p.barcode,
        p.parent_unit, p.child_unit, p.conversion_factor, p.min_stock_level, p.is_active,
        wa.first_purchase_date, wa.last_purchase_date,
        wa.total_qty_bought, wa.total_spent, wa.purchase_count,
        COALESCE(lc.cost_per_parent, 0) as last_cost,
        pc.cost_per_parent as previous_cost,
        COALESCE(sl.cnt, 0) as purchase_count_total,
        COALESCE(scp.cnt, 0) as supplier_count,
        COALESCE(cs.stock, 0) as current_stock,
        ls.last_sale_date,
        bme.expiry as batch_min_expiry,
        COALESCE(fs.price, 0) as current_sell_price
      FROM products p
      JOIN window_aggs wa ON wa.product_id = p.id
      LEFT JOIN supplier_lifetime sl ON sl.product_id = p.id
      LEFT JOIN last_cost lc ON lc.product_id = p.id
      LEFT JOIN prev_cost pc ON pc.product_id = p.id
      LEFT JOIN supplier_count_per_product scp ON scp.product_id = p.id
      LEFT JOIN last_sale ls ON ls.product_id = p.id
      LEFT JOIN current_stock cs ON cs.product_id = p.id
      LEFT JOIN batch_min_expiry bme ON bme.product_id = p.id
      LEFT JOIN fifo_sell fs ON fs.product_id = p.id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`;

    const data = await this.base.getAll<SupplierProductRecord>(
      dataSql,
      [...cteParams, ...params, limit, offset],
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  // ─── Suppliers by Product (reverse lookup — product-first view) ─────────────

  async getSuppliersByProduct(
    productId: number,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResult<ProductSupplierRecord>> {
    page  = Math.max(1, page);
    limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, limit));
    const offset = (page - 1) * limit;

    const cteBlock = `
      WITH product_purchases AS (
        SELECT pi.purchase_id, pi.cost_per_parent, pi.quantity_received, pi.line_total,
               pu.purchase_date, pu.supplier_id
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pi.product_id = ?
          AND pu.supplier_id IS NOT NULL
      ),
      supplier_aggs AS (
        SELECT supplier_id,
               MIN(purchase_date) as first_purchase_date,
               MAX(purchase_date) as last_purchase_date,
               SUM(quantity_received) as total_qty_bought,
               SUM(line_total) as total_spent,
               COUNT(*) as purchase_count,
               ROUND(SUM(line_total) * 1.0 / NULLIF(SUM(quantity_received), 0)) as avg_cost
        FROM product_purchases
        GROUP BY supplier_id
      ),
      costs_ranked AS (
        SELECT supplier_id, cost_per_parent, purchase_date,
               ROW_NUMBER() OVER (PARTITION BY supplier_id ORDER BY purchase_date DESC, purchase_id DESC) as rn
        FROM product_purchases
      ),
      last_cost AS (SELECT supplier_id, cost_per_parent FROM costs_ranked WHERE rn = 1),
      prev_cost AS (SELECT supplier_id, cost_per_parent FROM costs_ranked WHERE rn = 2)
    `;

    const cteParams = [productId];

    const countSql = `${cteBlock}
      SELECT COUNT(*) as count
      FROM supplier_aggs sa
      JOIN suppliers s ON s.id = sa.supplier_id`;

    const countRow = await this.base.getOne<{ count: number }>(countSql, [...cteParams]);
    const total = countRow?.count ?? 0;

    const dataSql = `${cteBlock}
      SELECT
        s.id as supplier_id,
        s.name as supplier_name,
        s.phone as supplier_phone,
        sa.first_purchase_date,
        sa.last_purchase_date,
        sa.total_qty_bought,
        sa.total_spent,
        sa.purchase_count,
        COALESCE(lc.cost_per_parent, 0) as last_cost,
        pc.cost_per_parent as previous_cost,
        COALESCE(sa.avg_cost, 0) as avg_cost
      FROM supplier_aggs sa
      JOIN suppliers s ON s.id = sa.supplier_id
      LEFT JOIN last_cost lc ON lc.supplier_id = sa.supplier_id
      LEFT JOIN prev_cost pc ON pc.supplier_id = sa.supplier_id
      ORDER BY sa.last_purchase_date DESC
      LIMIT ? OFFSET ?`;

    const data = await this.base.getAll<ProductSupplierRecord>(
      dataSql,
      [...cteParams, limit, offset],
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }
}
