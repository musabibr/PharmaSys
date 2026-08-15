import type { BatchRepository }   from '../repositories/sql/batch.repository';
import type { ProductRepository } from '../repositories/sql/product.repository';
import type { EventBus }          from '../events/event-bus';
import type {
  Batch, CreateBatchInput, UpdateBatchInput,
  InventoryAdjustment, AdjustmentFilters, AdjustmentType, BatchFilters,
  LatestBatchPricing, BulkPriceUpdateOptions, BulkPriceUpdatePreviewRow, BulkPriceUpdateResult,
  ManualPriceUpdateItem,
} from '../types/models';
import { Validate }               from '../common/validation';
import { diffValues }             from '../common/audit-diff';
import { NotFoundError, ValidationError, ConflictError, BusinessRuleError } from '../types/errors';
import { Money }                  from '../common/money';
import { normalizeExpiry, NO_EXPIRY_SENTINEL, todayLocalISO } from '../common/expiry';

export class BatchService {
  constructor(
    private readonly repo:        BatchRepository,
    private readonly productRepo: ProductRepository,
    private readonly bus:         EventBus
  ) {}

  async getByProduct(productId: number): Promise<Batch[]> {
    Validate.id(productId, 'Product');
    return await this.repo.getByProduct(productId);
  }

  async getById(id: number): Promise<Batch> {
    const b = await this.repo.getById(id);
    if (!b) throw new NotFoundError('Batch', id);
    return b;
  }

  async getAvailable(productId: number): Promise<Batch[]> {
    Validate.id(productId, 'Product');
    return await this.repo.getAvailableByProduct(productId) as unknown as Batch[];
  }

  async getAllAvailable(filters: { categoryId?: number; search?: string } = {}): Promise<Batch[]> {
    return await this.repo.getAllAvailable(filters);
  }

  async getAll(filters: BatchFilters = {}): Promise<Batch[]> {
    return await this.repo.getAll(filters);
  }

  async create(data: CreateBatchInput, userId: number): Promise<Batch> {
    Validate.id(data.product_id, 'Product');
    const product = await this.productRepo.getById(data.product_id);
    if (!product) throw new NotFoundError('Product', data.product_id);

    // Expiry is optional (a product can be flagged as non-expiring). When
    // provided, normalize to end-of-month ISO; when blank, use the no-expiry
    // sentinel so the NOT NULL column and date comparisons keep working.
    let expiryDate = NO_EXPIRY_SENTINEL;
    if (data.expiry_date && data.expiry_date.trim()) {
      expiryDate = normalizeExpiry(data.expiry_date);
      if (!expiryDate) throw new ValidationError('Invalid expiry date', 'expiry_date');
    }
    Validate.positiveInteger(data.quantity_base, 'Quantity');

    // Cost may be fractional (up to 3 dp); selling prices stay whole SDG.
    const costParent = Money.roundCost(Validate.positiveNumber(data.cost_per_parent, 'Cost per base unit'));
    const sellParent = data.selling_price_parent
      ? Money.round(Validate.positiveNumber(data.selling_price_parent, 'Selling price'))
      : 0;

    const cf       = product.conversion_factor ?? 1;
    const costChild  = data.cost_per_child_override    ?? Money.costPerChild(costParent, cf);
    const sellChild  = data.selling_price_child_override ?? (sellParent ? Money.divideToChild(sellParent, cf) : 0);

    // B7: a batch entered with an already-expired date (recording short-dated
    // stock you already own) must start in quarantine, never active/sellable
    // — the repo's INSERT used to hardcode status='active' unconditionally.
    const status = expiryDate <= todayLocalISO() ? 'quarantine' : 'active';

    let result;
    try {
      result = await this.repo.create({
        ...data,
        batch_number: Validate.optionalString(data.batch_number, 'Batch number', 60) ?? undefined,
        expiry_date: expiryDate,
        cost_per_parent: costParent,
        cost_per_child: Money.costPerChild(costParent, cf),
        selling_price_parent: sellParent,
        selling_price_child: sellParent ? Money.divideToChild(sellParent, cf) : 0,
        selling_price_parent_override: sellParent,
        cost_per_child_override: costChild,
        selling_price_child_override: sellChild,
        status,
      });
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint failed') && err?.message?.includes('idx_batches_product_batch')) {
        throw new ValidationError(`Batch number "${data.batch_number}" already exists for this product.`, 'batch_number');
      }
      throw err;
    }


    const newId = result.lastInsertRowid as number;

    // Auto-propagate: new batch's selling prices → all older batches of the same product
    if (sellParent > 0) {
      const sellChildBase = sellParent ? Money.divideToChild(sellParent, cf) : 0;
      // D2/D4: capture what each affected batch's price WAS before this
      // cascade overwrites it — this previously had no audit event at all
      // (just a console.log), so a mistaken price cascade had nothing to
      // roll back to and no trace in the audit log.
      const affected = await this.repo.getBatchesForPriceCascade(data.product_id, newId);
      const propagated = await this.repo.propagateSellingPrices(
        data.product_id, newId,
        sellParent, sellChildBase, sellParent, sellChild
      );
      if (propagated > 0) {
        this.bus.emit('entity:mutated', {
          action: 'PROPAGATE_SELLING_PRICE', table: 'products',
          recordId: data.product_id, userId,
          oldValues: {
            batches: affected.map(b => ({ batch_id: b.id, selling_price_parent: b.selling_price_parent, selling_price_child: b.selling_price_child })),
          },
          newValues: {
            selling_price_parent: sellParent,
            selling_price_child: sellChildBase,
            source_batch_id: newId,
            batches_updated: propagated,
          },
        });
      }
    }

    this.bus.emit('entity:mutated', {
      action: 'CREATE_BATCH', table: 'batches',
      recordId: newId, userId,
      newValues: {
        product_id: data.product_id,
        quantity: data.quantity_base,
        expiry: data.expiry_date,
      },
    });

    return await this.getById(newId);
  }

  async update(id: number, data: Partial<UpdateBatchInput>, userId: number): Promise<Batch> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('Batch', id);

    if (data.version !== undefined && data.version !== existing.version) {
      throw new ConflictError('Batch was modified by another operation. Please refresh and try again.');
    }

    if (data.status && existing.status !== data.status) {
      if (existing.status === 'sold_out' && data.status === 'active' && (data.quantity_base ?? existing.quantity_base) <= 0) {
        throw new ValidationError('Cannot mark a batch active with zero quantity. Please adjust quantity first.', 'status');
      }
      if (data.status === 'sold_out' && (data.quantity_base ?? existing.quantity_base) > 0) {
        throw new ValidationError('Cannot mark a batch sold out when it still has quantity.', 'status');
      }
    }

    if (data.expiry_date !== undefined) {
      Validate.dateString(data.expiry_date, 'Expiry date');
    }

    // Validate quantity_base is non-negative if provided
    if (data.quantity_base !== undefined && data.quantity_base < 0) {
      throw new ValidationError('Quantity cannot be negative', 'quantity_base');
    }

    // B5: a manual quantity edit is the one batch operation that most needs
    // an explanation — anyone with inventory.batches.manage could otherwise
    // set any batch to any quantity with zero record of why. Require it
    // whenever the edit actually changes the quantity (not on a no-op
    // resubmit of the same value).
    let quantityChangeReason: string | undefined;
    if (data.quantity_base !== undefined && data.quantity_base !== existing.quantity_base) {
      quantityChangeReason = Validate.requiredString(data.reason, 'Reason for quantity change', 500);
    }

    // Auto-derive status from the new quantity for the sold_out <-> active transition.
    // Without this, re-stocking a sold_out batch (quantity 0 -> N) leaves status='sold_out',
    // so POS (which requires status='active' AND quantity_base>0) keeps showing out-of-stock.
    // Only the caller can move a batch into/out of 'quarantine'; we never touch that here.
    if (data.quantity_base !== undefined && data.status === undefined) {
      if (data.quantity_base > 0 && existing.status === 'sold_out') {
        data.status = 'active';
      } else if (data.quantity_base === 0 && existing.status === 'active') {
        data.status = 'sold_out';
      }
    }

    // Validate selling prices are non-negative
    if (data.selling_price_parent !== undefined && data.selling_price_parent < 0) {
      throw new ValidationError('Selling price cannot be negative', 'selling_price_parent');
    }
    if (data.cost_per_parent !== undefined && data.cost_per_parent < 0) {
      throw new ValidationError('Cost price cannot be negative', 'cost_per_parent');
    }

    // Normalize expiry on edit: end-of-month ISO when provided, no-expiry sentinel when blank.
    if (data.expiry_date !== undefined) {
      if (data.expiry_date && data.expiry_date.trim()) {
        const norm = normalizeExpiry(data.expiry_date);
        if (!norm) throw new ValidationError('Invalid expiry date', 'expiry_date');
        data.expiry_date = norm;
      } else {
        data.expiry_date = NO_EXPIRY_SENTINEL;
      }
    }

    // NOTE: cost edits are allowed even after sales. Past sales snapshot their own
    // cost_price into transaction_items, so editing the batch cost only affects future
    // COGS/margin — it does not rewrite already-recorded sales.

    // Auto-recalculate base child prices when parent prices change.
    // Cost may be fractional (3 dp); selling prices stay whole SDG.
    const cf = existing.conversion_factor ?? 1;
    if (data.cost_per_parent !== undefined) {
      data.cost_per_parent = Money.roundCost(data.cost_per_parent);
      if (cf > 1) {
        data.cost_per_child = Money.costPerChild(data.cost_per_parent, cf);
      }
    }
    if ((data.selling_price_parent !== undefined || data.selling_price_parent_override !== undefined) && cf > 1) {
      const newSellParent = data.selling_price_parent_override
        ?? data.selling_price_parent
        ?? existing.selling_price_parent_override
        ?? existing.selling_price_parent
        ?? 0;
      data.selling_price_child = Money.divideToChild(newSellParent, cf);
    }

    // D2: a genuine selling-price edit through this form opts the batch out
    // of future automatic price-cascade propagation (purchase receiving,
    // new-batch creation) until the flag is cleared by a cascade-eligible
    // write — otherwise a deliberate manual price is silently overwritten
    // by whatever price the next invoice line happens to carry.
    const priceChanged =
      (data.selling_price_parent !== undefined && data.selling_price_parent !== existing.selling_price_parent) ||
      (data.selling_price_parent_override !== undefined && data.selling_price_parent_override !== existing.selling_price_parent_override) ||
      (data.selling_price_child !== undefined && data.selling_price_child !== existing.selling_price_child) ||
      (data.selling_price_child_override !== undefined && data.selling_price_child_override !== existing.selling_price_child_override);
    if (priceChanged) {
      // Local-time string to match every other timestamp in the schema
      // (datetime('now','localtime')) — this column is a NULL/NOT-NULL
      // marker for the cascade check, not a value compared against SQL
      // dates, but stays consistent for anyone reading the raw column.
      const n = new Date();
      const pad = (v: number) => String(v).padStart(2, '0');
      data.price_manually_set_at =
        `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} ${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    }

    let success = false;
    try {
      success = await this.repo.update(id, existing.version, data);
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint failed') && err?.message?.includes('idx_batches_product_batch')) {
        throw new ValidationError(`Batch number "${data.batch_number}" already exists for this product.`, 'batch_number');
      }
      throw err;
    }

    if (!success) {
      throw new ConflictError('Batch was modified by another operation. Please refresh and try again.');
    }

    // Audit a manual stock-quantity edit as a correction adjustment. This makes batch-tab
    // edits appear in the Adjustments list AND keeps the reconciliation ledger in sync with
    // actual stock (a silent quantity edit would otherwise create system-vs-actual variance).
    // Convention: quantity_base > 0 = stock removed, < 0 = stock added.
    if (data.quantity_base !== undefined && data.quantity_base !== existing.quantity_base) {
      await this.repo.insertAdjustment({
        product_id:    existing.product_id!,
        batch_id:      id,
        quantity_base: existing.quantity_base - data.quantity_base,
        reason:        quantityChangeReason!,
        type:          'correction',
        user_id:       userId,
      });
    }

    // Auto-propagate: if selling prices changed AND this is the latest batch,
    // push the new selling prices to all older batches of the same product.
    const sellingPriceChanged = (
      data.selling_price_parent !== undefined ||
      data.selling_price_parent_override !== undefined ||
      data.selling_price_child !== undefined ||
      data.selling_price_child_override !== undefined
    );
    if (sellingPriceChanged) {
      const latestId = await this.repo.getLatestBatchId(existing.product_id!);
      if (latestId === id) {
        // Re-read the updated batch to get the final prices
        const updated = await this.repo.getById(id);
        if (updated) {
          const affected = await this.repo.getBatchesForPriceCascade(existing.product_id!, id);
          const propagated = await this.repo.propagateSellingPrices(
            existing.product_id!, id,
            updated.selling_price_parent ?? 0,
            updated.selling_price_child ?? 0,
            updated.selling_price_parent_override ?? updated.selling_price_parent ?? 0,
            updated.selling_price_child_override ?? updated.selling_price_child ?? 0
          );
          if (propagated > 0) {
            this.bus.emit('entity:mutated', {
              action: 'PROPAGATE_SELLING_PRICE', table: 'products',
              recordId: existing.product_id!, userId,
              oldValues: {
                batches: affected.map(b => ({ batch_id: b.id, selling_price_parent: b.selling_price_parent, selling_price_child: b.selling_price_child })),
              },
              newValues: {
                selling_price_parent: updated.selling_price_parent ?? 0,
                selling_price_child: updated.selling_price_child ?? 0,
                source_batch_id: id,
                batches_updated: propagated,
              },
            });
          }
        }
      }
    }

    // Record the PREVIOUS value of every field the patch actually changed — the
    // audit trail otherwise only shows what a batch became, never what it was.
    const { oldValues, newValues } = diffValues(
      existing as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    );

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_BATCH', table: 'batches',
      recordId: id, userId, oldValues, newValues,
    });

    return await this.getById(id);
  }

  async reportDamage(
    batchId: number,
    quantityBase: number,
    reason: string | null,
    type: AdjustmentType,
    userId: number
  ): Promise<void> {
    Validate.id(batchId, 'Batch');
    Validate.positiveInteger(quantityBase, 'Quantity');
    Validate.enum(type, ['damage', 'expiry', 'correction'] as const, 'Adjustment type');

    return await this.repo.inTransaction(async () => {
      const batch = await this.repo.getById(batchId);
      if (!batch) throw new NotFoundError('Batch', batchId);
      if (batch.quantity_base < quantityBase) {
        throw new ValidationError(
          `Cannot adjust ${quantityBase} units — only ${batch.quantity_base} available`, 'quantity'
        );
      }

      const newQty = batch.quantity_base - quantityBase;
      const newStatus = newQty === 0 ? 'sold_out' : batch.status;

      const success = await this.repo.updateQuantityOptimistic(batchId, newQty, newStatus, batch.version);
      if (!success) throw new ConflictError('Batch was modified concurrently. Please retry.');

      await this.repo.insertAdjustment({
        product_id:   batch.product_id!,
        batch_id:     batchId,
        quantity_base: quantityBase,
        reason,
        type,
        user_id:      userId,
      });

      this.bus.emit('entity:mutated', {
        action: 'REPORT_DAMAGE', table: 'batches',
        recordId: batchId, userId,
        oldValues: { quantity_base: batch.quantity_base, status: batch.status },
        newValues: { quantity_base: newQty, status: newStatus, type, reason },
      });
      this.bus.emit('stock:changed', {
        batchId,
        productId:        batch.product_id!,
        previousQuantity: batch.quantity_base,
        newQuantity:      newQty,
        changeReason:     type === 'correction' ? 'correction' : type === 'expiry' ? 'expiry' : 'damage',
        userId,
      });
    });
  }

  async reverseAdjustment(id: number, userId: number): Promise<void> {
    return await this.repo.inTransaction(async () => {
      const adj = await this.repo.getAdjustmentById(id);
      if (!adj) throw new NotFoundError('Adjustment', id);

      // B6: the sign convention ("positive = stock removed") isn't a
      // reliable signal that a row IS a reversal — a cycle-count overage
      // (counted MORE than the system had) is also legitimately stored
      // negative, and the old check permanently blocked it from ever being
      // reversed. reverses_adjustment_id is unambiguous: only a row that
      // was itself created BY a reversal has it set.
      if (adj.reverses_adjustment_id != null) {
        throw new BusinessRuleError('Cannot reverse a reversal adjustment');
      }

      // B6: "already reversed" used to be detected by matching the free-text
      // reason string 'Reversal of adjustment #<id>' — any edit to that
      // literal (translation, a user typing the same text elsewhere)
      // silently broke this guard. A partial UNIQUE index on
      // reverses_adjustment_id makes a double-reverse impossible at the DB
      // level; this check just gives a clean error instead of a raw
      // constraint-violation message.
      const existingReversal = await this.repo.getReversalOf(id);
      if (existingReversal) {
        throw new BusinessRuleError('This adjustment has already been reversed');
      }

      const batch = await this.repo.getById(adj.batch_id);
      if (!batch) throw new NotFoundError('Batch', adj.batch_id);

      const newQty = batch.quantity_base + adj.quantity_base;
      const newStatus = newQty > 0 && batch.status === 'sold_out' ? 'active' : batch.status;

      const success = await this.repo.updateQuantityOptimistic(batch.id, newQty, newStatus, batch.version);
      if (!success) throw new ConflictError('Batch was modified concurrently. Please retry.');

      await this.repo.insertAdjustment({
        product_id:   batch.product_id!,
        batch_id:     batch.id,
        quantity_base: -adj.quantity_base, // represents adding stock back
        reason: `Reversal of adjustment #${adj.id}`,
        type: 'correction',
        user_id:      userId,
        reverses_adjustment_id: adj.id,
      });

      this.bus.emit('entity:mutated', {
        action: 'REVERSE_ADJUSTMENT', table: 'batches',
        recordId: batch.id, userId,
        oldValues: { quantity_base: batch.quantity_base, status: batch.status },
        newValues: { quantity_base: newQty, status: newStatus },
      });
      this.bus.emit('stock:changed', {
        batchId: batch.id,
        productId: batch.product_id!,
        previousQuantity: batch.quantity_base,
        newQuantity: newQty,
        changeReason: 'correction',
        userId,
      });
    });
  }

  async getExpiring(days: number): Promise<Batch[]> {
    return await this.repo.getExpiring(Math.max(1, Math.min(365, days)));
  }

  async getExpired(): Promise<Batch[]> {
    return await this.repo.getExpired();
  }

  async getAdjustments(filters: AdjustmentFilters = {}): Promise<InventoryAdjustment[]> {
    return await this.repo.getAdjustments(filters);
  }

  async getBatchDeleteInfo(id: number): Promise<{ quantity_base: number; txn_count: number; adj_count: number } | undefined> {
    return await this.repo.getBatchDeleteInfo(id);
  }

  async getActiveBatchesForPriceUpdate(productId: number): Promise<Array<{ id: number; batch_number: string | null; quantity_base: number; expiry_date: string }>> {
    Validate.id(productId, 'Product');
    return await this.repo.getActiveBatchesForPriceUpdate(productId);
  }

  async updateSellingPricesByProduct(
    productId: number,
    sellingPriceParent: number,
    sellingPriceChild: number | null,
    userId: number
  ): Promise<number> {
    Validate.id(productId, 'Product');
    const product = await this.productRepo.getById(productId);
    const cf = product?.conversion_factor ?? 1;
    const baseChildPrice = cf > 1 ? Money.divideToChild(sellingPriceParent, cf) : sellingPriceParent;
    // preserveOverrides=false: the effective sale price in FIFO/checkout is
    // override-first (batch.selling_price_*_override || selling_price_*), and
    // every batch is created with a non-zero override. Preserving overrides
    // here meant this call updated the `batches` table and reported success
    // while the POS kept charging the old price. Clear the overrides so the
    // newly-typed price actually reaches the till.
    const count = await this.repo.bulkUpdateSellingPrices(productId, sellingPriceParent, baseChildPrice, sellingPriceChild, false);
    if (count > 0) {
      // table/recordId identify a PRODUCT (this re-prices every active batch
      // of that product), not a single batch row — recording table:'batches'
      // here would let this event attach itself to whichever batch happens to
      // share the numeric id with the product once history is filtered by
      // record_id (I1/I2).
      this.bus.emit('entity:mutated', {
        action: 'BULK_UPDATE_BATCH_PRICES', table: 'products',
        recordId: productId, userId,
        newValues: { selling_price_parent: sellingPriceParent, updated_count: count },
      });
    }
    return count;
  }

  // ─── Bulk margin price update ───────────────────────────────────────────────

  private _validateBulkPriceOpts(opts: BulkPriceUpdateOptions): void {
    if (opts.mode !== 'markup_over_cost' && opts.mode !== 'increase_current') {
      throw new ValidationError('Invalid price update mode', 'mode');
    }
    const pct = Number(opts.percent);
    if (!Number.isFinite(pct) || pct < -90 || pct > 500) {
      throw new ValidationError('Percent must be between -90 and 500', 'percent');
    }
    if (opts.rounding !== 1 && opts.rounding !== 50 && opts.rounding !== 100) {
      throw new ValidationError('Rounding must be 1, 50, or 100', 'rounding');
    }
  }

  /** Turn a latest-pricing row into a preview row using the chosen mode/percent/rounding. */
  private _computeBulkPriceRow(p: LatestBatchPricing, opts: BulkPriceUpdateOptions): BulkPriceUpdatePreviewRow {
    const cf = p.conversion_factor > 0 ? p.conversion_factor : 1;
    const basis = opts.mode === 'markup_over_cost' ? p.latest_cost : p.current_sell;
    const raw = (basis * (100 + opts.percent)) / 100;
    // Round to the nearest step, but never below one rounding step.
    const newParent = Math.max(opts.rounding, Math.round(raw / opts.rounding) * opts.rounding);
    const newChild = Money.divideToChild(newParent, cf);
    const changePct = p.current_sell > 0
      ? Math.round(((newParent - p.current_sell) / p.current_sell) * 1000) / 10
      : 0;
    return {
      product_id: p.product_id,
      product_name: p.product_name,
      category_name: p.category_name,
      conversion_factor: cf,
      basis_cost: basis,
      current_sell: p.current_sell,
      new_sell_parent: newParent,
      new_sell_child: newChild,
      change_pct: changePct,
    };
  }

  /** Fetch latest pricing, drop excluded products/categories, compute new prices. No writes. */
  private async _buildBulkPriceRows(opts: BulkPriceUpdateOptions): Promise<BulkPriceUpdatePreviewRow[]> {
    const excludeProducts = new Set(opts.exclude_product_ids ?? []);
    const excludeCategories = new Set(opts.exclude_category_ids ?? []);
    const all = await this.repo.getLatestBatchPricingPerProduct();
    return all
      .filter((p) => !excludeProducts.has(p.product_id))
      .filter((p) => p.category_id == null || !excludeCategories.has(p.category_id))
      .map((p) => this._computeBulkPriceRow(p, opts));
  }

  async previewBulkPriceUpdate(opts: BulkPriceUpdateOptions): Promise<BulkPriceUpdatePreviewRow[]> {
    this._validateBulkPriceOpts(opts);
    return await this._buildBulkPriceRows(opts);
  }

  async applyBulkPriceUpdate(opts: BulkPriceUpdateOptions, userId: number): Promise<BulkPriceUpdateResult> {
    this._validateBulkPriceOpts(opts);
    return await this.repo.inTransaction(async () => {
      const rows = await this._buildBulkPriceRows(opts);
      let updatedBatches = 0;
      for (const r of rows) {
        updatedBatches += await this.repo.bulkUpdateSellingPrices(
          r.product_id, r.new_sell_parent, r.new_sell_child, r.new_sell_child, false
        );
      }
      // No single record_id applies to a catalogue-wide re-price — mark it
      // explicitly as a bulk event and list the affected products, so a
      // record_id-filtered history (I1) doesn't silently miss it.
      // D4: rows already carries each product's price BEFORE this update
      // (current_sell, computed by the same preview path previewBulkPriceUpdate
      // uses) — capturing it here is what makes "undo last price update"
      // possible from the audit log; previously only the new prices and the
      // options were recorded, so a mistaken catalogue-wide run had nothing
      // to roll back to but a database backup.
      this.bus.emit('entity:mutated', {
        action: 'BULK_MARGIN_PRICE_UPDATE', table: 'batches',
        recordId: null, userId,
        oldValues: {
          products: rows.map((r) => ({ product_id: r.product_id, selling_price_parent: r.current_sell })),
        },
        newValues: {
          scope: 'bulk', updatedProducts: rows.length, updatedBatches, options: opts,
          product_ids: rows.map((r) => r.product_id),
          products: rows.map((r) => ({ product_id: r.product_id, selling_price_parent: r.new_sell_parent, selling_price_child: r.new_sell_child })),
        },
      });
      return { updatedProducts: rows.length, updatedBatches };
    });
  }

  /**
   * Manual (selected-products) price update: set explicit selling prices per
   * product — parent price required, small-unit price derived by floor
   * division when not given. All writes in one transaction, one audit event.
   */
  async applyManualPriceUpdate(items: ManualPriceUpdateItem[], userId: number): Promise<BulkPriceUpdateResult> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('At least one product is required', 'items');
    }
    for (const item of items) {
      Validate.id(item.product_id, 'Product');
      Validate.positiveNumber(item.selling_price_parent, 'Selling price');
      if (item.selling_price_child != null && item.selling_price_child < 0) {
        throw new ValidationError('Small-unit price cannot be negative', 'selling_price_child');
      }
    }

    return await this.repo.inTransaction(async () => {
      // D4: capture each product's price BEFORE this update so the event is
      // reversible — previously only the new prices were recorded.
      const currentPricing = await this.repo.getLatestBatchPricingPerProduct();
      const priceById = new Map(currentPricing.map((p) => [p.product_id, p]));

      let updatedBatches = 0;
      const oldPrices: Array<{ product_id: number; selling_price_parent: number }> = [];
      for (const item of items) {
        const product = await this.productRepo.getById(item.product_id);
        if (!product) throw new NotFoundError('Product', item.product_id);
        const cf = product.conversion_factor && product.conversion_factor > 1 ? product.conversion_factor : 1;

        const sellParent = Money.round(item.selling_price_parent);
        const derivedChild = cf > 1 ? Money.divideToChild(sellParent, cf) : sellParent;
        const sellChild = item.selling_price_child != null && item.selling_price_child > 0
          ? Money.round(item.selling_price_child)
          : derivedChild;

        const before = priceById.get(item.product_id);
        oldPrices.push({
          product_id: item.product_id,
          selling_price_parent: before?.current_sell ?? 0,
        });

        updatedBatches += await this.repo.bulkUpdateSellingPrices(
          item.product_id, sellParent, derivedChild, sellChild, false
        );
      }
      this.bus.emit('entity:mutated', {
        action: 'BULK_MANUAL_PRICE_UPDATE', table: 'batches',
        recordId: null, userId,
        oldValues: { products: oldPrices },
        newValues: {
          scope: 'bulk', updatedProducts: items.length, updatedBatches,
          product_ids: items.map((i) => i.product_id),
          items: items.map((i) => ({ product_id: i.product_id, selling_price_parent: i.selling_price_parent, selling_price_child: i.selling_price_child ?? null })),
        },
      });
      return { updatedProducts: items.length, updatedBatches };
    });
  }

  async deleteBatch(id: number, userId: number): Promise<void> {
    Validate.id(id);
    const batch = await this.repo.getById(id);
    if (!batch) throw new NotFoundError('Batch', id);

    const info = await this.repo.getBatchDeleteInfo(id);
    if (info && (info.txn_count > 0 || info.adj_count > 0)) {
      throw new ValidationError(
        'Cannot delete batch with transaction history. Soft-delete (status=sold_out, quantity=0) instead.',
        'id'
      );
    }

    // A hard-delete of a batch that still holds stock destroys inventory with
    // no adjustment record and no quantity captured anywhere — the loss
    // can't even be quantified after the fact. Require the batch to be
    // zeroed first (via reportDamage, which already writes a correction/
    // damage adjustment) so every unit of stock leaves through a path that
    // is recorded and reconcilable.
    if (batch.quantity_base > 0) {
      throw new ValidationError(
        `Cannot delete batch with ${batch.quantity_base} units of stock remaining. ` +
        'Report damage/expiry to zero the quantity first, then delete.',
        'id'
      );
    }

    await this.repo.deleteBatch(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_BATCH', table: 'batches',
      recordId: id, userId,
      oldValues: {
        product_name: (batch as any).product_name,
        batch_number: batch.batch_number,
        expiry_date: batch.expiry_date,
        quantity_base: batch.quantity_base,
      },
    });
  }

  async bulkDeleteBatches(
    ids: number[],
    userId: number
  ): Promise<{ deleted: number[]; errors: Array<{ id: number; reason: string }> }> {
    const deleted: number[] = [];
    const errors: Array<{ id: number; reason: string }> = [];
    for (const id of ids) {
      try {
        await this.deleteBatch(id, userId);
        deleted.push(id);
      } catch (e) {
        errors.push({ id, reason: e instanceof Error ? e.message : 'Unknown error' });
      }
    }
    return { deleted, errors };
  }
}
