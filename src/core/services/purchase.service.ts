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
  ExpensePaymentMethod,
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

    if (data.supplier_id) {
      const supplier = await this.supplierRepo.getById(data.supplier_id);
      if (!supplier) throw new NotFoundError('Supplier', data.supplier_id);
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
            description: `Supplier payment for ${purchaseNumber}`,
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
        for (const inst of data.payment_plan.installments) {
          await this.purchaseRepo.insertPayment({
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

    const purchase = await this.purchaseRepo.getById(payment.purchase_id);
    if (!purchase) throw new NotFoundError('Purchase', payment.purchase_id);

    return await this.base.inTransaction(async () => {
      const today = new Date().toISOString().slice(0, 10);

      // 1. Create expense
      const expCatId = await this._getOrCreateSupplierPaymentCategory();
      const shift = await this.shiftRepo.findOpenByUser(userId);

      const expenseResult = await this.expenseRepo.create(
        {
          category_id: expCatId,
          amount: payment.amount,
          description: `Supplier payment for ${purchase.purchase_number}`,
          expense_date: today,
          payment_method: paymentMethod,
        },
        userId,
        shift?.id ?? null,
      );
      const expenseId = expenseResult.lastInsertRowid as number;

      // 2. Mark payment as paid
      await this.purchaseRepo.markPaymentPaid(
        paymentId, today, paymentMethod, expenseId, userId,
        referenceNumber?.trim() ?? null
      );

      // 3. Recalculate totals
      const totalPaid = await this.purchaseRepo.getPaidTotal(purchase.id);
      const newStatus = totalPaid >= purchase.total_amount
        ? 'paid' as const
        : totalPaid > 0
          ? 'partial' as const
          : 'unpaid' as const;

      await this.purchaseRepo.updateTotals(purchase.id, totalPaid, newStatus);

      // 4. Emit event
      this.bus.emit('entity:mutated', {
        action: 'MARK_PAYMENT_PAID', table: 'purchase_payments',
        recordId: paymentId, userId,
        newValues: {
          purchase_id: purchase.id,
          amount: payment.amount,
          payment_method: paymentMethod,
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
