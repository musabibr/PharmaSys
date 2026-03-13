import type { PurchaseRepository } from '../repositories/sql/purchase.repository';
import type { SupplierRepository } from '../repositories/sql/supplier.repository';
import type { ExpenseRepository } from '../repositories/sql/expense.repository';
import type { ShiftRepository } from '../repositories/sql/shift.repository';
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
  PaymentAdjustmentStrategy,
} from '../types/models';
import { Validate } from '../common/validation';
import { Money } from '../common/money';
import { NotFoundError, ValidationError, BusinessRuleError, InternalError } from '../types/errors';

export class PurchaseService {
  constructor(
    private readonly purchaseRepo: PurchaseRepository,
    private readonly supplierRepo: SupplierRepository,
    private readonly expenseRepo:  ExpenseRepository,
    private readonly shiftRepo:    ShiftRepository,
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

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_SUPPLIER', table: 'suppliers',
      recordId: id, userId,
      oldValues: { name: existing.name },
      newValues: data as Record<string, unknown>,
    });

    return await this.getSupplierById(id);
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

    await this.purchaseRepo.update(id, data);

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_PURCHASE', table: 'purchases',
      recordId: id, userId,
      oldValues: {
        supplier_id: existing.supplier_id,
        invoice_reference: existing.invoice_reference,
        purchase_date: existing.purchase_date,
        notes: existing.notes,
      },
      newValues: data as Record<string, unknown>,
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

  // ─── Delete Purchase ────────────────────────────────────────────────────────

  async deletePurchase(id: number, userId: number): Promise<void> {
    Validate.id(id);
    const existing = await this.purchaseRepo.getById(id);
    if (!existing) throw new NotFoundError('Purchase', id);

    // Block deletion if any payment has already been made
    const hasPaid = await this.purchaseRepo.hasPaidPayments(id);
    if (hasPaid) {
      throw new BusinessRuleError(
        'Cannot delete a purchase that has payments already made. Archive it instead.'
      );
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

    // Compute total from items if present, otherwise use provided total
    const hasItems = Array.isArray(data.items) && data.items.length > 0;
    const totalAmount = hasItems
      ? data.items!.reduce((sum, it) => sum + Money.round(it.quantity * it.cost_per_parent), 0)
      : Money.round(Validate.positiveNumber(data.total_amount, 'Total amount'));

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
        notes: data.notes ?? null,
        user_id: userId,
      });

      // 2. Process items (create products/batches/purchase_items)
      if (hasItems) {
        await this._processItems(purchaseId, data.items!, userId);
      }

      // 3. Handle payment plan
      if (isPaidInFull) {
        const expCatId = await this._getOrCreateSupplierPaymentCategory();
        const shift = await this.shiftRepo.findOpenByUser(userId);

        const expenseResult = await this.expenseRepo.create(
          {
            category_id: expCatId,
            amount: totalAmount,
            description: `Supplier invoice payment — ${invoiceLabel}${supplierLabel}`,
            expense_date: purchaseDate,
            payment_method: data.payment_plan.payment_method ?? 'cash',
          },
          userId,
          shift?.id ?? null,
        );
        const expenseId = expenseResult.lastInsertRowid as number;

        await this.purchaseRepo.insertPayment({
          purchase_id: purchaseId,
          due_date: purchaseDate,
          amount: totalAmount,
          is_paid: 1,
          paid_date: purchaseDate,
          payment_method: data.payment_plan.payment_method ?? 'cash',
          reference_number: data.payment_plan.reference_number ?? null,
          expense_id: expenseId,
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
          const expCatId = await this._getOrCreateSupplierPaymentCategory();
          const shift = await this.shiftRepo.findOpenByUser(userId);

          const expenseResult = await this.expenseRepo.create(
            {
              category_id: expCatId,
              amount: initAmount,
              description: `Supplier invoice upfront payment — ${invoiceLabel}${supplierLabel}`,
              expense_date: purchaseDate,
              payment_method: initPay.payment_method,
            },
            userId,
            shift?.id ?? null,
          );
          const expenseId = expenseResult.lastInsertRowid as number;

          // Mark first installment as paid
          await this.purchaseRepo.markPaymentPaid(
            firstPaymentId, purchaseDate, initPay.payment_method, expenseId, userId,
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
                  nextPayment.id, purchaseDate, initPay.payment_method, expenseId,
                  userId, null, nextPayment.amount,
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

      // 4. Emit purchase created event
      this.bus.emit('entity:mutated', {
        action: 'CREATE_PURCHASE', table: 'purchases',
        recordId: purchaseId, userId,
        newValues: {
          purchase_number: purchaseNumber,
          total_amount: totalAmount,
          payment_type: data.payment_plan.type,
          item_count: hasItems ? data.items!.length : 0,
        },
      });

      // 5. Return full purchase
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

      if (unpaidPreCheck.length === 0) {
        // This is the only remaining installment — overpayment is not allowed
        throw new BusinessRuleError(
          `Cannot overpay the last remaining installment. ` +
          `Maximum payable: ${payment.amount}`
        );
      }

      if (diff > otherUnpaidTotal) {
        throw new BusinessRuleError(
          `Overpayment of ${effectiveAmount} exceeds remaining balance. ` +
          `Maximum payable: ${payment.amount + otherUnpaidTotal}`
        );
      }
    }

    return await this.base.inTransaction(async () => {
      const today = new Date().toISOString().slice(0, 10);

      // 1. Create expense for the actual paid amount
      const expCatId = await this._getOrCreateSupplierPaymentCategory();
      const shift = await this.shiftRepo.findOpenByUser(userId);

      const payInvoiceLabel = purchase.invoice_reference
        ? `Invoice #${purchase.invoice_reference}`
        : purchase.purchase_number;
      const paySupplierLabel = purchase.supplier_name ? ` — ${purchase.supplier_name}` : '';

      const expenseResult = await this.expenseRepo.create(
        {
          category_id: expCatId,
          amount: effectiveAmount,
          description: `Supplier invoice payment — ${payInvoiceLabel}${paySupplierLabel}`,
          expense_date: today,
          payment_method: paymentMethod,
        },
        userId,
        shift?.id ?? null,
      );
      const expenseId = expenseResult.lastInsertRowid as number;

      // 2. Mark payment as paid with actual paid amount
      await this.purchaseRepo.markPaymentPaid(
        paymentId, today, paymentMethod, expenseId, userId,
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

          if (strategy === 'spread' && unpaid.length > 1) {
            // Spread: distribute excess reduction equally across all remaining installments
            const perInstallment = Math.floor(excess / unpaid.length);
            const remainder = excess - (perInstallment * unpaid.length);
            for (let i = 0; i < unpaid.length; i++) {
              const reduction = i === unpaid.length - 1 ? perInstallment + remainder : perInstallment;
              if (reduction >= unpaid[i].amount) {
                // Reduction covers this installment fully → mark it paid
                await this.purchaseRepo.markPaymentPaid(
                  unpaid[i].id, today, paymentMethod, expenseId,
                  userId, null, unpaid[i].amount,
                );
              } else {
                // Reduce this installment's scheduled amount
                await this.purchaseRepo.updatePaymentAmount(unpaid[i].id, unpaid[i].amount - reduction);
              }
            }
          } else {
            // 'next' strategy (default): apply excess sequentially
            let remaining = excess;
            for (const next of unpaid) {
              if (remaining <= 0) break;
              if (remaining >= next.amount) {
                remaining -= next.amount;
                await this.purchaseRepo.markPaymentPaid(
                  next.id, today, paymentMethod, expenseId,
                  userId, null, next.amount,
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
      const lineTotal = Money.round(item.quantity * item.cost_per_parent);

      if (item.product_id) {
        // ── Existing product → create new batch ──
        const product = await this.productRepo.getById(item.product_id);
        if (!product) throw new NotFoundError('Product', item.product_id);

        const cf = product.conversion_factor || 1;
        const batchId = await this._createBatch(item.product_id, cf, item);

        await this.purchaseRepo.insertItem({
          purchase_id: purchaseId,
          product_id: item.product_id,
          batch_id: batchId,
          quantity_received: item.quantity,
          cost_per_parent: Money.round(item.cost_per_parent),
          selling_price_parent: Money.round(item.selling_price_parent),
          line_total: lineTotal,
          expiry_date: item.expiry_date,
          batch_number: item.batch_number ?? null,
        });
      } else if (item.new_product) {
        // ── New product → create product + batch ──
        const np = item.new_product;
        Validate.requiredString(np.name, 'Product name');

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
        const productId = prodResult.lastInsertRowid as number;

        const cf = np.conversion_factor ?? 1;
        const batchId = await this._createBatch(productId, cf, item);

        await this.purchaseRepo.insertItem({
          purchase_id: purchaseId,
          product_id: productId,
          batch_id: batchId,
          quantity_received: item.quantity,
          cost_per_parent: Money.round(item.cost_per_parent),
          selling_price_parent: Money.round(item.selling_price_parent),
          line_total: lineTotal,
          expiry_date: item.expiry_date,
          batch_number: item.batch_number ?? null,
        });

        // Emit product created event
        this.bus.emit('entity:mutated', {
          action: 'CREATE_PRODUCT', table: 'products',
          recordId: productId, userId,
          newValues: { name: np.name, source: 'purchase_import' },
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
   * Create a batch using direct SQL — same pattern as ProductRepository.bulkCreate.
   * We're already inside a transaction so we use base.run() not runImmediate().
   */
  private async _createBatch(
    productId: number,
    conversionFactor: number,
    item: { expiry_date: string; quantity: number; cost_per_parent: number;
            selling_price_parent: number; selling_price_child?: number; batch_number?: string },
  ): Promise<number> {
    const costParent = Money.round(item.cost_per_parent);
    const sellParent = Money.round(item.selling_price_parent);
    const costChild  = Money.divideToChild(costParent, conversionFactor);
    const sellChild  = item.selling_price_child && item.selling_price_child > 0
      ? Money.round(item.selling_price_child)
      : Money.divideToChild(sellParent, conversionFactor);
    const quantityBase = item.quantity * conversionFactor;

    // Expiry date is NOT NULL in the schema — default to 2 years from now if missing
    const expiryDate = item.expiry_date && item.expiry_date.trim()
      ? item.expiry_date
      : new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const result = await this.base.run(
      `INSERT INTO batches (product_id, batch_number, expiry_date, quantity_base,
       cost_per_parent, cost_per_child, cost_per_child_override,
       selling_price_parent, selling_price_child,
       selling_price_parent_override, selling_price_child_override, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        productId, item.batch_number ?? null, expiryDate,
        quantityBase, costParent, costChild, costChild,
        sellParent, sellChild, sellParent, sellChild,
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

  private async _getOrCreateSupplierPaymentCategory(): Promise<number> {
    const categories = await this.expenseRepo.getCategories();
    const existing = categories.find(c => c.name === 'Supplier Payment');
    if (existing) return existing.id;

    const result = await this.expenseRepo.createCategory('Supplier Payment');
    return result.lastInsertRowid as number;
  }
}
