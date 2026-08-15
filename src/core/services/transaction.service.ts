import type { TransactionRepository } from '../repositories/sql/transaction.repository';
import type { BatchRepository }       from '../repositories/sql/batch.repository';
import type { ShiftRepository }       from '../repositories/sql/shift.repository';
import type { ProductRepository }     from '../repositories/sql/product.repository';
import type { BaseRepository }        from '../repositories/sql/base.repository';
import { AuditRepository }            from '../repositories/sql/audit.repository';
import type { SettingsRepository }    from '../repositories/sql/settings.repository';
import type { EventBus }              from '../events/event-bus';
import type {
  Transaction, TransactionFilters, PaginatedResult,
  CreateTransactionInput, CreateTransactionItemInput,
  CreateReturnInput,
  PaymentMethod, UnitType, BatchStatus, AdjustmentType,
  ProductSaleRecord, ProductSaleFilters,
} from '../types/models';
import type { IFIFOBatch } from '../types/repositories';
import { Validate }        from '../common/validation';
import { Money }           from '../common/money';
import { todayLocalISO }   from '../common/expiry';
import { NotFoundError, ValidationError, ConflictError, BusinessRuleError } from '../types/errors';

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
  checkoutDiscountAllocation?: number;
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
    private readonly settingsRepo?: SettingsRepository,
    private readonly auditRepo?:  AuditRepository
  ) {}

  private async _shiftsEnabled(): Promise<boolean> {
    if (!this.settingsRepo) return true;
    return (await this.settingsRepo.get('shifts_enabled')) !== 'false';
  }

  /** Numeric setting with a fallback default — used for the configurable
   *  return/void time windows below. */
  private async _numericSetting(key: string, fallback: number): Promise<number> {
    if (!this.settingsRepo) return fallback;
    const raw = await this.settingsRepo.get(key);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
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

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.base.inTransaction(async () => {
          const lines = await this._deductFIFO(data.items, userId);
          return await this._commitTransaction(data, lines, userId, shiftId, null);
        });
      } catch (err) {
        if (err instanceof ConflictError && attempt < MAX_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new ConflictError('Sale could not be committed after 3 retries. Please try again.');
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

    // ── 2. Authorization window checks (configurable via settings) ──────────
    const shiftsOn = await this._shiftsEnabled();
    if (shiftsOn && userRole !== 'admin') {
      // N-shift window — transaction must be from one of the user's last N shifts
      const returnWindowShifts = await this._numericSetting('return_window_shifts', 2);
      const recentShiftIds = await this.shiftRepo.getLastNShiftIds(userId, returnWindowShifts);
      if (original.shift_id && !recentShiftIds.includes(original.shift_id)) {
        throw new ValidationError(
          `This transaction is too old to return. Returns are only allowed within your last ${returnWindowShifts} shift(s).`,
          'shift'
        );
      }
    } else {
      // Admin (with shifts on), or anyone (with shifts off): use the N-day date window instead
      if (original.created_at) {
        const returnWindowDays = await this._numericSetting('return_window_days', 7);
        const txnDate = new Date(original.created_at).getTime();
        const windowStart = Date.now() - returnWindowDays * 24 * 60 * 60 * 1000;
        if (txnDate < windowStart) {
          throw new ValidationError(
            `This transaction is too old to return. Returns are only allowed within ${returnWindowDays} day(s).`,
            'date'
          );
        }
      }
    }

    // A2 fix (2026-08-15 cutover — historical rows predating this are left
    // as-is, see issues.md): a return used to inherit the ORIGINAL sale's
    // shift_id and created_at. That mutated already-closed shift
    // reconciliation retroactively (expected_cash for a closed shift no
    // longer matched what was actually recorded when it closed), and
    // deducted today's refund from a shift that isn't open today — so the
    // cashier's drawer closed short by exactly the refund amount with
    // nothing on screen explaining why. A return is its own cash event: it
    // belongs to the shift and date it actually happened in.
    // parent_transaction_id still links it to the original sale for
    // "returns against period X" cohort reporting.
    let shiftId: number | null = null;
    if (shiftsOn && userRole !== 'admin') {
      const shift = await this.shiftRepo.findOpenByUser(userId);
      if (!shift) {
        throw new ValidationError('No open shift. Please open a shift before processing a return.', 'shift');
      }
      shiftId = shift.id;
    } else if (shiftsOn && userRole === 'admin') {
      const shift = await this.shiftRepo.findOpenByUser(userId);
      if (shift) shiftId = shift.id;
    }

    // ── 3. Load already-returned quantities ──────────────────────────────────
    const returnedMap = await this.repo.getReturnedQuantities(data.original_transaction_id);

    return await this.base.inTransaction(async () => {
      const lines: DeductedLine[] = [];
      // Tracks old_batch_id → new_batch_id for batches restored during this return
      const restoredBatchMap = new Map<number, number>();
      // Track quantities consumed within THIS return request (prevents over-return
      // when multiple items in the same request reference the same batch)
      const inRequestConsumed: Record<string, number> = {};

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
        // C1 fix: a sale can legitimately contain two lines against the same
        // batch (e.g. "1 box" + "3 strips" both FIFO-resolve to the same
        // batch). returnedMap aggregates returns per batch, so the sold side
        // must be aggregated the same way — measuring against origItem alone
        // (a single matched line) under-reports what's actually returnable
        // whenever a second line on the same batch exists.
        const key          = `${item.batch_id}`;
        const soldBaseForBatch = original.items!
          .filter(i => i.batch_id === item.batch_id)
          .reduce((sum, i) => sum + i.quantity_base, 0);
        const alreadyBase  = (returnedMap[key] ?? 0) + (inRequestConsumed[key] ?? 0);
        const remainingBase = soldBaseForBatch - alreadyBase;

        if (quantityBase > remainingBase) {
          throw new ValidationError(
            `Cannot return more than remaining quantity for batch ${item.batch_id}`,
            'quantity'
          );
        }

        // Record this item's consumption for subsequent items in the same request
        inRequestConsumed[key] = (inRequestConsumed[key] ?? 0) + quantityBase;

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

            const auditRepo = this.auditRepo ?? new AuditRepository(this.base);
            const originalExpiry = await auditRepo.getDeletedBatchExpiry(item.batch_id);

            // C5 fix: 2099-12-31 reads as a live, sellable medicine on every
            // report and in the POS grid — if a pharmacist releases this
            // batch from quarantine without noticing the RESTORED- prefix,
            // stock of unknown age re-enters circulation with a 73-year
            // expiry and every expiry report stays clean. Falling back to
            // "today" instead means it reads as EXPIRED everywhere (POS,
            // dashboard, expiry reports) until someone verifies the real
            // date physically and corrects it — unmistakably wrong is safer
            // here than unmistakably fine.
            const newBatchId = await this.batchRepo.restoreDeletedBatch({
              product_id:           origItem.product_id,
              batch_number:         `RESTORED-${item.batch_id}-REVIEW`,
              expiry_date:          originalExpiry ?? todayLocalISO(),
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
          ? Money.divideToChild(origItem.unit_price, cf)
          : origItem.unit_price;
        const costPrice = (isCrossUnit && cf > 1)
          ? Money.divideToChild(origItem.cost_price, cf)
          : origItem.cost_price;

        const discountPct    = origItem.discount_percent ?? 0;
        const effectivePrice = Money.percent(unitPrice, 100 - discountPct);
        const lineTotal      = Money.multiply(effectivePrice, item.quantity);
        const costTotal      = Money.multiply(costPrice, item.quantity);
        
        const revenueChange  = -lineTotal;
        const costChange     = -costTotal;
        const grossProfit    = Money.subtract(revenueChange, costChange);

        const returnedProportion = origItem.quantity_base > 0 ? quantityBase / origItem.quantity_base : 0;
        const lineRefundDiscount = Math.round((origItem.checkout_discount_allocation ?? 0) * returnedProportion);

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
          checkoutDiscountAllocation: lineRefundDiscount,
          cfSnapshot:   cf,
        });
      }

      // ── 7. Calculate return totals with exact per-line checkout discount allocation ──────
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);

      const proportionalDiscount = lines.reduce((s, l) => s + (l.checkoutDiscountAllocation ?? 0), 0);
      const totalAmount = Math.max(0, subtotal - proportionalDiscount);

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
        cashTendered    = Math.round(totalAmount * cashRatio);
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

      // No createdAt override — the return gets its own current timestamp
      // (A2), not the original sale's.
      return await this._commitTransaction(
        txnData, lines, userId, shiftId,
        data.original_transaction_id
      );
    });
  }

  async getReturnedQuantities(originalTxnId: number): Promise<Record<string, number>> {
    Validate.id(originalTxnId, 'Original transaction');
    return await this.repo.getReturnedQuantities(originalTxnId);
  }

  async getSalesByProduct(filters: ProductSaleFilters): Promise<PaginatedResult<ProductSaleRecord>> {
    if (filters.product_ids) {
      for (const id of filters.product_ids) Validate.id(id, 'Product');
    }
    if (filters.user_id !== undefined) Validate.id(filters.user_id, 'User');
    return await this.repo.getSalesByProduct(filters);
  }

  async voidTransaction(id: number, reason: string, voidedBy: number, force?: boolean, voidedByRole?: string): Promise<Transaction> {
    Validate.id(id);
    Validate.id(voidedBy, 'User');
    const r = Validate.requiredString(reason, 'Void reason', 500);

    const txn = await this.repo.getById(id);
    if (!txn) throw new NotFoundError('Transaction', id);
    if (txn.is_voided) throw new ValidationError('Transaction is already voided', 'voided');

    // Void time window (configurable via settings, mirrors the return
    // window below) — previously there was NO time limit on voiding a
    // transaction at all. Non-admins are blocked outside the window; an
    // admin can still void an old transaction, but it's flagged on the
    // audit event rather than silently allowed (same reasoning as the
    // closed-shift override just below — an unrestricted admin bypass
    // with no trace is a standing fraud-review gap).
    let windowOverride = false;
    if (txn.created_at) {
      const voidWindowHours = await this._numericSetting('void_window_hours', 24);
      const txnAge = Date.now() - new Date(txn.created_at).getTime();
      if (txnAge > voidWindowHours * 60 * 60 * 1000) {
        if (voidedByRole !== 'admin') {
          throw new ValidationError(
            `This transaction is too old to void. Voids are only allowed within ${voidWindowHours} hour(s).`,
            'date'
          );
        }
        windowOverride = true;
      }
    }

    // C2: voidTransaction correctly avoids double-restoring stock for a
    // sale that had a partial return, but never touched the return itself.
    // The sale would then be excluded from revenue while its return stayed
    // live — a refund charged against a sale that officially never
    // happened, net_sales = 0 - return_total. txn.returns is already
    // populated with only non-voided returns (see repo.getById), so this
    // is free. Refusing (rather than cascading) keeps the void auditable:
    // the operator sees exactly what has to happen first.
    if (txn.transaction_type === 'sale' && txn.returns && txn.returns.length > 0) {
      const numbers = txn.returns.map(r => r.transaction_number).join(', ');
      throw new BusinessRuleError(
        `Cannot void this sale — it has ${txn.returns.length} active return(s) (${numbers}). Void those first.`
      );
    }

    // A4: a shift's expected_cash/variance are a frozen snapshot once closed
    // — voiding a transaction that fed that snapshot after the fact makes it
    // permanently unreproducible with no visible trace. Non-admins are
    // blocked outright; an admin can still override, recorded on the event.
    let closedShiftOverride = false;
    if (txn.shift_id) {
      const shift = await this.shiftRepo.getById(txn.shift_id);
      if (shift?.status === 'closed') {
        if (voidedByRole !== 'admin') {
          throw new BusinessRuleError(
            'Cannot void a transaction from a closed shift. Ask an admin to make this correction.'
          );
        }
        closedShiftOverride = true;
      }
    }

    return await this.base.inTransaction(async () => {
      // For sale voids: load already-returned quantities so we don't double-restore
      let returnedMap: Record<string, number> = {};
      if (txn.transaction_type === 'sale') {
        returnedMap = await this.repo.getReturnedQuantities(id);
      }

      // Track how much returned quantity has been consumed per batch across
      // multiple transaction_items. Without this, if 2 items reference the same
      // batch_id, each would subtract the full alreadyReturned, causing incorrect
      // stock restoration.
      const consumedReturned: Record<string, number> = {};

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
          const key = `${item.batch_id}`;
          const totalReturned = returnedMap[key] ?? 0;
          const alreadyConsumed = consumedReturned[key] ?? 0;
          const remainingReturned = Math.max(0, totalReturned - alreadyConsumed);
          const deductFromThis = Math.min(item.quantity_base, remainingReturned);
          consumedReturned[key] = alreadyConsumed + deductFromThis;

          const restoreQty = item.quantity_base - deductFromThis;
          if (restoreQty <= 0) continue; // Fully returned — nothing to restore
          newQty    = batch.quantity_base + restoreQty;
          // Don't restore expired batches to active — quarantine instead
          if (this._isBatchExpired(batch.expiry_date)) {
            newStatus = 'quarantine';
          } else if (batch.status === 'sold_out') {
            newStatus = 'active';
          } else {
            newStatus = batch.status;
          }
        } else if (txn.transaction_type === 'return') {
          // Return void: re-deduct the returned stock
          if (batch.quantity_base < item.quantity_base) {
            if (!force) {
              throw new ValidationError(
                `Cannot void return — insufficient stock in batch ${item.batch_id}`,
                'quantity'
              );
            }
            // Force: clamp to 0 and record the discrepancy as an inventory adjustment
            newQty = 0;
            const lostQty = item.quantity_base - batch.quantity_base;
            if (lostQty > 0) {
              await this.batchRepo.insertAdjustment({
                product_id:    batch.product_id!,
                batch_id:      item.batch_id,
                quantity_base: lostQty,
                reason:        `Force-void of return #${id}: ${lostQty} units could not be re-deducted`,
                type:          'correction' as AdjustmentType,
                user_id:       voidedBy,
              });
            }
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
        newValues: {
          void_reason: r,
          ...(closedShiftOverride ? { closedShiftOverride: true } : {}),
          ...(windowOverride ? { windowOverride: true } : {}),
        },
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

      // If caller specified a batch, use only that one; otherwise FIFO all batches.
      // A stale/malformed batch_id (cart line captured before the product was
      // switched, or any REST caller) must never be allowed to deduct stock
      // from a batch belonging to a different product, or sell expired stock
      // that the FIFO path would have excluded.
      const batches: IFIFOBatch[] = item.batch_id
        ? await (async () => {
            const b = await this.batchRepo.getById(item.batch_id!) as unknown as IFIFOBatch | undefined;
            if (!b) throw new NotFoundError('Batch', item.batch_id!);
            if (b.product_id !== item.product_id) {
              throw new ValidationError(
                `Batch ${item.batch_id} does not belong to product ${item.product_id}`, 'batch_id'
              );
            }
            if (b.status !== 'active') {
              throw new ValidationError(`Batch ${item.batch_id} is not available for sale (status: ${b.status})`, 'batch_id');
            }
            if (this._isBatchExpired(b.expiry_date)) {
              throw new ValidationError(`Batch ${item.batch_id} is expired`, 'batch_id');
            }
            return [b];
          })()
        : await this.batchRepo.getAvailableByProduct(item.product_id);

      if (batches.length === 0) {
        // Check if stock exists but is expired/quarantined to give a better error message
        const allBatches = await this.batchRepo.getByProduct(item.product_id);
        const hasExpired = allBatches.some(b => b.status === 'active' && b.quantity_base > 0 && b.expiry_date <= todayLocalISO());
        const hasQuarantined = allBatches.some(b => b.status === 'quarantine' && b.quantity_base > 0);
        const reason = hasExpired ? ' (all batches are expired)'
          : hasQuarantined ? ' (stock is quarantined)'
          : '';
        throw new ValidationError(
          `No available stock for product "${product.name}"${reason}`, 'stock'
        );
      }

      // First pass: deduct stock and pin down each fragment's price/cost.
      // Splitting the FIFO line into per-batch fragments doesn't change how
      // much is charged — the line total is computed from the combined
      // fragments below, not per fragment (C3).
      const discountPct = item.discount_percent ?? 0;
      const fragments: Array<{ batchId: number; take: number; unitPrice: number; costPrice: number }> = [];

      for (const batch of batches) {
        if (remainingBase <= 0) break;

        const take = Math.min(batch.quantity_base, remainingBase);
        const newQty = batch.quantity_base - take;
        const newStatus = newQty === 0 ? 'sold_out' : 'active';

        const success = await this.batchRepo.updateQuantityOptimistic(
          batch.id, newQty, newStatus, batch.version
        );
        if (!success) throw new ConflictError('Batch modified concurrently. Please retry.');

        // Determine unit price: use caller override if provided, else batch price
        const unitPrice =
          item.unit_price ??
          (item.unit_type === 'parent'
            ? (batch.selling_price_parent_override || batch.selling_price_parent || 0)
            : (batch.selling_price_child_override  || batch.selling_price_child  || 0));

        const costPrice =
          item.unit_type === 'parent'
            ? batch.cost_per_parent
            : (batch.cost_per_child_override || batch.cost_per_child || 0);

        fragments.push({ batchId: batch.id, take, unitPrice, costPrice });
        remainingBase -= take;
      }

      if (remainingBase > 0) {
        throw new ValidationError(
          `Insufficient stock for product "${product.name}"`, 'stock'
        );
      }

      // C3: for a parent-unit sale split across multiple batches at the SAME
      // price (the common case — either an explicit item.unit_price override,
      // which is identical for every fragment by construction, or batches
      // that just happen to share a selling price), each fragment used to be
      // rounded independently: round(price*take1/cf) + round(price*take2/cf)
      // can be 1 SDG more or less than round(price*(take1+take2)/cf) — the
      // customer is charged a different total than quantity × the price shown
      // at the till. Round the combined total once and distribute it across
      // fragments (last fragment absorbs the remainder), the same
      // last-item-gets-the-remainder pattern used for checkout_discount_allocation
      // below. Child-unit sales don't have this problem — Money.multiply is a
      // plain multiply, which distributes over addition with no rounding step.
      // A split across batches with genuinely different prices (no override,
      // and the batches disagree) has no single total to reconcile against,
      // so it keeps the old independent-per-fragment rounding.
      const allSamePrice = item.unit_type === 'parent' && fragments.length > 1
        && fragments.every(f => f.unitPrice === fragments[0].unitPrice);

      let sharedLineTotal = 0;
      if (allSamePrice) {
        const effectivePrice = Money.percent(fragments[0].unitPrice, 100 - discountPct);
        const totalTake = fragments.reduce((s, f) => s + f.take, 0);
        sharedLineTotal = Math.round((effectivePrice * totalTake) / cf);
      }

      let lineTotalRemaining = sharedLineTotal;
      fragments.forEach((f, idx) => {
        const effectivePrice = Money.percent(f.unitPrice, 100 - discountPct);
        let lineTotal: number;
        if (allSamePrice) {
          if (idx === fragments.length - 1) {
            lineTotal = lineTotalRemaining;
          } else {
            lineTotal = Math.round((effectivePrice * f.take) / cf);
            lineTotalRemaining -= lineTotal;
          }
        } else {
          lineTotal = item.unit_type === 'parent'
            ? Math.round((effectivePrice * f.take) / cf)
            : Money.multiply(effectivePrice, f.take);
        }

        const costTotal = item.unit_type === 'parent'
          ? Math.round((f.costPrice * f.take) / cf)
          : Money.multiply(f.costPrice, f.take);
        const grossProfit = Money.subtract(lineTotal, costTotal);

        lines.push({
          batchId:      f.batchId,
          productId:    item.product_id,
          quantityBase: f.take,
          unitType:     item.unit_type,
          unitPrice:    f.unitPrice,
          costPrice:    f.costPrice,
          discountPct,
          lineTotal,
          grossProfit,
          cfSnapshot:   cf,
        });
      });
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
    if (discount > subtotal) {
      throw new ValidationError('Discount cannot exceed subtotal', 'discount_amount');
    }
    if (tax < 0) {
      throw new ValidationError('Tax cannot be negative', 'tax_amount');
    }

    const total      = subtotal - discount + tax;

    // `data.cash_tendered` for a cash sale is the raw amount the cashier typed
    // as "amount received" — it is legitimately larger than `total` whenever
    // change is given. Keep that raw figure as `cash_received` (receipt
    // "change given" display only) and clamp the stored `cash_tendered` to
    // `total` so it always means cash actually retained in the drawer.
    // Storing the raw figure in `cash_tendered` inflated every shift's
    // expected cash by the change given and booked a matching negative "bank
    // portion", closing the drawer short by exactly that amount.
    const rawCashTendered =
      data.payment_method === 'cash'  ? (data.cash_tendered ?? total)
      : data.payment_method === 'mixed' ? (data.cash_tendered ?? 0)
      : 0;
    const cashReceived = data.payment_method === 'cash' ? rawCashTendered : null;
    const cashTendered = data.payment_method === 'cash'
      ? Math.min(rawCashTendered, total)
      : rawCashTendered;

    // Post-FIFO cash validation: ensure cash tendered covers the ACTUAL total
    // (pre-FIFO validation used the frontend estimate which may differ)
    if (data.transaction_type === 'sale' && data.payment_method === 'cash' && rawCashTendered < total) {
      throw new ValidationError(
        `Cash tendered (${rawCashTendered}) is less than the total (${total})`,
        'cash_tendered'
      );
    }

    // Post-FIFO mixed-payment validation (C4): _validatePayment already
    // checked cashPart + bankPart === total_amount, but against the
    // CLIENT-supplied total_amount, before FIFO ran. If the server total
    // differs (price changed between grid load and checkout, or the C3
    // multi-batch rounding case), a mixed payment could otherwise commit
    // with a breakdown that doesn't add up to the stored total — and
    // cash_tendered derived from it would be wrong, feeding straight back
    // into the A1 cash-shortage bug. Re-validate against the real computed
    // `total` and reject rather than silently mis-split; this throws inside
    // the same inTransaction() as the FIFO deduction above, so the stock
    // change rolls back with it.
    if (data.transaction_type === 'sale' && data.payment_method === 'mixed') {
      const parsed = typeof data.payment === 'string' ? JSON.parse(data.payment) : data.payment;
      const cashPart = parsed?.cash ?? 0;
      const bankPart = parsed?.bank ?? 0;
      if (cashPart + bankPart !== total) {
        throw new ValidationError(
          `The order total changed while checking out (was ${data.total_amount}, is now ${total}) — please review and retry.`,
          'payment'
        );
      }
    }

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
      cash_received:         cashReceived,
      payment:               paymentJson,
      customer_name:         data.customer_name ?? null,
      customer_phone:        data.customer_phone ?? null,
      notes:                 data.notes ?? null,
      parent_transaction_id: parentTxnId,
      created_at: createdAt ?? null,
    });

    let discountRemaining = discount;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let allocation = 0;
      if (line.checkoutDiscountAllocation !== undefined) {
        allocation = line.checkoutDiscountAllocation;
      } else if (subtotal > 0) {
        if (i === lines.length - 1) {
          allocation = discountRemaining;
        } else {
          allocation = Math.round((line.lineTotal / subtotal) * discount);
          discountRemaining -= allocation;
        }
      }

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
        checkout_discount_allocation: allocation,
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
    return expiryDate < todayLocalISO();
  }
}
