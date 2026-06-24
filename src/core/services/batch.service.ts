import type { BatchRepository }   from '../repositories/sql/batch.repository';
import type { ProductRepository } from '../repositories/sql/product.repository';
import type { EventBus }          from '../events/event-bus';
import type {
  Batch, CreateBatchInput, UpdateBatchInput,
  InventoryAdjustment, AdjustmentFilters, AdjustmentType, BatchFilters,
} from '../types/models';
import { Validate }               from '../common/validation';
import { NotFoundError, ValidationError, ConflictError, BusinessRuleError } from '../types/errors';
import { Money }                  from '../common/money';

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

    Validate.futureDate(data.expiry_date, 'Expiry date');
    Validate.positiveInteger(data.quantity_base, 'Quantity');

    const costParent = Money.round(Validate.positiveNumber(data.cost_per_parent, 'Cost per base unit'));
    const sellParent = data.selling_price_parent
      ? Money.round(Validate.positiveNumber(data.selling_price_parent, 'Selling price'))
      : 0;

    const cf       = product.conversion_factor ?? 1;
    const costChild  = data.cost_per_child_override    ?? Money.divideToChild(costParent, cf);
    const sellChild  = data.selling_price_child_override ?? (sellParent ? Money.divideToChild(sellParent, cf) : 0);

    let result;
    try {
      result = await this.repo.create({
        ...data,
        batch_number: Validate.optionalString(data.batch_number, 'Batch number', 60) ?? undefined,
        cost_per_parent: costParent,
        cost_per_child: Money.divideToChild(costParent, cf),
        selling_price_parent: sellParent,
        selling_price_child: sellParent ? Money.divideToChild(sellParent, cf) : 0,
        selling_price_parent_override: sellParent,
        cost_per_child_override: costChild,
        selling_price_child_override: sellChild,
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
      const propagated = await this.repo.propagateSellingPrices(
        data.product_id, newId,
        sellParent, sellChildBase, sellParent, sellChild
      );
      if (propagated > 0) {
        console.log(`[BatchService] Propagated selling prices from new batch #${newId} to ${propagated} older batch(es)`);
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

    // NOTE: cost edits are allowed even after sales. Past sales snapshot their own
    // cost_price into transaction_items, so editing the batch cost only affects future
    // COGS/margin — it does not rewrite already-recorded sales.

    // Auto-recalculate base child prices when parent prices change
    const cf = existing.conversion_factor ?? 1;
    if (data.cost_per_parent !== undefined && cf > 1) {
      data.cost_per_child = Money.divideToChild(data.cost_per_parent, cf);
    }
    if ((data.selling_price_parent !== undefined || data.selling_price_parent_override !== undefined) && cf > 1) {
      const newSellParent = data.selling_price_parent_override
        ?? data.selling_price_parent
        ?? existing.selling_price_parent_override
        ?? existing.selling_price_parent
        ?? 0;
      data.selling_price_child = Money.divideToChild(newSellParent, cf);
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
        reason:        'Manual batch quantity edit',
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
          const propagated = await this.repo.propagateSellingPrices(
            existing.product_id!, id,
            updated.selling_price_parent ?? 0,
            updated.selling_price_child ?? 0,
            updated.selling_price_parent_override ?? updated.selling_price_parent ?? 0,
            updated.selling_price_child_override ?? updated.selling_price_child ?? 0
          );
          if (propagated > 0) {
            console.log(`[BatchService] Propagated selling prices from batch #${id} to ${propagated} older batch(es)`);
          }
        }
      }
    }

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_BATCH', table: 'batches',
      recordId: id, userId, newValues: data,
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

      // Guard: cannot reverse a reversal record itself
      if (adj.quantity_base < 0) {
        throw new BusinessRuleError('Cannot reverse a reversal adjustment');
      }

      // Guard: check if this adjustment was already reversed
      const allAdjustments = await this.repo.getAdjustments({ batch_id: adj.batch_id });
      const alreadyReversed = allAdjustments.some(a =>
        a.reason === `Reversal of adjustment #${id}`
      );
      if (alreadyReversed) {
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
    const count = await this.repo.bulkUpdateSellingPrices(productId, sellingPriceParent, baseChildPrice, sellingPriceChild, true);
    if (count > 0) {
      this.bus.emit('entity:mutated', {
        action: 'BULK_UPDATE_BATCH_PRICES', table: 'batches',
        recordId: productId, userId,
        newValues: { selling_price_parent: sellingPriceParent, updated_count: count },
      });
    }
    return count;
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

    await this.repo.deleteBatch(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_BATCH', table: 'batches',
      recordId: id, userId,
      oldValues: { product_name: (batch as any).product_name, batch_number: batch.batch_number, expiry_date: batch.expiry_date },
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
