import type { PurchaseRepository } from '../repositories/sql/purchase.repository';
import type { SupplierRepository } from '../repositories/sql/supplier.repository';
import type { ProductRepository } from '../repositories/sql/product.repository';
import type { CategoryRepository } from '../repositories/sql/category.repository';
import type { BaseRepository } from '../repositories/sql/base.repository';
import type { EventBus } from '../events/event-bus';
import type {
  Supplier, CreateSupplierInput, UpdateSupplierInput,
  Purchase, PurchaseItem, PurchasePayment, PurchaseFilters,
  PaginatedResult, AgingPayment, UpcomingPayment,
  CreatePurchaseInput, CreatePurchaseItemInput,
  UpdatePurchaseInput, ExpensePaymentMethod,
  PaymentAdjustmentStrategy, PurchasePendingItem, EnrichedPendingItem,
  SupplierProductFilters, SupplierProductRecord,
  ProductSupplierRecord,
} from '../types/models';
import { Validate } from '../common/validation';
import { Money } from '../common/money';
import { normalizeExpiry, NO_EXPIRY_SENTINEL, todayLocalISO } from '../common/expiry';
import { NotFoundError, ValidationError, BusinessRuleError, InternalError } from '../types/errors';
import { diffValues } from '../common/audit-diff';

export class PurchaseService {
  constructor(
    private readonly purchaseRepo: PurchaseRepository,
    private readonly supplierRepo: SupplierRepository,
    private readonly base:         BaseRepository,
    private readonly bus:          EventBus,
    private readonly productRepo:  ProductRepository,
    private readonly categoryRepo: CategoryRepository,
  ) {}

  // ─── Supplier CRUD ───────────────────────────────────────────────────────────

  async getSuppliers(includeInactive = false): Promise<Supplier[]> {
    return await this.supplierRepo.getAll(includeInactive);
  }

  async getSupplierById(id: number): Promise<Supplier> {
    const s = await this.supplierRepo.getById(id);
    if (!s) throw new NotFoundError('Supplier', id);
    return s;
  }

  async createSupplier(data: CreateSupplierInput, userId: number): Promise<Supplier> {
    const name = Validate.requiredString(data.name, 'Supplier name', 200);
    const result = await this.supplierRepo.create({ ...data, name });
    const newId = result.lastInsertRowid as number;

    this.bus.emit('entity:mutated', {
      action: 'CREATE_SUPPLIER', table: 'suppliers',
      recordId: newId, userId,
      newValues: { name },
    });

    return await this.getSupplierById(newId);
  }

  async updateSupplier(id: number, data: UpdateSupplierInput, userId: number): Promise<Supplier> {
    Validate.id(id);
    const existing = await this.supplierRepo.getById(id);
    if (!existing) throw new NotFoundError('Supplier', id);

    if (data.name !== undefined) {
      Validate.requiredString(data.name, 'Supplier name', 200);
    }

    await this.supplierRepo.update(id, data);

    // Diff against the full before-state — oldValues used to be hardcoded to
    // just {name} while newValues carried the whole patch, so a phone/address/
    // notes/is_active edit showed a "new" value with no "old" to compare it to.
    // is_active is boolean on the patch but stored as 0/1 — normalize so an
    // unrelated field edit doesn't fabricate a spurious is_active diff.
    const { oldValues, newValues } = diffValues(
      { ...existing, is_active: !!existing.is_active } as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    );

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_SUPPLIER', table: 'suppliers',
      recordId: id, userId,
      oldValues: { name: existing.name, ...oldValues },
      newValues: { name: existing.name, ...newValues },
    });

    return await this.getSupplierById(id);
  }

  async deleteSupplier(id: number, userId: number): Promise<void> {
    Validate.id(id);
    const existing = await this.supplierRepo.getById(id);
    if (!existing) throw new NotFoundError('Supplier', id);

    if (await this.supplierRepo.hasPurchases(id)) {
      throw new BusinessRuleError(
        'Cannot delete supplier with purchase history. Deactivate it instead.'
      );
    }

    await this.supplierRepo.delete(id);

    this.bus.emit('entity:mutated', {
      action: 'DELETE_SUPPLIER', table: 'suppliers',
      recordId: id, userId,
      oldValues: { name: existing.name },
    });
  }

  // ─── Purchase Queries ────────────────────────────────────────────────────────

  async getAll(filters: PurchaseFilters): Promise<PaginatedResult<Purchase>> {
    return await this.purchaseRepo.getAll(filters);
  }

  async getById(id: number): Promise<Purchase> {
    const p = await this.purchaseRepo.getById(id);
    if (!p) throw new NotFoundError('Purchase', id);
    return p;
  }

  async getItems(purchaseId: number): Promise<PurchaseItem[]> {
    return await this.purchaseRepo.getItems(purchaseId);
  }

  async getPayments(purchaseId: number): Promise<PurchasePayment[]> {
    return await this.purchaseRepo.getPayments(purchaseId);
  }

  async getAgingPayments(): Promise<AgingPayment[]> {
    return await this.purchaseRepo.getAgingPayments();
  }

  async getOverdueSummary(): Promise<{ count: number; total: number }> {
    return await this.purchaseRepo.getOverdueSummary();
  }

  async getUpcomingPayments(): Promise<UpcomingPayment[]> {
    return await this.purchaseRepo.getUpcomingPayments();
  }

  async getUpcomingSummary(): Promise<{ count: number; total: number }> {
    return await this.purchaseRepo.getUpcomingSummary();
  }

  /**
   * List products purchased from a specific supplier with smart filters
   * (stock status, recency window, smart presets like "never re-ordered" /
   * "price increased" / "sole source"). Aggregates such as Total Qty / Total
   * Spent honor the recency window; lifetime fields ignore it.
   */
  async getProductsBySupplier(
    supplierId: number,
    filters: SupplierProductFilters,
  ): Promise<PaginatedResult<SupplierProductRecord>> {
    Validate.id(supplierId, 'Supplier');
    const supplier = await this.supplierRepo.getById(supplierId);
    if (!supplier) throw new NotFoundError('Supplier', supplierId);

    if (filters.start_date) Validate.dateString(filters.start_date, 'Start date');
    if (filters.end_date)   Validate.dateString(filters.end_date,   'End date');

    return await this.purchaseRepo.getProductsBySupplier(supplierId, filters);
  }

  /**
   * Reverse lookup: given a product, list all suppliers that have supplied it
   * with aggregated purchase data (totals, cost trends, averages).
   */
  async getSuppliersByProduct(
    productId: number,
    page?: number,
    limit?: number,
  ): Promise<PaginatedResult<ProductSupplierRecord>> {
    Validate.id(productId, 'Product');
    const product = await this.productRepo.getById(productId);
    if (!product) throw new NotFoundError('Product', productId);

    return await this.purchaseRepo.getSuppliersByProduct(productId, page, limit);
  }

  // ─── Update Purchase ─────────────────────────────────────────────────────────

  async updatePurchase(id: number, data: UpdatePurchaseInput, userId: number): Promise<Purchase> {
    Validate.id(id);
    const existing = await this.purchaseRepo.getById(id);
    if (!existing) throw new NotFoundError('Purchase', id);

    if (data.supplier_id !== undefined && data.supplier_id !== null) {
      const supplier = await this.supplierRepo.getById(data.supplier_id);
      if (!supplier) throw new NotFoundError('Supplier', data.supplier_id);
    }

    if (data.purchase_date !== undefined) {
      Validate.dateString(data.purchase_date, 'Purchase date');
    }

    if (data.alert_days_before !== undefined) {
      data.alert_days_before = Math.max(0, Math.round(data.alert_days_before));
    }

    if (data.total_amount !== undefined) {
      data.total_amount = Money.round(Validate.nonNegativeNumber(data.total_amount, 'Total amount'));
    }

    await this.purchaseRepo.update(id, data);

    // If total_amount was changed, recalculate payment status
    if (data.total_amount !== undefined) {
      const paidTotal = await this.purchaseRepo.getPaidTotal(id);
      const newStatus = paidTotal >= data.total_amount ? 'paid' as const
        : paidTotal > 0 ? 'partial' as const : 'unpaid' as const;
      await this.purchaseRepo.updateTotals(id, paidTotal, newStatus);
    }

    // Diff against the full before-state — the hardcoded 4-field oldValues
    // above missed total_amount/alert_days_before edits entirely (newValues
    // would show the new total with no old value to compare it to).
    const { oldValues, newValues } = diffValues(
      existing as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    );

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PURCHASE', table: 'purchases',
      recordId: id, userId,
      oldValues, newValues,
    });

    return await this.getById(id);
  }

  // ─── Update Payment Schedule ────────────────────────────────────────────────

  async updatePaymentSchedule(
    purchaseId: number,
    payments: Array<{ id: number; amount: number; due_date: string }>,
    userId: number,
  ): Promise<Purchase> {
    Validate.id(purchaseId);

    if (!payments || payments.length === 0) {
      throw new ValidationError('At least one payment must be provided');
    }

    // Validate each payment entry (can do outside transaction — pure input validation)
    for (const p of payments) {
      Validate.id(p.id);
      if (!Number.isFinite(p.amount) || p.amount <= 0) {
        throw new ValidationError('Payment amount must be a positive number');
      }
      Validate.dateString(p.due_date, 'Due date');
    }

    // Fetch + validate + apply all inside one transaction to prevent race conditions
    await this.base.inTransaction(async () => {
      const purchase = await this.purchaseRepo.getById(purchaseId);
      if (!purchase) throw new NotFoundError('Purchase', purchaseId);

      // Verify all payment IDs belong to this purchase and are unpaid
      const allPayments = purchase.payments ?? [];
      const unpaidMap = new Map(
        allPayments.filter(pp => !pp.is_paid).map(pp => [pp.id, pp])
      );

      for (const p of payments) {
        if (!unpaidMap.has(p.id)) {
          throw new ValidationError(
            `Payment ${p.id} is either not part of this purchase or is already paid`
          );
        }
      }

      // Calculate: paid total (from already paid installments) + new unpaid total = purchase total
      const paidTotal = allPayments
        .filter(pp => pp.is_paid)
        .reduce((sum, pp) => sum + (pp.paid_amount ?? pp.amount), 0);
      const newUnpaidTotal = payments.reduce((sum, p) => sum + Math.round(p.amount), 0);

      if (paidTotal + newUnpaidTotal !== purchase.total_amount) {
        throw new ValidationError(
          `Schedule total (${paidTotal + newUnpaidTotal}) must equal purchase total (${purchase.total_amount}). ` +
          `Already paid: ${paidTotal}, new unpaid total: ${newUnpaidTotal}`
        );
      }

      for (const p of payments) {
        const rounded = Math.round(p.amount);
        const existing = unpaidMap.get(p.id)!;
        if (rounded !== existing.amount) {
          await this.purchaseRepo.updatePaymentAmount(p.id, rounded);
        }
        if (p.due_date !== existing.due_date) {
          await this.purchaseRepo.updatePaymentDueDate(p.id, p.due_date);
        }
      }
    });

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PAYMENT_SCHEDULE', table: 'purchase_payments',
      recordId: purchaseId, userId,
      newValues: { payments: payments.map(p => ({ id: p.id, amount: p.amount, due_date: p.due_date })) },
    });

    return await this.getById(purchaseId);
  }

  /**
   * Replace all unpaid installments with a new schedule.
   * Used when the user deferred installments during creation and now wants to set them up.
   */
  async replaceUnpaidSchedule(
    purchaseId: number,
    newPayments: Array<{ amount: number; due_date: string }>,
    userId: number,
  ): Promise<Purchase> {
    Validate.id(purchaseId);

    if (!newPayments || newPayments.length === 0) {
      throw new ValidationError('At least one installment must be provided');
    }

    for (let i = 0; i < newPayments.length; i++) {
      const p = newPayments[i];
      if (!Number.isFinite(p.amount) || p.amount <= 0) {
        throw new ValidationError(`Installment ${i + 1} amount must be positive`);
      }
      Validate.dateString(p.due_date, `Installment ${i + 1} due date`);
    }

    await this.base.inTransaction(async () => {
      const purchase = await this.purchaseRepo.getById(purchaseId);
      if (!purchase) throw new NotFoundError('Purchase', purchaseId);

      const allPayments = purchase.payments ?? [];
      const paidTotal = allPayments
        .filter(pp => pp.is_paid)
        .reduce((sum, pp) => sum + (pp.paid_amount ?? pp.amount), 0);
      const newUnpaidTotal = newPayments.reduce((sum, p) => sum + Math.round(p.amount), 0);

      if (paidTotal + newUnpaidTotal !== purchase.total_amount) {
        throw new ValidationError(
          `Schedule total (${paidTotal + newUnpaidTotal}) must equal purchase total (${purchase.total_amount}). ` +
          `Already paid: ${paidTotal}, new unpaid total: ${newUnpaidTotal}`
        );
      }

      // Delete all existing unpaid payments
      await this.purchaseRepo.deleteUnpaidPayments(purchaseId);

      // Insert new payments
      for (const p of newPayments) {
        await this.purchaseRepo.insertPayment({
          purchase_id: purchaseId,
          due_date: p.due_date,
          amount: Math.round(p.amount),
          is_paid: 0,
          paid_date: null,
          payment_method: null,
          reference_number: null,
          expense_id: null,
          paid_by_user_id: null,
        });
      }
    });

    this.bus.emit('entity:mutated', {
      action: 'REPLACE_PAYMENT_SCHEDULE', table: 'purchase_payments',
      recordId: purchaseId, userId,
      newValues: { payments: newPayments },
    });

    return await this.getById(purchaseId);
  }

  // ─── Delete Purchase ────────────────────────────────────────────────────────

  async deletePurchase(id: number, userId: number, force = false): Promise<void> {
    Validate.id(id);
    const existing = await this.purchaseRepo.getById(id);
    if (!existing) throw new NotFoundError('Purchase', id);

    // Block deletion if any payment has already been made (unless force=true for admin)
    if (!force) {
      const hasPaid = await this.purchaseRepo.hasPaidPayments(id);
      if (hasPaid) {
        throw new BusinessRuleError(
          'Cannot delete a purchase that has payments already made. Use force delete as admin.'
        );
      }
    }

    // Collect batch IDs before deletion (CASCADE will remove purchase_items)
    const batchIds = await this.purchaseRepo.getItemBatchIds(id);

    await this.base.inTransaction(async () => {
      // Delete purchase (CASCADE removes items + payments)
      await this.purchaseRepo.delete(id);

      // Clean up orphan batches (only those not referenced by any transaction)
      for (const batchId of batchIds) {
        await this.purchaseRepo.deleteBatchIfOrphan(batchId);
      }
    });

    this.bus.emit('entity:mutated', {
      action: 'DELETE_PURCHASE', table: 'purchases',
      recordId: id, userId,
      oldValues: {
        purchase_number: existing.purchase_number,
        total_amount: existing.total_amount,
        supplier_name: existing.supplier_name,
      },
    });
  }

  // ─── Add Items to Purchase ──────────────────────────────────────────────────

  async addItemsToPurchase(
    purchaseId: number,
    items: CreatePurchaseItemInput[],
    userId: number,
  ): Promise<Purchase> {
    Validate.id(purchaseId);
    const purchase = await this.purchaseRepo.getById(purchaseId);
    if (!purchase) throw new NotFoundError('Purchase', purchaseId);

    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('At least one item is required', 'items');
    }

    return await this.base.inTransaction(async () => {
      // 1. Create products/batches/purchase_items
      await this._processItems(purchaseId, items, userId);

      // 2. Calculate additional total
      const additionalTotal = items.reduce(
        (sum, it) => sum + Money.round(it.quantity * it.cost_per_parent), 0
      );
      const newTotal = purchase.total_amount + additionalTotal;

      // 3. Update total amount
      await this.purchaseRepo.updateTotalAmount(purchaseId, newTotal);

      // 4. Adjust installment schedule to cover the additional total
      //    Without this, installments sum to less than purchase total → stuck at 'partial'
      const unpaid = await this.purchaseRepo.getUnpaidPayments(purchaseId);
      if (unpaid.length > 0) {
        // Add the additional total to the last unpaid installment
        const last = unpaid[unpaid.length - 1];
        await this.purchaseRepo.updatePaymentAmount(last.id, last.amount + additionalTotal);
      } else {
        // All installments are already paid — create a new one for the additional amount
        const today = new Date().toISOString().slice(0, 10);
        const lastPayment = purchase.payments?.[purchase.payments.length - 1];
        let dueDate = today;
        if (lastPayment) {
          const d = new Date(lastPayment.due_date + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + 30);
          dueDate = d.toISOString().slice(0, 10);
        }
        await this.purchaseRepo.insertPayment({
          purchase_id: purchaseId,
          due_date: dueDate,
          amount: additionalTotal,
          is_paid: 0,
          paid_date: null,
          payment_method: null,
          reference_number: null,
          expense_id: null,
          paid_by_user_id: null,
        });
      }

      // 5. Recalculate payment status using fresh total_paid from DB
      const totalPaid = await this.purchaseRepo.getPaidTotal(purchaseId);
      const newStatus = totalPaid >= newTotal
        ? 'paid' as const
        : totalPaid > 0
          ? 'partial' as const
          : 'unpaid' as const;

      await this.purchaseRepo.updateTotals(purchaseId, totalPaid, newStatus);

      // 6. Emit event
      this.bus.emit('entity:mutated', {
        action: 'ADD_PURCHASE_ITEMS', table: 'purchase_items',
        recordId: purchaseId, userId,
        newValues: {
          item_count: items.length,
          additional_total: additionalTotal,
          new_total: newTotal,
          new_status: newStatus,
        },
      });

      // 7. Return updated purchase
      return (await this.purchaseRepo.getById(purchaseId))!;
    });
  }

  // ─── Create Purchase ─────────────────────────────────────────────────────────

  async createPurchase(data: CreatePurchaseInput, userId: number): Promise<Purchase> {
    // Validate top-level fields
    const purchaseDate = Validate.dateString(data.purchase_date, 'Purchase date');
    const alertDays = Math.max(0, Math.round(data.alert_days_before ?? 7));

    // Idempotency check
    const idempotencyKey = data.idempotency_key?.trim();
    if (idempotencyKey) {
      const existingPurchase = await this.purchaseRepo.getByIdempotencyKey(idempotencyKey);
      if (existingPurchase) return existingPurchase;
    }

    // Compute total: trust data.total_amount when provided (user may override the items sum
    // to match the supplier's invoice, e.g. when the invoice includes non-itemised fees).
    // Fall back to summing item costs only when total_amount is absent.
    const hasItems = Array.isArray(data.items) && data.items.length > 0;
    const itemsComputedTotal = hasItems
      ? data.items!.reduce((sum, it) => sum + Money.round(it.quantity * it.cost_per_parent), 0)
      : 0;
    const totalAmount = (data.total_amount && data.total_amount > 0)
      ? Money.round(data.total_amount)
      : hasItems
        ? itemsComputedTotal
        : Money.round(Validate.positiveNumber(data.total_amount, 'Total amount'));

    let finalNotes = data.notes ?? null;
    if (hasItems && data.total_amount && data.total_amount > 0) {
      const delta = Math.abs(totalAmount - itemsComputedTotal);
      const threshold = Math.max(0.05 * itemsComputedTotal, 100);
      if (delta > threshold) {
        if (!data.force_confirm_mismatch) {
          throw new ValidationError(
            `Purchase total (${Money.format(totalAmount)}) differs significantly from the sum of items (${Money.format(itemsComputedTotal)}). Please confirm if this is intentional.`,
            'TOTAL_MISMATCH'
          );
        }
        const deltaText = `[Delta: ${totalAmount > itemsComputedTotal ? '+' : '-'}${Money.format(delta)}]`;
        finalNotes = finalNotes ? `${finalNotes}\n${deltaText}` : deltaText;
      }
    }

    let supplierName: string | null = null;
    if (data.supplier_id) {
      const supplier = await this.supplierRepo.getById(data.supplier_id);
      if (!supplier) throw new NotFoundError('Supplier', data.supplier_id);
      supplierName = supplier.name;
    }

    // Validate payment plan
    this._validatePaymentPlan(data, totalAmount);

    // Generate purchase number
    const datePrefix = purchaseDate.replace(/-/g, '');
    const purchaseNumber = await this.purchaseRepo.getNextNumber(datePrefix);

    // Determine initial payment status
    const isPaidInFull = data.payment_plan.type === 'full';
    const initialStatus = isPaidInFull ? 'paid' as const : 'unpaid' as const;
    const initialPaid = isPaidInFull ? totalAmount : 0;

    // Build descriptive label for expenses
    const invoiceLabel = data.invoice_reference
      ? `Invoice #${data.invoice_reference}`
      : purchaseNumber;
    const supplierLabel = supplierName ? ` — ${supplierName}` : '';

    // Everything in one transaction
    return await this.base.inTransaction(async () => {
      // 1. Insert purchase header
      const purchaseId = await this.purchaseRepo.insert({
        purchase_number: purchaseNumber,
        supplier_id: data.supplier_id ?? null,
        invoice_reference: data.invoice_reference ?? null,
        purchase_date: purchaseDate,
        total_amount: totalAmount,
        total_paid: initialPaid,
        payment_status: initialStatus,
        alert_days_before: alertDays,
        notes: finalNotes,
        user_id: userId,
        idempotency_key: idempotencyKey ?? null,
      });

      // 2. Process items (create products/batches/purchase_items)
      if (hasItems) {
        await this._processItems(purchaseId, data.items!, userId);
      }

      // 3. Handle payment plan
      // NOTE: Supplier payments are NOT recorded as expenses — they are capital outflow
      // tracked separately in purchase_payments. This avoids corrupting P&L and cash flow.
      if (isPaidInFull) {
        await this.purchaseRepo.insertPayment({
          purchase_id: purchaseId,
          due_date: purchaseDate,
          amount: totalAmount,
          is_paid: 1,
          paid_date: purchaseDate,
          payment_method: data.payment_plan.payment_method ?? 'cash',
          reference_number: data.payment_plan.reference_number ?? null,
          expense_id: null,
          paid_by_user_id: userId,
        });
      } else if (data.payment_plan.installments) {
        const insertedPaymentIds: number[] = [];
        for (const inst of data.payment_plan.installments) {
          const payId = await this.purchaseRepo.insertPayment({
            purchase_id: purchaseId,
            due_date: inst.due_date,
            amount: inst.amount,
            is_paid: 0,
            paid_date: null,
            payment_method: null,
            reference_number: null,
            expense_id: null,
            paid_by_user_id: null,
          });
          insertedPaymentIds.push(payId);
        }

        // Handle initial (upfront) payment atomically within the same transaction
        if (data.initial_payment && data.initial_payment.amount > 0 && insertedPaymentIds.length > 0) {
          const initPay = data.initial_payment;
          const initAmount = Math.round(initPay.amount);

          // Validate initial payment
          Validate.enum(initPay.payment_method, ['cash', 'bank_transfer'] as const, 'Initial payment method');
          if (initPay.payment_method === 'bank_transfer' && !initPay.reference_number?.trim()) {
            throw new ValidationError('Reference number is required for bank transfer initial payments', 'reference_number');
          }
          if (initAmount <= 0) {
            throw new ValidationError('Initial payment amount must be positive', 'initial_payment.amount');
          }
          if (initAmount > totalAmount) {
            throw new ValidationError('Initial payment cannot exceed total amount', 'initial_payment.amount');
          }

          const firstPaymentId = insertedPaymentIds[0];
          const firstInstallmentAmount = data.payment_plan.installments![0].amount;

          // Mark first installment as paid (no expense — supplier payments are capital, not expense)
          await this.purchaseRepo.markPaymentPaid(
            firstPaymentId, purchaseDate, initPay.payment_method, null, userId,
            initPay.reference_number?.trim() ?? null,
            initAmount,
          );

          // Handle overpayment: if paid more than first installment, distribute excess
          const diff = initAmount - firstInstallmentAmount;
          if (diff > 0 && insertedPaymentIds.length > 1) {
            let remaining = diff;
            for (let i = 1; i < insertedPaymentIds.length && remaining > 0; i++) {
              const nextPayment = await this.purchaseRepo.getPaymentById(insertedPaymentIds[i]);
              if (!nextPayment || nextPayment.is_paid) continue;
              if (remaining >= nextPayment.amount) {
                remaining -= nextPayment.amount;
                await this.purchaseRepo.markPaymentPaid(
                  nextPayment.id, purchaseDate, initPay.payment_method, null,
                  userId, null, 0, // paid_amount=0: covered by initial overpayment
                );
              } else {
                await this.purchaseRepo.updatePaymentAmount(nextPayment.id, nextPayment.amount - remaining);
                remaining = 0;
              }
            }
          }

          // Update purchase totals
          const newPaidTotal = await this.purchaseRepo.getPaidTotal(purchaseId);
          const newStatus = newPaidTotal >= totalAmount ? 'paid' as const
            : newPaidTotal > 0 ? 'partial' as const : 'unpaid' as const;
          await this.purchaseRepo.updateTotals(purchaseId, newPaidTotal, newStatus);
        }
      }

      // 4. Bulk-insert pending items if provided
      if (Array.isArray(data.pending_items) && data.pending_items.length > 0) {
        for (const pi of data.pending_items) {
          await this.purchaseRepo.insertPendingItem({
            purchase_id: purchaseId,
            raw_data: pi.raw_data,
            notes: pi.notes,
          });
        }
      }

      // 5. Emit purchase created event
      this.bus.emit('entity:mutated', {
        action: 'CREATE_PURCHASE', table: 'purchases',
        recordId: purchaseId, userId,
        newValues: {
          purchase_number: purchaseNumber,
          total_amount: totalAmount,
          payment_type: data.payment_plan.type,
          item_count: hasItems ? data.items!.length : 0,
          pending_item_count: data.pending_items?.length ?? 0,
        },
      });

      // 6. Return full purchase
      const purchase = await this.purchaseRepo.getById(purchaseId);
      if (!purchase) throw new InternalError('Failed to retrieve created purchase');
      return purchase;
    });
  }

  // ─── Mark Payment Paid ───────────────────────────────────────────────────────

  async markPaymentPaid(
    paymentId: number,
    paymentMethod: ExpensePaymentMethod,
    userId: number,
    referenceNumber?: string,
    paidAmount?: number,
    adjustmentStrategy?: PaymentAdjustmentStrategy,
  ): Promise<PurchasePayment> {
    Validate.id(paymentId, 'Payment');
    Validate.enum(paymentMethod, ['cash', 'bank_transfer'] as const, 'Payment method');

    if (paymentMethod === 'bank_transfer' && !referenceNumber?.trim()) {
      throw new ValidationError('Reference number is required for bank transfers', 'reference_number');
    }

    const payment = await this.purchaseRepo.getPaymentById(paymentId);
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.is_paid) {
      throw new BusinessRuleError('This payment has already been marked as paid');
    }

    const effectiveAmount = paidAmount != null ? Math.round(paidAmount) : payment.amount;
    if (!Number.isFinite(effectiveAmount) || effectiveAmount <= 0) {
      throw new ValidationError('Paid amount must be a valid positive number', 'paid_amount');
    }

    const purchase = await this.purchaseRepo.getById(payment.purchase_id);
    if (!purchase) throw new NotFoundError('Purchase', payment.purchase_id);

    // Pre-validate overpayment cap BEFORE entering the transaction.
    // IMPORTANT: Exclude the current payment from unpaid list — it hasn't been marked paid yet,
    // but the excess can only go to OTHER unpaid installments.
    const diff = effectiveAmount - payment.amount;
    if (diff > 0) {
      const unpaidPreCheck = (await this.purchaseRepo.getUnpaidPayments(purchase.id))
        .filter(p => p.id !== paymentId);
      const otherUnpaidTotal = unpaidPreCheck.reduce((sum, p) => sum + p.amount, 0);

      // BUG 7 FIX: Allow overpayment on last installment (common: rounding, settling accounts).
      // The excess is recorded in paid_amount. If there ARE other installments, cap to their total.
      if (unpaidPreCheck.length > 0 && diff > otherUnpaidTotal) {
        throw new BusinessRuleError(
          `Overpayment of ${effectiveAmount} exceeds remaining balance. ` +
          `Maximum payable: ${payment.amount + otherUnpaidTotal}`
        );
      }
    }

    return await this.base.inTransaction(async () => {
      const today = new Date().toISOString().slice(0, 10);

      // 1. Mark payment as paid (no expense — supplier payments are capital outflow, not operational expense)
      await this.purchaseRepo.markPaymentPaid(
        paymentId, today, paymentMethod, null, userId,
        referenceNumber?.trim() ?? null,
        effectiveAmount,
      );

      // 3. Handle difference between scheduled and paid amount
      if (diff !== 0) {
        const strategy = adjustmentStrategy ?? 'next';
        const allUnpaid = await this.purchaseRepo.getUnpaidPayments(purchase.id);
        // Reorder: installments due AFTER the current one first, then earlier ones.
        // This ensures "next" picks the chronologically next installment, not the absolute earliest.
        const afterCurrent = allUnpaid.filter(p => p.due_date >= payment.due_date);
        const beforeCurrent = allUnpaid.filter(p => p.due_date < payment.due_date);
        const unpaid = [...afterCurrent, ...beforeCurrent];

        if (diff > 0) {
          // Overpayment: the excess covers subsequent installment(s).
          // The original expense already records the full effectiveAmount,
          // so auto-paid installments get paid_amount=0 to avoid double-counting
          // in getPaidTotal() (which sums COALESCE(paid_amount, amount) for is_paid=1).
          const excess = diff;

          // Auto-paid installments from overpayment get paid_amount=0 to avoid
          // double-counting in getPaidTotal(). The main payment's paid_amount already
          // includes the full effectiveAmount.
          if (strategy === 'spread' && unpaid.length > 1) {
            const perInstallment = Math.floor(excess / unpaid.length);
            const remainder = excess - (perInstallment * unpaid.length);
            for (let i = 0; i < unpaid.length; i++) {
              const reduction = i === unpaid.length - 1 ? perInstallment + remainder : perInstallment;
              if (reduction >= unpaid[i].amount) {
                await this.purchaseRepo.markPaymentPaid(
                  unpaid[i].id, today, paymentMethod, null,
                  userId, null, 0, // paid_amount=0: covered by overpayment
                );
              } else {
                await this.purchaseRepo.updatePaymentAmount(unpaid[i].id, unpaid[i].amount - reduction);
              }
            }
          } else {
            let remaining = excess;
            for (const next of unpaid) {
              if (remaining <= 0) break;
              if (remaining >= next.amount) {
                remaining -= next.amount;
                await this.purchaseRepo.markPaymentPaid(
                  next.id, today, paymentMethod, null,
                  userId, null, 0, // paid_amount=0: covered by overpayment
                );
              } else {
                await this.purchaseRepo.updatePaymentAmount(next.id, next.amount - remaining);
                remaining = 0;
              }
            }
          }
        } else {
          // Underpayment: deficit needs to be redistributed
          const deficit = Math.abs(diff);

          if (strategy === 'next') {
            // Add deficit to next unpaid installment
            if (unpaid.length > 0) {
              await this.purchaseRepo.updatePaymentAmount(unpaid[0].id, unpaid[0].amount + deficit);
            } else {
              // No unpaid installments left — create a new one for the deficit
              const dueDate = new Date(payment.due_date + 'T00:00:00Z');
              dueDate.setUTCDate(dueDate.getUTCDate() + 30);
              await this.purchaseRepo.insertPayment({
                purchase_id: purchase.id,
                due_date: dueDate.toISOString().slice(0, 10),
                amount: deficit,
                is_paid: 0,
                paid_date: null,
                payment_method: null,
                reference_number: null,
                expense_id: null,
                paid_by_user_id: null,
              });
            }
          } else if (strategy === 'spread') {
            // Spread deficit equally among remaining unpaid installments
            if (unpaid.length > 0) {
              const perInstallment = Math.floor(deficit / unpaid.length);
              const remainder = deficit - (perInstallment * unpaid.length);
              for (let i = 0; i < unpaid.length; i++) {
                const extra = i === unpaid.length - 1 ? perInstallment + remainder : perInstallment;
                await this.purchaseRepo.updatePaymentAmount(unpaid[i].id, unpaid[i].amount + extra);
              }
            } else {
              // No unpaid installments left — create a new one for the deficit
              const dueDate = new Date(payment.due_date + 'T00:00:00Z');
              dueDate.setUTCDate(dueDate.getUTCDate() + 30);
              await this.purchaseRepo.insertPayment({
                purchase_id: purchase.id,
                due_date: dueDate.toISOString().slice(0, 10),
                amount: deficit,
                is_paid: 0,
                paid_date: null,
                payment_method: null,
                reference_number: null,
                expense_id: null,
                paid_by_user_id: null,
              });
            }
          } else if (strategy === 'new_installment') {
            // Create a new installment for the deficit
            const dueDate = new Date(payment.due_date + 'T00:00:00Z');
            dueDate.setUTCDate(dueDate.getUTCDate() + 30);
            await this.purchaseRepo.insertPayment({
              purchase_id: purchase.id,
              due_date: dueDate.toISOString().slice(0, 10),
              amount: deficit,
              is_paid: 0,
              paid_date: null,
              payment_method: null,
              reference_number: null,
              expense_id: null,
              paid_by_user_id: null,
            });
          }
        }
      }

      // 4. Recalculate totals
      const totalPaid = await this.purchaseRepo.getPaidTotal(purchase.id);
      const newStatus = totalPaid >= purchase.total_amount
        ? 'paid' as const
        : totalPaid > 0
          ? 'partial' as const
          : 'unpaid' as const;

      await this.purchaseRepo.updateTotals(purchase.id, totalPaid, newStatus);

      // 5. Emit event (includes adjustment details for audit trail)
      this.bus.emit('entity:mutated', {
        action: 'MARK_PAYMENT_PAID', table: 'purchase_payments',
        recordId: paymentId, userId,
        newValues: {
          purchase_id: purchase.id,
          scheduled_amount: payment.amount,
          paid_amount: effectiveAmount,
          payment_method: paymentMethod,
          adjustment_strategy: diff !== 0 ? (adjustmentStrategy ?? 'next') : undefined,
          adjustment_amount: diff !== 0 ? diff : undefined,
          new_status: newStatus,
        },
      });

      const updated = await this.purchaseRepo.getPaymentById(paymentId);
      if (!updated) throw new InternalError('Failed to retrieve updated payment');
      return updated;
    });
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Process purchase items: create new products/batches or add batches to existing products.
   * Called inside the createPurchase transaction.
   */
  private async _processItems(
    purchaseId: number,
    items: CreatePurchaseItemInput[],
    userId: number,
  ): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.quantity <= 0) {
        throw new ValidationError(`Item quantity must be greater than 0 for "${item.new_product?.name || 'unknown item'}"`);
      }
      if (item.cost_per_parent <= 0) {
        throw new ValidationError(`Item cost must be greater than 0 for "${item.new_product?.name || 'unknown item'}"`);
      }

      const lineTotal = Money.round(item.quantity * item.cost_per_parent);

      if (item.product_id) {
        // ── Existing product → create new batch ──
        const product = await this.productRepo.getById(item.product_id);
        if (!product) throw new NotFoundError('Product', item.product_id);

        // Update barcode on existing product if it has none and the invoice provides one.
        // Skip if the barcode already belongs to another product — assigning a duplicate
        // would break future barcode lookups (the wrong product would be matched).
        if (item.barcode && !product.barcode) {
          const barcodeOwner = await this.productRepo.findByBarcode(item.barcode);
          if (!barcodeOwner) {
            await this.base.run(
              'UPDATE products SET barcode = ? WHERE id = ?',
              [item.barcode, item.product_id]
            );
          }
        }

        const cf = product.conversion_factor || 1;
        const batchId = await this._createBatch(item.product_id, cf, item);

        // Propagate the new batch's selling price to all OTHER active batches of
        // this product. Without this, POS sells from the oldest-expiry batch first
        // (FIFO) — so a freshly raised price wouldn't take effect until the older
        // stock was fully sold. Cost is intentionally NOT touched: per-batch cost
        // is required for accurate margin and FIFO COGS.
        await this._propagateSellingPrice(item.product_id, cf, batchId, item, userId);

        await this.purchaseRepo.insertItem({
          purchase_id: purchaseId,
          product_id: item.product_id,
          batch_id: batchId,
          quantity_received: item.quantity,
          cost_per_parent: Money.roundCost(item.cost_per_parent),
          selling_price_parent: Money.round(item.selling_price_parent),
          line_total: lineTotal,
          expiry_date: item.expiry_date,
          batch_number: item.batch_number ?? null,
        });
      } else if (item.new_product) {
        // ── New product → find existing or create product + batch ──
        const np = item.new_product;
        Validate.requiredString(np.name, 'Product name');

        // Match an existing active product first by barcode (hard identifier),
        // then fall back to name-based match. Name fallback is REQUIRED because
        // there is a partial UNIQUE INDEX on `LOWER(TRIM(name)) WHERE is_active = 1`
        // (see migration.repository.ts:_migrateUniqueProductName). Without it, a
        // new_product whose name collides with an existing active product would
        // raise UNIQUE constraint and fail the whole purchase. Disambiguation by
        // name is a UI-level concern handled in the import-flow Match step.
        let existingProduct = np.barcode
          ? await this.productRepo.findByBarcode(np.barcode)
          : undefined;
        // Track how the match was resolved so a name-based merge (exact normalized
        // name collision, forced by the partial UNIQUE index on active product name)
        // is recorded in the audit log instead of happening silently.
        let matchedBy: 'barcode' | 'name' | null = existingProduct ? 'barcode' : null;
        if (!existingProduct) {
          existingProduct = await this.productRepo.findByName(np.name);
          if (existingProduct) matchedBy = 'name';
        }

        let productId: number;

        if (existingProduct) {
          // Use existing product — just add a new batch
          productId = existingProduct.id;
          // Update barcode if the existing product has none — but only if no other product
          // already owns it, to avoid creating duplicate barcodes.
          if (np.barcode && !existingProduct.barcode) {
            const barcodeOwner = await this.productRepo.findByBarcode(np.barcode);
            if (!barcodeOwner) {
              await this.base.run(
                'UPDATE products SET barcode = ? WHERE id = ?',
                [np.barcode, productId]
              );
            }
          }
        } else {
          // Resolve or create category
          let categoryId: number | null = null;
          if (np.category_name) {
            const existing = await this.categoryRepo.findByName(np.category_name);
            if (existing) {
              categoryId = existing.id;
            } else {
              const catResult = await this.categoryRepo.create(np.category_name);
              categoryId = catResult.lastInsertRowid as number;
            }
          }

          // Create product
          const prodResult = await this.base.run(
            `INSERT INTO products (name, generic_name, usage_instructions, category_id, barcode,
             parent_unit, child_unit, conversion_factor, min_stock_level)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              np.name,
              np.generic_name ?? null,
              np.usage_instructions ?? null,
              categoryId,
              np.barcode ?? null,
              np.parent_unit ?? 'Unit',
              np.child_unit ?? null,
              np.conversion_factor ?? 1,
              np.min_stock_level ?? 0,
            ]
          );
          productId = prodResult.lastInsertRowid as number;
        }

        const cf = existingProduct ? (existingProduct.conversion_factor || 1) : (np.conversion_factor ?? 1);
        const batchId = await this._createBatch(productId, cf, item);

        // For barcode-matched existing products, propagate the new selling price
        // to other active batches (same rationale as the existing-product path).
        // For brand-new products there are no prior batches to update — skip.
        if (existingProduct) {
          await this._propagateSellingPrice(productId, cf, batchId, item, userId);
        }

        await this.purchaseRepo.insertItem({
          purchase_id: purchaseId,
          product_id: productId,
          batch_id: batchId,
          quantity_received: item.quantity,
          cost_per_parent: Money.roundCost(item.cost_per_parent),
          selling_price_parent: Money.round(item.selling_price_parent),
          line_total: lineTotal,
          expiry_date: item.expiry_date,
          batch_number: item.batch_number ?? null,
        });

        // Emit product event
        this.bus.emit('entity:mutated', {
          action: existingProduct ? 'UPDATE_PRODUCT' : 'CREATE_PRODUCT', table: 'products',
          recordId: productId, userId,
          newValues: {
            name: np.name,
            source: 'purchase_import',
            ...(matchedBy === 'name' ? { name_merged: true } : {}),
          },
        });
      } else {
        throw new ValidationError(
          `Item ${i + 1} must have either product_id or new_product`,
          'items'
        );
      }
    }
  }

  /**
   * Update selling price on the product's other active batches so the most-recent
   * purchase price takes effect immediately at POS, not only after older stock is
   * sold (POS deducts FIFO from the oldest-expiry active batch).
   *
   * Updates BOTH the base column and the override column so the price change holds
   * regardless of which one the read query prefers. Quarantine batches (set aside
   * for damage/recall) are left alone. Cost is NOT updated — keeping per-batch cost
   * is essential for accurate margin and FIFO COGS reporting.
   */
  private async _propagateSellingPrice(
    productId: number,
    conversionFactor: number,
    excludeBatchId: number,
    item: { selling_price_parent: number; selling_price_child?: number },
    userId: number,
  ): Promise<void> {
    const sellParent = Money.round(item.selling_price_parent);
    const sellChild  = item.selling_price_child && item.selling_price_child > 0
      ? Money.round(item.selling_price_child)
      : Money.divideToChild(sellParent, conversionFactor);

    // D2: capture what every affected batch's price WAS before overwriting
    // it — without this the audit event carried only the new price, giving
    // nothing to roll back to.
    const affected = await this.base.getAll<{ id: number; selling_price_parent: number; selling_price_child: number | null }>(
      `SELECT id, selling_price_parent, selling_price_child FROM batches
       WHERE product_id = ? AND status = 'active' AND id != ?
         AND price_manually_set_at IS NULL`,
      [productId, excludeBatchId]
    );
    if (affected.length === 0) return;

    const changes = await this.base.runAndGetChanges(
      `UPDATE batches
       SET selling_price_parent = ?,
           selling_price_parent_override = ?,
           selling_price_child = ?,
           selling_price_child_override = ?,
           version = version + 1,
           updated_at = datetime('now', 'localtime')
       WHERE product_id = ?
         AND status = 'active'
         AND id != ?
         AND price_manually_set_at IS NULL`,
      [sellParent, sellParent, sellChild, sellChild, productId, excludeBatchId]
    );

    if (changes > 0) {
      // table/recordId identify a PRODUCT (every other active batch of that
      // product is re-priced), not the single batch row that triggered it —
      // table:'batches' here would attach this event to whichever batch
      // happens to share the numeric id with the product once history is
      // filtered by record_id (I1/I2).
      this.bus.emit('entity:mutated', {
        action: 'PROPAGATE_SELLING_PRICE', table: 'products',
        recordId: productId, userId,
        oldValues: {
          batches: affected.map(b => ({ batch_id: b.id, selling_price_parent: b.selling_price_parent, selling_price_child: b.selling_price_child })),
        },
        newValues: {
          selling_price_parent: sellParent,
          selling_price_child: sellChild,
          source_batch_id: excludeBatchId,
          batches_updated: changes,
        },
      });
    }
  }

  /**
   * Create a batch using direct SQL — same pattern as ProductRepository.bulkCreate.
   * We're already inside a transaction so we use base.run() not runImmediate().
   */
  private async _createBatch(
    productId: number,
    conversionFactor: number,
    item: { expiry_date: string; quantity: number; cost_per_parent: number;
            selling_price_parent: number; selling_price_child?: number; batch_number?: string },
  ): Promise<number> {
    const costParent = Money.roundCost(item.cost_per_parent);
    const sellParent = Money.round(item.selling_price_parent);
    const costChild  = Money.costPerChild(costParent, conversionFactor);
    const sellChild  = item.selling_price_child && item.selling_price_child > 0
      ? Money.round(item.selling_price_child)
      : Money.divideToChild(sellParent, conversionFactor);
    // Round to whole base units: dual-unit entry (e.g. 3 box + 5 strip) arrives as a
    // fractional parent quantity, so quantity * cf can carry float noise (5/3 × 3 = 5.0001).
    const quantityBase = Math.round(item.quantity * conversionFactor);

    // Bound the free-text batch number (length + trim); null when empty.
    const batchNumber = Validate.optionalString(item.batch_number, 'Batch number', 60);

    // Expiry is optional: normalize to end-of-month ISO when provided, else use
    // the no-expiry sentinel (batches.expiry_date is NOT NULL).
    const expiryDate = item.expiry_date && item.expiry_date.trim()
      ? (normalizeExpiry(item.expiry_date) || NO_EXPIRY_SENTINEL)
      : NO_EXPIRY_SENTINEL;

    Validate.dateString(expiryDate, 'Expiry date');

    // B7: importing an invoice for already-expired stock must not create a
    // silently active/sellable batch — the INSERT used to omit the status
    // column entirely, which defaults to 'active' at the schema level
    // regardless of expiry. Matches BatchService.create's manual-entry path.
    const status = expiryDate <= todayLocalISO() ? 'quarantine' : 'active';

    const result = await this.base.run(
      `INSERT INTO batches (product_id, batch_number, expiry_date, quantity_base,
       cost_per_parent, cost_per_child, cost_per_child_override,
       selling_price_parent, selling_price_child,
       selling_price_parent_override, selling_price_child_override, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        productId, batchNumber, expiryDate,
        quantityBase, costParent, costChild, costChild,
        sellParent, sellChild, sellParent, sellChild, status,
      ]
    );
    return result.lastInsertRowid as number;
  }

  private _validatePaymentPlan(data: CreatePurchaseInput, totalAmount?: number): void {
    const plan = data.payment_plan;
    if (!plan) {
      throw new ValidationError('Payment plan is required', 'payment_plan');
    }

    Validate.enum(plan.type, ['full', 'installments'] as const, 'Payment type');

    if (plan.type === 'full') {
      if (plan.payment_method) {
        Validate.enum(plan.payment_method, ['cash', 'bank_transfer'] as const, 'Payment method');
      }
    } else if (plan.type === 'installments') {
      if (!Array.isArray(plan.installments) || plan.installments.length === 0) {
        throw new ValidationError('Installments are required for installment payment', 'installments');
      }

      let installmentTotal = 0;
      for (let i = 0; i < plan.installments.length; i++) {
        const inst = plan.installments[i];
        Validate.dateString(inst.due_date, `Installment ${i + 1} due date`);
        Validate.positiveNumber(inst.amount, `Installment ${i + 1} amount`);
        installmentTotal += Money.round(inst.amount);
      }

      const total = totalAmount ?? Money.round(data.total_amount);
      if (installmentTotal !== total) {
        throw new ValidationError(
          `Installment amounts (${installmentTotal}) must equal total amount (${total})`,
          'installments'
        );
      }
    }
  }

  // ─── Pending Items ────────────────────────────────────────────────────────

  async getPendingItems(purchaseId: number): Promise<PurchasePendingItem[]> {
    const purchase = await this.purchaseRepo.getById(purchaseId);
    if (!purchase) throw new NotFoundError('Purchase', purchaseId);
    return this.purchaseRepo.getPendingItems(purchaseId);
  }

  async getAllPendingItems(filters: { search?: string; supplier_id?: number; page?: number; limit?: number }): Promise<PaginatedResult<EnrichedPendingItem>> {
    return await this.purchaseRepo.getAllPendingItems(filters);
  }

  // ─── Payment Editing ─────────────────────────────────────────────────────

  async updatePayment(
    paymentId: number,
    data: { amount?: number; due_date?: string; payment_method?: string; reference_number?: string | null },
    userId: number
  ): Promise<PurchasePayment> {
    const payment = await this.purchaseRepo.getPaymentById(paymentId);
    if (!payment) throw new NotFoundError('Payment', paymentId);

    // Editing the scheduled amount/due_date of an already-paid installment desyncs it from
    // the actual paid_amount and corrupts the financial record. Require an unmark first.
    if (payment.is_paid && (data.amount !== undefined || data.due_date !== undefined)) {
      throw new BusinessRuleError('Cannot change the amount or due date of a paid payment. Unmark it as paid first.');
    }

    const updateData: Record<string, unknown> = {};
    if (data.amount !== undefined) updateData.amount = Money.round(Validate.positiveNumber(data.amount, 'Amount'));
    if (data.due_date !== undefined) updateData.due_date = Validate.dateString(data.due_date, 'Due date');
    if (data.payment_method !== undefined) updateData.payment_method = data.payment_method;
    if (data.reference_number !== undefined) updateData.reference_number = data.reference_number;

    // BUG 4 FIX: Do NOT sync paid_amount with amount.
    // paid_amount = what was actually paid (independent of scheduled amount).

    await this.purchaseRepo.updatePayment(paymentId, updateData);

    // Recalculate purchase totals
    const purchase = await this.purchaseRepo.getById(payment.purchase_id);
    if (purchase) {
      const newPaidTotal = await this.purchaseRepo.getPaidTotal(purchase.id);
      const newStatus = newPaidTotal >= purchase.total_amount ? 'paid' as const
        : newPaidTotal > 0 ? 'partial' as const : 'unpaid' as const;
      await this.purchaseRepo.updateTotals(purchase.id, newPaidTotal, newStatus);
    }

    // This emit previously had no oldValues at all — a payment amount/due-date
    // edit was unrecoverable in the audit log.
    const { oldValues, newValues } = diffValues(
      payment as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    );

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PURCHASE', table: 'purchase_payments',
      recordId: paymentId, userId,
      oldValues, newValues,
    });

    const updated = await this.purchaseRepo.getPaymentById(paymentId);
    if (!updated) throw new InternalError('Failed to retrieve updated payment');
    return updated;
  }

  async deletePayment(paymentId: number, userId: number): Promise<void> {
    const payment = await this.purchaseRepo.getPaymentById(paymentId);
    if (!payment) throw new NotFoundError('Payment', paymentId);

    // Deleting a paid payment silently erases the record of an actual money transfer.
    // Require unmarking it first so the paid_amount/total reconciliation stays correct.
    if (payment.is_paid) {
      throw new BusinessRuleError('Cannot delete a paid payment. Unmark it as paid first to preserve the record of the money transfer.');
    }

    await this.purchaseRepo.deletePayment(paymentId);

    // Recalculate purchase totals
    const purchase = await this.purchaseRepo.getById(payment.purchase_id);
    if (purchase) {
      const newPaidTotal = await this.purchaseRepo.getPaidTotal(purchase.id);
      const newStatus = newPaidTotal >= purchase.total_amount ? 'paid' as const
        : newPaidTotal > 0 ? 'partial' as const : 'unpaid' as const;
      await this.purchaseRepo.updateTotals(purchase.id, newPaidTotal, newStatus);
    }

    this.bus.emit('entity:mutated', {
      action: 'DELETE_PAYMENT', table: 'purchase_payments',
      recordId: paymentId, userId,
    });
  }

  async unmarkPaymentPaid(paymentId: number, userId: number): Promise<PurchasePayment> {
    const payment = await this.purchaseRepo.getPaymentById(paymentId);
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (!payment.is_paid) throw new ValidationError('Payment is already unpaid', 'payment');

    // BUG 2 FIX: Clear paid_amount to prevent stale value in getPaidTotal()
    await this.purchaseRepo.updatePayment(paymentId, {
      is_paid: 0,
      paid_date: null,
      paid_amount: null,
      payment_method: null,
      reference_number: null,
    });

    // Recalculate purchase totals
    const purchase = await this.purchaseRepo.getById(payment.purchase_id);
    if (purchase) {
      const newPaidTotal = await this.purchaseRepo.getPaidTotal(purchase.id);
      const newStatus = newPaidTotal >= purchase.total_amount ? 'paid' as const
        : newPaidTotal > 0 ? 'partial' as const : 'unpaid' as const;
      await this.purchaseRepo.updateTotals(purchase.id, newPaidTotal, newStatus);
    }

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PURCHASE', table: 'purchase_payments',
      recordId: paymentId, userId,
      newValues: { is_paid: 0 },
    });

    const updated = await this.purchaseRepo.getPaymentById(paymentId);
    if (!updated) throw new InternalError('Failed to retrieve updated payment');
    return updated;
  }

  // ─── Purchase Item Editing ──────────────────────────────────────────────

  async updatePurchaseItem(
    itemId: number,
    data: { quantity_received?: number; cost_per_parent?: number; selling_price_parent?: number },
    userId: number
  ): Promise<PurchaseItem> {
    const item = await this.purchaseRepo.getItemById(itemId);
    if (!item) throw new NotFoundError('PurchaseItem', itemId);

    const updateData: Record<string, unknown> = {};
    if (data.quantity_received !== undefined) updateData.quantity_received = Validate.positiveInteger(data.quantity_received, 'Quantity');
    if (data.cost_per_parent !== undefined && data.cost_per_parent !== item.cost_per_parent) {
      if (item.batch_id) {
        const batchInfo = await this.base.getOne<{ txn_count: number; adj_count: number }>(
          `SELECT
             (SELECT COUNT(*) FROM transaction_items WHERE batch_id = ?) as txn_count,
             (SELECT COUNT(*) FROM inventory_adjustments WHERE batch_id = ?) as adj_count
           FROM batches WHERE id = ?`,
          [item.batch_id, item.batch_id, item.batch_id]
        );
        if (batchInfo && (batchInfo.txn_count > 0 || batchInfo.adj_count > 0)) {
          throw new BusinessRuleError('Cannot edit cost of a purchase item whose batch has transaction or adjustment history');
        }
      }
      updateData.cost_per_parent = Money.roundCost(Validate.positiveNumber(data.cost_per_parent, 'Cost'));
    }
    if (data.selling_price_parent !== undefined) updateData.selling_price_parent = Money.round(data.selling_price_parent);

    // Recalculate line_total
    const qty = (updateData.quantity_received ?? item.quantity_received) as number;
    const cost = (updateData.cost_per_parent ?? item.cost_per_parent) as number;
    const oldLineTotal = item.line_total ?? Money.round(item.quantity_received * item.cost_per_parent);
    const newLineTotal = Money.round(qty * cost);
    updateData.line_total = newLineTotal;

    // Wrap all writes (item, batch, purchase totals) in a single transaction so a
    // partial failure can't leave the purchase total inconsistent with its items.
    await this.base.inTransaction(async () => {
      await this.purchaseRepo.updateItem(itemId, updateData);

      // Update associated batch if it exists
      // BUG 3 FIX: Update _override fields (POS uses override > 0 ? override : base)
      if (item.batch_id) {
        const product = await this.productRepo.getById(item.product_id);
        const cf = product?.conversion_factor ?? 1;
        const sets: string[] = [];
        const params: unknown[] = [];
        if (data.cost_per_parent !== undefined) {
          sets.push('cost_per_parent = ?');
          params.push(updateData.cost_per_parent);
          // Recalculate child cost from parent cost using CF
          if (cf > 1) {
            const childCost = Money.costPerChild(updateData.cost_per_parent as number, cf);
            sets.push('cost_per_child = ?', 'cost_per_child_override = ?');
            params.push(childCost, childCost);
          }
        }
        if (data.selling_price_parent !== undefined) {
          sets.push('selling_price_parent = ?', 'selling_price_parent_override = ?');
          params.push(updateData.selling_price_parent, updateData.selling_price_parent);
          // Recalculate child selling price from parent price using CF
          if (cf > 1) {
            const childSell = Money.divideToChild(updateData.selling_price_parent as number, cf);
            sets.push('selling_price_child = ?', 'selling_price_child_override = ?');
            params.push(childSell, childSell);
          }
        }
        if (data.quantity_received !== undefined) {
          // INTEGRITY FIX: apply the DELTA in base units, never reset to qty*cf — resetting
          // would wipe out units already sold/adjusted from this batch and inflate stock
          // (system shows more than actual). Re-derive status from the resulting quantity.
          const deltaBase = (qty - item.quantity_received) * cf;
          if (deltaBase !== 0) {
            const b = await this.base.getOne<{ quantity_base: number; status: string }>(
              'SELECT quantity_base, status FROM batches WHERE id = ?', [item.batch_id]
            );
            if (b) {
              const newQty = Math.max(0, b.quantity_base + deltaBase);
              const newStatus = newQty === 0 ? 'sold_out'
                : (b.status === 'sold_out' ? 'active' : b.status);
              sets.push('quantity_base = ?', 'status = ?');
              params.push(newQty, newStatus);
            }
          }
        }
        if (sets.length > 0) {
          await this.base.run(
            `UPDATE batches SET ${sets.join(', ')}, version = version + 1, updated_at = datetime('now', 'localtime') WHERE id = ?`,
            [...params, item.batch_id]
          );
        }
      }

      // BUG 6 FIX: Use delta to preserve pending item cost in total
      // BUG 5 FIX: Also recalculate payment status
      const purchase = await this.purchaseRepo.getById(item.purchase_id);
      if (purchase) {
        const delta = newLineTotal - oldLineTotal;
        const newTotal = Math.max(0, purchase.total_amount + delta);
        await this.purchaseRepo.updateTotalAmount(purchase.id, newTotal);

        const paidTotal = await this.purchaseRepo.getPaidTotal(purchase.id);
        const newStatus = paidTotal >= newTotal ? 'paid' as const
          : paidTotal > 0 ? 'partial' as const : 'unpaid' as const;
        await this.purchaseRepo.updateTotals(purchase.id, paidTotal, newStatus);
      }
    });

    // This emit previously had no oldValues at all — a quantity/cost/price
    // edit on a purchase item was unrecoverable in the audit log.
    const { oldValues, newValues } = diffValues(
      item as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    );

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PURCHASE', table: 'purchase_items',
      recordId: itemId, userId,
      oldValues, newValues,
    });

    const updated = await this.purchaseRepo.getItemById(itemId);
    if (!updated) throw new InternalError('Failed to retrieve updated item');
    return updated;
  }

  async deletePurchaseItem(itemId: number, userId: number): Promise<void> {
    const item = await this.purchaseRepo.getItemById(itemId);
    if (!item) throw new NotFoundError('PurchaseItem', itemId);

    const itemLineTotal = item.line_total ?? Money.round(item.quantity_received * item.cost_per_parent);
    const batchId = item.batch_id;

    // Wrap item removal, batch cleanup, adjustment insert and total recalculation in a
    // single transaction so a mid-sequence failure can't leave the purchase inconsistent.
    await this.base.inTransaction(async () => {
      // BUG 1 FIX: Delete item FIRST (removes purchase_items FK to batch),
      // THEN handle batch cleanup safely
      await this.purchaseRepo.deleteItem(itemId);

      if (batchId) {
        // Try safe delete: only if no transaction_items or inventory_adjustments reference it
        const canDelete = await this.base.getOne<{ cnt: number }>(
          `SELECT (
             (SELECT COUNT(*) FROM transaction_items WHERE batch_id = ?) +
             (SELECT COUNT(*) FROM inventory_adjustments WHERE batch_id = ?)
           ) as cnt`,
          [batchId, batchId]
        );
        if ((canDelete?.cnt ?? 0) === 0) {
          await this.base.run('DELETE FROM batches WHERE id = ?', [batchId]);
        } else {
          // Soft-delete: zero out stock, mark sold_out, increment version for optimistic locking
          const batchRow = await this.base.getOne<{ quantity_base: number; product_id: number }>(
            'SELECT quantity_base, product_id FROM batches WHERE id = ?', [batchId]
          );
          await this.base.run(
            `UPDATE batches SET quantity_base = 0, status = 'sold_out', version = version + 1, updated_at = datetime('now', 'localtime') WHERE id = ?`,
            [batchId]
          );
          // Create adjustment record so reconciliation stays balanced
          if (batchRow && batchRow.quantity_base > 0) {
            await this.base.run(
              `INSERT INTO inventory_adjustments (product_id, batch_id, quantity_base, reason, type, user_id, created_at)
               VALUES (?, ?, ?, ?, 'correction', ?, datetime('now', 'localtime'))`,
              [batchRow.product_id, batchId, batchRow.quantity_base, 'Purchase item deleted — stock removed', userId]
            );
          }
        }
      }

      // BUG 9 FIX: Use delta, not full recalc (preserves pending item cost)
      // BUG 5 FIX: Also recalculate payment status
      const purchase = await this.purchaseRepo.getById(item.purchase_id);
      if (purchase) {
        const newTotal = Math.max(0, purchase.total_amount - itemLineTotal);
        await this.purchaseRepo.updateTotalAmount(purchase.id, newTotal);

        const paidTotal = await this.purchaseRepo.getPaidTotal(purchase.id);
        const newStatus = paidTotal >= newTotal ? 'paid' as const
          : paidTotal > 0 ? 'partial' as const : 'unpaid' as const;
        await this.purchaseRepo.updateTotals(purchase.id, paidTotal, newStatus);
      }
    });

    this.bus.emit('entity:mutated', {
      action: 'DELETE_PURCHASE_ITEM', table: 'purchase_items',
      recordId: itemId, userId,
    });
  }

  // ─── Pending Items ──────────────────────────────────────────────────────

  async completePendingItem(pendingItemId: number, itemData: CreatePurchaseItemInput, userId: number): Promise<Purchase> {
    const pendingItem = await this.purchaseRepo.getPendingItemById(pendingItemId);
    if (!pendingItem) throw new NotFoundError('PendingItem', pendingItemId);

    const purchase = await this.purchaseRepo.getById(pendingItem.purchase_id);
    if (!purchase) throw new NotFoundError('Purchase', pendingItem.purchase_id);

    return await this.base.inTransaction(async () => {
      // Process the item (creates product/batch/purchase_item).
      // The item cost is already included in purchase.total_amount (parked items
      // are counted in the invoice total at creation time), so we do NOT adjust
      // the total or payment schedule here — just convert parked → real inventory.
      await this._processItems(purchase.id, [itemData], userId);

      // Remove the pending item
      await this.purchaseRepo.deletePendingItem(pendingItemId);

      this.bus.emit('entity:mutated', {
        action: 'COMPLETE_PENDING_ITEM', table: 'purchase_pending_items',
        recordId: pendingItemId, userId,
        newValues: { purchase_id: purchase.id },
      });

      const updated = await this.purchaseRepo.getById(purchase.id);
      if (!updated) throw new InternalError('Failed to retrieve updated purchase');
      return updated;
    });
  }

  async deletePendingItem(pendingItemId: number, userId: number): Promise<void> {
    const pendingItem = await this.purchaseRepo.getPendingItemById(pendingItemId);
    if (!pendingItem) throw new NotFoundError('PendingItem', pendingItemId);

    await this.purchaseRepo.deletePendingItem(pendingItemId);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_PENDING_ITEM', table: 'purchase_pending_items',
      recordId: pendingItemId, userId,
      newValues: { purchase_id: pendingItem.purchase_id },
    });
  }

  async updatePendingItem(pendingItemId: number, rawData: string, notes: string | null | undefined, userId: number): Promise<PurchasePendingItem> {
    const pendingItem = await this.purchaseRepo.getPendingItemById(pendingItemId);
    if (!pendingItem) throw new NotFoundError('PendingItem', pendingItemId);

    if (!rawData || !rawData.trim()) throw new ValidationError('raw_data is required', 'raw_data');

    await this.purchaseRepo.updatePendingItem(pendingItemId, rawData, notes);
    // This emit previously recorded neither the old nor new content — just
    // the unrelated purchase_id FK, useless for reconstructing what changed.
    // raw_data is a JSON blob of line items; diff it as a changed-flag rather
    // than storing the full before/after blob twice in every audit row.
    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PENDING_ITEM', table: 'purchase_pending_items',
      recordId: pendingItemId, userId,
      oldValues: { notes: pendingItem.notes, raw_data_changed: rawData !== pendingItem.raw_data },
      newValues: { notes: notes ?? null, raw_data_changed: rawData !== pendingItem.raw_data },
    });

    const updated = await this.purchaseRepo.getPendingItemById(pendingItemId);
    if (!updated) throw new NotFoundError('PendingItem', pendingItemId);
    return updated;
  }

  // ─── Merge Purchases ─────────────────────────────────────────────────────────

  async mergePurchases(targetId: number, sourceIds: number[], userId: number): Promise<Purchase> {
    if (!sourceIds.length) throw new ValidationError('At least one source purchase is required', 'sourceIds');
    if (sourceIds.includes(targetId)) throw new ValidationError('Target cannot be in source list', 'sourceIds');

    const target = await this.purchaseRepo.getById(targetId);
    if (!target) throw new NotFoundError('Purchase', targetId);

    const sources: Purchase[] = [];
    for (const sid of sourceIds) {
      const src = await this.purchaseRepo.getById(sid);
      if (!src) throw new NotFoundError('Purchase', sid);
      sources.push(src);
    }

    // All must share the same supplier
    for (const src of sources) {
      if (src.supplier_id !== target.supplier_id) {
        throw new BusinessRuleError('All invoices must be from the same supplier to merge');
      }
    }

    // None of the sources may have paid payments
    for (const src of sources) {
      const hasPaid = await this.purchaseRepo.hasPaidPayments(src.id);
      if (hasPaid) {
        throw new BusinessRuleError(`Purchase ${src.purchase_number} has paid payments and cannot be merged`);
      }
    }

    return await this.base.inTransaction(async () => {
      let newTotal = target.total_amount;

      for (const src of sources) {
        newTotal += src.total_amount;
        await this.purchaseRepo.reparentItems(src.id, targetId);
        await this.purchaseRepo.reparentPayments(src.id, targetId);
        await this.purchaseRepo.reparentPendingItems(src.id, targetId);
        await this.purchaseRepo.delete(src.id);
      }

      await this.purchaseRepo.updateTotalAmount(targetId, newTotal);

      // Recalculate paid totals and status
      const newPaidTotal = await this.purchaseRepo.getPaidTotal(targetId);
      const newStatus = newPaidTotal >= newTotal ? 'paid' as const
        : newPaidTotal > 0 ? 'partial' as const : 'unpaid' as const;
      await this.purchaseRepo.updateTotals(targetId, newPaidTotal, newStatus);

      this.bus.emit('entity:mutated', {
        action: 'MERGE_PURCHASES', table: 'purchases',
        recordId: targetId, userId,
        newValues: { merged_count: sourceIds.length, new_total: newTotal },
      });

      const merged = await this.purchaseRepo.getById(targetId);
      if (!merged) throw new InternalError('Failed to retrieve merged purchase');
      return merged;
    });
  }
}
