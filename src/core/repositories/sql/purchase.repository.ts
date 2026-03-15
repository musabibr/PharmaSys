import type { BaseRepository } from './base.repository';
import type { IPurchaseRepository } from '../../types/repositories';
import type {
  Purchase, PurchaseItem, PurchasePayment, PurchaseFilters,
  PaginatedResult, PurchasePaymentStatus, AgingPayment, UpcomingPayment,
  UpdatePurchaseInput,
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
      `SELECT p.*, s.name as supplier_name, u.username
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
      `SELECT p.*, s.name as supplier_name, u.username
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
  }): Promise<number> {
    return await this.base.runReturningId(
      `INSERT INTO purchases (
         purchase_number, supplier_id, invoice_reference, purchase_date,
         total_amount, total_paid, payment_status, alert_days_before, notes, user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.purchase_number, data.supplier_id, data.invoice_reference,
        data.purchase_date, data.total_amount, data.total_paid,
        data.payment_status, data.alert_days_before, data.notes, data.user_id,
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
    expenseId: number,
    userId: number,
    referenceNumber: string | null = null,
    paidAmount: number | null = null,
  ): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_payments
       SET is_paid = 1, paid_date = ?, payment_method = ?,
           reference_number = ?, expense_id = ?, paid_by_user_id = ?,
           paid_amount = ?,
           updated_at = datetime('now')
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
       SET total_paid = ?, payment_status = ?, updated_at = datetime('now')
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
      `SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) as total
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
      `UPDATE purchase_payments SET amount = ?, updated_at = datetime('now') WHERE id = ?`,
      [newAmount, paymentId]
    );
  }

  async updatePaymentDueDate(paymentId: number, newDate: string): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchase_payments SET due_date = ?, updated_at = datetime('now') WHERE id = ?`,
      [newDate, paymentId]
    );
  }

  async updateTotalAmount(purchaseId: number, newTotal: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE purchases SET total_amount = ?, updated_at = datetime('now') WHERE id = ?`,
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

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
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
    // Only check transaction_items — purchase_items are already CASCADE-deleted
    // when this runs inside deletePurchase's transaction.
    await this.base.runImmediate(
      `DELETE FROM batches WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM transaction_items WHERE batch_id = ?)`,
      [batchId, batchId]
    );
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
         CAST(JULIANDAY('now') - JULIANDAY(pp.due_date) AS INTEGER) as days_overdue,
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
         CAST(JULIANDAY(pp.due_date) - JULIANDAY('now') AS INTEGER) as days_until_due
       FROM purchase_payments pp
       JOIN purchases pu ON pp.purchase_id = pu.id
       LEFT JOIN suppliers s ON pu.supplier_id = s.id
       WHERE pp.is_paid = 0
         AND pp.due_date >= DATE('now')
         AND JULIANDAY(pp.due_date) - JULIANDAY('now') <= pu.alert_days_before
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
         AND JULIANDAY(pp.due_date) - JULIANDAY('now') <= pu.alert_days_before`
    );
    return row ?? { count: 0, total: 0 };
  }
}
