import type { TransactionRepository } from '../repositories/sql/transaction.repository';
import type { BatchRepository }       from '../repositories/sql/batch.repository';
import type { ShiftRepository }       from '../repositories/sql/shift.repository';
import type { ProductRepository }     from '../repositories/sql/product.repository';
import type { BaseRepository }        from '../repositories/sql/base.repository';
import type { SettingsRepository }    from '../repositories/sql/settings.repository';
import type { EventBus }              from '../events/event-bus';
import type {
  Transaction, TransactionFilters, PaginatedResult,
  CreateTransactionInput, CreateTransactionItemInput,
  CreateReturnInput,
  PaymentMethod, UnitType, BatchStatus,
} from '../types/models';
import type { IFIFOBatch } from '../types/repositories';
import { Validate }        from '../common/validation';
import { Money }           from '../common/money';
import { NotFoundError, ValidationError, ConflictError } from '../types/errors';

interface DeductedLine {
  batchId:      number;
  productId:    number;
  quantityBase: number;
  unitType:     UnitType;
  unitPrice:    number;
  costPrice:    number;
  discountPct:  number;
  lineTotal:    number;
  grossProfit:  number;
  cfSnapshot:   number;
}

export class TransactionService {
  constructor(
    private readonly repo:        TransactionRepository,
    private readonly batchRepo:   BatchRepository,
    private readonly shiftRepo:   ShiftRepository,
    private readonly productRepo: ProductRepository,
    private readonly base:        BaseRepository,
    private readonly bus:         EventBus,
    private readonly settingsRepo?: SettingsRepository
  ) {}

  private async _shiftsEnabled(): Promise<boolean> {
    if (!this.settingsRepo) return true;
    return (await this.settingsRepo.get('shifts_enabled')) !== 'false';
  }

  async getAll(filters: TransactionFilters): Promise<PaginatedResult<Transaction>> {
    return await this.repo.getAll(filters);
  }

  async getById(id: number): Promise<Transaction> {
    Validate.id(id);
    const txn = await this.repo.getById(id);
    if (!txn) throw new NotFoundError('Transaction', id);
    return txn;
  }

  async createSale(data: CreateTransactionInput, userId: number, userRole?: string): Promise<Transaction> {
    Validate.id(userId, 'User');
    if (!data.items || data.items.length === 0) {
      throw new ValidationError('Sale must contain at least one item', 'items');
    }

    const shiftsOn = await this._shiftsEnabled();
    let shiftId: number | null = null;
    if (shiftsOn && userRole !== 'admin') {
      const shift = await this.shiftRepo.findOpenByUser(userId);
      if (!shift) {
        throw new ValidationError('No open shift. Please open a shift before making a sale.', 'shift');
      }
      shiftId = shift.id;
    } else if (shiftsOn && userRole === 'admin') {
      // Admin can sell without a shift; attach shift if one is open
      const shift = await this.shiftRepo.findOpenByUser(userId);
      if (shift) shiftId = shift.id;
    }

    await this._validatePayment(data);

    return await this.base.inTransaction(async () => {
      const lines = await this._deductFIFO(data.items, userId);
      return await this._commitTransaction(data, lines, userId, shiftId, null);
    });
  }

  async createReturn(data: CreateReturnInput, userId: number, userRole?: string): Promise<Transaction> {
    Validate.id(userId, 'User');
    Validate.id(data.original_transaction_id, 'Original transaction');
    if (!data.items || data.items.length === 0) {
      throw new ValidationError('Return must contain at least one item', 'items');
    }

    // ── 1. Validate original transaction ─────────────────────────────────────
    const original = await this.repo.getById(data.original_transaction_id);
    if (!original) throw new NotFoundError('Transaction', data.original_transaction_id);
    if (original.transaction_type !== 'sale') {
      throw new ValidationError('Can only return a sale transaction', 'transaction_type');
    }
    if (original.is_voided) {
      throw new ValidationError('Cannot return a cancelled transaction', 'voided');
    }
    if (!original.items || original.items.length === 0) {
      throw new ValidationError('Transaction has no items to return', 'items');
    }

    // ── 1b. Ownership check — users can only return their own transactions ──
    if (userRole !== 'admin' && original.user_id !== userId) {
      throw new ValidationError(
        'You can only return your own transactions', 'user_id'
      );
    }

    // ── 2. Authorization window checks ───────────────────────────────────────
    const shiftsOn = await this._shiftsEnabled();
    if (shiftsOn && userRole !== 'admin') {
      // 2-shift window — transaction must be from user's last 2 shifts
      const recentShiftIds = await this.shiftRepo.getLastNShiftIds(userId, 2);
      if (original.shift_id && !recentShiftIds.includes(original.shift_id)) {
        throw new ValidationError(
          'This transaction is too old to return. Returns are only allowed within your last 2 shifts.',
          'shift'
        );
      }
    } else if (!shiftsOn) {
      // Shifts disabled: use 7-day date window instead
      if (original.created_at) {
        const txnDate = new Date(original.created_at).getTime();
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (txnDate < sevenDaysAgo) {
          throw new ValidationError(
            'This transaction is too old to return. Returns are only allowed within 7 days.',
            'date'
          );
        }
      }
    }

    // Return is attributed to the original sale's shift and date
    const shiftId = original.shift_id;

    // ── 3. Load already-returned quantities ──────────────────────────────────
    const returnedMap = await this.repo.getReturnedQuantities(data.original_transaction_id);

    return await this.base.inTransaction(async () => {
      const lines: DeductedLine[] = [];
      // Tracks old_batch_id → new_batch_id for batches restored during this return
      const restoredBatchMap = new Map<number, number>();

      for (const item of data.items) {
        Validate.id(item.batch_id, 'Batch');
        Validate.positiveInteger(item.quantity, 'Return quantity');

        // Find matching item in original transaction.
        // First try exact match (batch + unit_type); if not found and return is child,
        // try the parent item from the same batch — this enables cross-unit returns
        // (e.g. customer bought a box, wants to return individual strips).
        let origItem = original.items?.find(
          i => i.batch_id === item.batch_id && i.unit_type === item.unit_type
        );
        const isCrossUnit = !origItem && item.unit_type === 'child'
          ? (() => {
              origItem = original.items?.find(
                i => i.batch_id === item.batch_id && i.unit_type === 'parent'
              );
              return !!origItem;
            })()
          : false;
        if (!origItem) {
          throw new ValidationError(
            `Item not found in original transaction (batch ${item.batch_id})`,
            'items'
          );
        }

        const cf = origItem.conversion_factor_snapshot ?? 1;
        const quantityBase = item.unit_type === 'parent'
          ? item.quantity * cf
          : item.quantity;

        // ── 4. Enforce return quantity limit ──────────────────────────────────
        // Key is batch_id only so cross-unit returns share the same base-unit pool.
        const key          = `${item.batch_id}`;
        const alreadyBase  = returnedMap[key] ?? 0;
        const remainingBase = origItem.quantity_base - alreadyBase;

        if (quantityBase > remainingBase) {
          throw new ValidationError(
            `Cannot return more than remaining quantity for batch ${item.batch_id}`,
            'quantity'
          );
        }

        // ── 5. Restore stock to batch ────────────────────────────────────────
        let effectiveBatchId = item.batch_id;
        const batch = await this.batchRepo.getById(item.batch_id);

        if (!batch) {
          // Batch was hard-deleted. Reconstruct a quarantine batch from sale data
          // stored in transaction_items (cost_price, unit_price, unit_type, cf_snapshot).
          if (restoredBatchMap.has(item.batch_id)) {
            // Same deleted batch appears again (e.g. parent + child items) — add qty
            effectiveBatchId = restoredBatchMap.get(item.batch_id)!;
            const restoredBatch = await this.batchRepo.getById(effectiveBatchId);
            if (restoredBatch) {
              const ok = await this.batchRepo.updateQuantityOptimistic(
                effectiveBatchId,
                restoredBatch.quantity_base + quantityBase,
                'quarantine',
                restoredBatch.version
              );
              if (!ok) throw new ConflictError('Batch modified concurrently during return. Please retry.');
            }
          } else {
            // First time seeing this deleted batch — reconstruct it
            let costPerParent: number;
            let costPerChild: number;
            let sellPerParent: number;
            let sellPerChild: number;

            if (origItem.unit_type === 'parent') {
              costPerParent = origItem.cost_price;
              costPerChild  = Math.floor(origItem.cost_price / cf);
              sellPerParent = origItem.unit_price;
              sellPerChild  = Math.floor(origItem.unit_price / cf);
            } else {
              costPerChild  = origItem.cost_price;
              costPerParent = origItem.cost_price * cf;
              sellPerChild  = origItem.unit_price;
              sellPerParent = origItem.unit_price * cf;
            }

            const newBatchId = await this.batchRepo.restoreDeletedBatch({
              product_id:           origItem.product_id,
              batch_number:         `RESTORED-${item.batch_id}-REVIEW`,
              expiry_date:          '2099-12-31', // Unknown — original batch deleted; quarantine requires manual review
              quantity_base:        quantityBase,
              cost_per_parent:      costPerParent,
              cost_per_child:       costPerChild,
              selling_price_parent: sellPerParent,
              selling_price_child:  sellPerChild,
            });

            restoredBatchMap.set(item.batch_id, newBatchId);
            effectiveBatchId = newBatchId;

            this.bus.emit('entity:mutated', {
              action: 'RESTORE_BATCH', table: 'batches',
              recordId: newBatchId, userId,
              newValues: {
                batch_number: `RESTORED-${item.batch_id}-REVIEW`,
                status: 'quarantine',
                quantity_base: quantityBase,
              },
            });
            this.bus.emit('stock:changed', {
              batchId:          newBatchId,
              productId:        origItem.product_id,
              previousQuantity: 0,
              newQuantity:      quantityBase,
              changeReason:     'return',
              userId,
            });
          }
        } else {
          // Batch exists — normal stock restore
          const newQty = batch.quantity_base + quantityBase;

          // Determine batch status after restock:
          //   - Quarantined batches stay quarantined
          //   - Expired batches go to quarantine (don't put expired stock back as active)
          //   - Otherwise active
          let newStatus: BatchStatus;
          if (batch.status === 'quarantine') {
            newStatus = 'quarantine';
          } else if (this._isBatchExpired(batch.expiry_date)) {
            newStatus = 'quarantine';
          } else {
            newStatus = 'active';
          }

          const ok = await this.batchRepo.updateQuantityOptimistic(
            item.batch_id, newQty, newStatus, batch.version
          );
          if (!ok) throw new ConflictError('Batch modified concurrently during return. Please retry.');

          this.bus.emit('stock:changed', {
            batchId:          item.batch_id,
            productId:        origItem.product_id,
            previousQuantity: batch.quantity_base,
            newQuantity:      newQty,
            changeReason:     'return',
            userId,
          });
        }

        // ── 6. Calculate refund using ORIGINAL SALE PRICES with discount ─────
        // For cross-unit returns (sold box → returning strips) derive per-strip price
        // using floor division so we never refund more than was collected.
        const unitPrice = (isCrossUnit && cf > 1)
          ? Math.floor(origItem.unit_price / cf)
          : origItem.unit_price;
        const costPrice = (isCrossUnit && cf > 1)
          ? Math.floor(origItem.cost_price / cf)
          : origItem.cost_price;

        const discountPct    = origItem.discount_percent ?? 0;
        const effectivePrice = Money.percent(unitPrice, 100 - discountPct);
        const lineTotal      = Money.multiply(effectivePrice, item.quantity);
        const costTotal      = Money.multiply(costPrice, item.quantity);
        const grossProfit    = -Money.subtract(lineTotal, costTotal);

        lines.push({
          batchId:      effectiveBatchId,
          productId:    origItem.product_id,
          quantityBase,
          unitType:     item.unit_type,
          unitPrice,
          costPrice,
          discountPct,
          lineTotal,
          grossProfit,
          cfSnapshot:   cf,
        });
      }

      // ── 7. Calculate return totals with proportional checkout discount ──────
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);

      // If the original sale had a checkout-level discount, apply proportionally
      const origSubtotal = original.subtotal ?? 0;
      const origDiscount = original.discount_amount ?? 0;
      const proportionalDiscount = origSubtotal > 0
        ? Math.round(subtotal * origDiscount / origSubtotal)
        : 0;
      const totalAmount = subtotal - proportionalDiscount;

      // ── 8. Match original payment method for refund ────────────────────────
      // Returns refund via the same channel the customer paid with
      const paymentMethod = (original.payment_method ?? 'cash') as PaymentMethod;
      let cashTendered = 0;
      let bankName: string | null = null;
      let paymentBreakdown: string | undefined;

      if (paymentMethod === 'cash') {
        cashTendered = totalAmount;
      } else if (paymentMethod === 'bank_transfer') {
        cashTendered = 0;
        bankName = original.bank_name ?? null;
      } else if (paymentMethod === 'mixed') {
        // Proportional split based on original cash/bank ratio
        const origTotal = original.total_amount ?? 0;
        const origCash  = original.cash_tendered ?? 0;
        const cashRatio = origTotal > 0 ? origCash / origTotal : 1;
        cashTendered    = Math.floor(totalAmount * cashRatio);
        const bankPortion = totalAmount - cashTendered;
        bankName = original.bank_name ?? null;
        paymentBreakdown = JSON.stringify({ cash: cashTendered, bank: bankPortion });
      }

      const txnData: CreateTransactionInput = {
        transaction_type: 'return',
        subtotal,
        discount_amount: proportionalDiscount,
        tax_amount:      0,
        total_amount:    totalAmount,
        payment_method:  paymentMethod,
        bank_name:       bankName ?? undefined,
        cash_tendered:   cashTendered,
        payment:         paymentBreakdown,
        notes:           data.notes ?? undefined,
        items:           [],
      };

      return await this._commitTransaction(
        txnData, lines, userId, shiftId,
        data.original_transaction_id,
        original.created_at
      );
    });
  }

  async getReturnedQuantities(originalTxnId: number): Promise<Record<string, number>> {
    Validate.id(originalTxnId, 'Original transaction');
    return await this.repo.getReturnedQuantities(originalTxnId);
  }

  async voidTransaction(id: number, reason: string, voidedBy: number, force?: boolean): Promise<Transaction> {
    Validate.id(id);
    Validate.id(voidedBy, 'User');
    const r = Validate.requiredString(reason, 'Void reason', 500);

    const txn = await this.repo.getById(id);
    if (!txn) throw new NotFoundError('Transaction', id);
    if (txn.is_voided) throw new ValidationError('Transaction is already voided', 'voided');

    return await this.base.inTransaction(async () => {
      // For sale voids: load already-returned quantities so we don't double-restore
      let returnedMap: Record<string, number> = {};
      if (txn.transaction_type === 'sale') {
        returnedMap = await this.repo.getReturnedQuantities(id);
      }

      // Restore/re-deduct stock for each item
      for (const item of (txn.items ?? [])) {
        const batch = await this.batchRepo.getById(item.batch_id);
        if (!batch) {
          // Batch was deleted — stock cannot be adjusted. Emit audit event.
          this.bus.emit('entity:mutated', {
            action: 'VOID_STOCK_SKIP', table: 'batches',
            recordId: item.batch_id, userId: voidedBy,
            newValues: { reason: 'Batch deleted — stock not adjusted', product_id: item.product_id },
          });
          continue;
        }

        let newQty: number;
        let newStatus: BatchStatus;

        if (txn.transaction_type === 'sale') {
          // Sale void: restore stock, minus any already-returned quantities
          const alreadyReturned = returnedMap[`${item.batch_id}`] ?? 0;
          const restoreQty = item.quantity_base - alreadyReturned;
          if (restoreQty <= 0) continue; // Fully returned — nothing to restore
          newQty    = batch.quantity_base + restoreQty;
          newStatus = batch.status === 'sold_out' ? 'active' : batch.status;
        } else if (txn.transaction_type === 'return') {
          // Return void: re-deduct the returned stock
          if (batch.quantity_base < item.quantity_base) {
            if (!force) {
              throw new ValidationError(
                `Cannot void return — insufficient stock in batch ${item.batch_id}`,
                'quantity'
              );
            }
            // Force: clamp to 0 instead of failing
            newQty = 0;
          } else {
            newQty = batch.quantity_base - item.quantity_base;
          }
          newStatus = newQty === 0 ? 'sold_out' : batch.status;
        } else {
          continue;
        }

        const success = await this.batchRepo.updateQuantityOptimistic(
          item.batch_id, newQty, newStatus, batch.version
        );
        if (!success) throw new ConflictError('Batch modified concurrently during void. Please retry.');

        this.bus.emit('stock:changed', {
          batchId:          item.batch_id,
          productId:        batch.product_id!,
          previousQuantity: batch.quantity_base,
          newQuantity:      newQty,
          changeReason:     'void',
          userId:           voidedBy,
        });
      }

      await this.repo.markVoided(id, r, voidedBy);

      this.bus.emit('entity:mutated', {
        action: 'VOID_TRANSACTION', table: 'transactions',
        recordId: id, userId: voidedBy,
        newValues: { void_reason: r },
      });

      return (await this.repo.getById(id))!;
    });
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private async _validatePayment(data: CreateTransactionInput): Promise<void> {
    const { payment_method, cash_tendered, total_amount } = data;

    if (!['cash', 'bank_transfer', 'mixed'].includes(payment_method)) {
      throw new ValidationError(`Invalid payment method: ${payment_method}`, 'payment_method');
    }

    if (payment_method === 'cash') {
      const tendered = cash_tendered ?? 0;
      if (tendered < total_amount) {
        throw new ValidationError(
          'Cash tendered must be ≥ total amount', 'cash_tendered'
        );
      }
    }

    if (payment_method === 'bank_transfer' && !data.bank_name && !data.reference_number) {
      // Soft warn only — some transfers may not have a ref yet
    }

    if (payment_method === 'mixed') {
      if (!data.payment) {
        throw new ValidationError('Mixed payment requires a payment breakdown', 'payment');
      }
      try {
        const parsed = typeof data.payment === 'string' ? JSON.parse(data.payment) : data.payment;
        const cashPart = parsed.cash ?? 0;
        const bankPart = parsed.bank ?? 0;
        if (!Number.isInteger(cashPart) || !Number.isInteger(bankPart)) {
          throw new ValidationError('Payment amounts must be whole numbers', 'payment');
        }
        if (cashPart + bankPart !== total_amount) {
          throw new ValidationError('Mixed payment parts must equal total amount exactly', 'payment');
        }
      } catch (e) {
        if (e instanceof ValidationError) throw e;
        throw new ValidationError('Invalid payment breakdown JSON', 'payment');
      }
    }
  }

  /**
   * FIFO stock deduction.
   * Iterates batches sorted by expiry (oldest first) and deducts until
   * the requested quantity is satisfied.
   */
  private async _deductFIFO(
    items: CreateTransactionItemInput[],
    userId: number
  ): Promise<DeductedLine[]> {
    const lines: DeductedLine[] = [];

    for (const item of items) {
      Validate.id(item.product_id, 'Product');
      Validate.positiveInteger(item.quantity, 'Quantity');

      const product = await this.productRepo.getById(item.product_id);
      if (!product) throw new NotFoundError('Product', item.product_id);

      const cf = product.conversion_factor ?? 1;
      let remainingBase = item.unit_type === 'parent'
        ? item.quantity * cf
        : item.quantity;

      // If caller specified a batch, use only that one; otherwise FIFO all batches
      const batches: IFIFOBatch[] = item.batch_id
        ? await (async () => {
            const b = await this.batchRepo.getById(item.batch_id!) as unknown as IFIFOBatch | undefined;
            if (b && b.status !== 'active') {
              throw new ValidationError(`Batch ${item.batch_id} is not available for sale (status: ${b.status})`, 'batch_id');
            }
            return b ? [b] : [];
          })()
        : await this.batchRepo.getAvailableByProduct(item.product_id);

      if (batches.length === 0) {
        // Check if stock exists but is expired/quarantined to give a better error message
        const allBatches = await this.batchRepo.getByProduct(item.product_id);
        const hasExpired = allBatches.some(b => b.status === 'active' && b.quantity_base > 0 && b.expiry_date <= new Date().toISOString().split('T')[0]);
        const hasQuarantined = allBatches.some(b => b.status === 'quarantine' && b.quantity_base > 0);
        const reason = hasExpired ? ' (all batches are expired)'
          : hasQuarantined ? ' (stock is quarantined)'
          : '';
        throw new ValidationError(
          `No available stock for product "${product.name}"${reason}`, 'stock'
        );
      }

      for (const batch of batches) {
        if (remainingBase <= 0) break;

        const take = Math.min(batch.quantity_base, remainingBase);
        const newQty = batch.quantity_base - take;
        const newStatus = newQty === 0 ? 'sold_out' : 'active';

        const success = await this.batchRepo.updateQuantityOptimistic(
          batch.id, newQty, newStatus, batch.version
        );
        if (!success) throw new ConflictError('Batch modified concurrently. Please retry.');

        // Determine unit price and cost from override columns
        const unitPrice =
          item.unit_type === 'parent'
            ? (batch.selling_price_parent_override || batch.selling_price_parent || 0)
            : (batch.selling_price_child_override  || batch.selling_price_child  || 0);

        const costPrice =
          item.unit_type === 'parent'
            ? batch.cost_per_parent
            : (batch.cost_per_child_override || batch.cost_per_child || 0);

        const discountPct = item.discount_percent ?? 0;
        const displayQty  = item.unit_type === 'parent' ? take / cf : take;

        const effectivePrice = Money.percent(unitPrice, 100 - discountPct);
        const lineTotal      = Money.multiply(effectivePrice, displayQty);
        const costTotal      = Money.multiply(costPrice, displayQty);
        const grossProfit    = Money.subtract(lineTotal, costTotal);

        lines.push({
          batchId:      batch.id,
          productId:    item.product_id,
          quantityBase: take,
          unitType:     item.unit_type,
          unitPrice:    item.unit_price ?? unitPrice,
          costPrice,
          discountPct,
          lineTotal,
          grossProfit,
          cfSnapshot:   cf,
        });

        remainingBase -= take;
      }

      if (remainingBase > 0) {
        throw new ValidationError(
          `Insufficient stock for product "${product.name}"`, 'stock'
        );
      }
    }

    return lines;
  }

  private async _commitTransaction(
    data:           CreateTransactionInput,
    lines:          DeductedLine[],
    userId:         number,
    shiftId:        number | null,
    parentTxnId:    number | null,
    createdAt?:     string | null
  ): Promise<Transaction> {
    const txnNumber  = await this.repo.getNextNumber(
      data.transaction_type === 'sale' ? 'TXN' : 'RTN'
    );
    const subtotal   = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount   = Math.round(data.discount_amount ?? 0);
    const tax        = Math.round(data.tax_amount ?? 0);

    if (subtotal <= 0 && data.transaction_type === 'sale') {
      throw new ValidationError('Subtotal must be positive', 'subtotal');
    }
    if (discount < 0) {
      throw new ValidationError('Discount cannot be negative', 'discount_amount');
    }
    if (tax < 0) {
      throw new ValidationError('Tax cannot be negative', 'tax_amount');
    }

    const total      = subtotal - discount + tax;

    const cashTendered =
      data.payment_method === 'cash'  ? (data.cash_tendered ?? total)
      : data.payment_method === 'mixed' ? (data.cash_tendered ?? 0)
      : 0;

    // Serialize payment breakdown to JSON string for storage (IPC delivers it as an object)
    const paymentJson: string | null = data.payment == null
      ? null
      : typeof data.payment === 'string' ? data.payment : JSON.stringify(data.payment);

    const txnId = await this.repo.insert({
      transaction_number:    txnNumber,
      user_id:               userId,
      shift_id:              shiftId,
      transaction_type:      data.transaction_type,
      subtotal,
      discount_amount:       discount,
      tax_amount:            tax,
      total_amount:          total,
      payment_method:        data.payment_method as PaymentMethod,
      bank_name:             data.bank_name ?? null,
      reference_number:      data.reference_number ?? null,
      cash_tendered:         cashTendered,
      payment:               paymentJson,
      customer_name:         data.customer_name ?? null,
      customer_phone:        data.customer_phone ?? null,
      notes:                 data.notes ?? null,
      parent_transaction_id: parentTxnId,
      created_at: createdAt ?? null,
    });

    for (const line of lines) {
      await this.repo.insertItem({
        transaction_id:             txnId,
        product_id:                 line.productId,
        batch_id:                   line.batchId,
        quantity_base:              line.quantityBase,
        unit_type:                  line.unitType,
        unit_price:                 line.unitPrice,
        cost_price:                 line.costPrice,
        discount_percent:           line.discountPct,
        line_total:                 line.lineTotal,
        gross_profit:               line.grossProfit,
        conversion_factor_snapshot: line.cfSnapshot,
      });
    }

    this.bus.emit('transaction:created', {
      transactionId:   txnId,
      transactionType: (data.transaction_type === 'void' ? 'sale' : data.transaction_type) as 'sale' | 'return',
      userId,
      shiftId,
      totalAmount:     total,
      itemCount:       lines.length,
    });
    this.bus.emit('entity:mutated', {
      action: data.transaction_type === 'sale' ? 'CREATE_SALE' : 'CREATE_RETURN',
      table:  'transactions',
      recordId: txnId, userId,
      newValues: {
        transaction_number: txnNumber,
        total_amount:       total,
        payment_method:     data.payment_method,
      },
    });

    return (await this.repo.getById(txnId))!;
  }

  /** Check if a batch has passed its expiry date. */
  private _isBatchExpired(expiryDate: string | null | undefined): boolean {
    if (!expiryDate) return false;
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    return expiryDate <= today;
  }
}
