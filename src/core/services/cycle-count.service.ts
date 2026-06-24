import type { CycleCountRepository } from '../repositories/sql/cycle-count.repository';
import type { BatchRepository } from '../repositories/sql/batch.repository';
import type { EventBus } from '../events/event-bus';
import type { CycleCount } from '../types/models';
import { NotFoundError, BusinessRuleError } from '../types/errors';

export class CycleCountService {
  constructor(
    private readonly repo: CycleCountRepository,
    private readonly batchRepo: BatchRepository,
    private readonly bus: EventBus
  ) {}

  async getAll(): Promise<CycleCount[]> {
    return await this.repo.getAll();
  }

  async getById(id: number): Promise<CycleCount> {
    const cc = await this.repo.getById(id);
    if (!cc) throw new NotFoundError('CycleCount', id);
    return cc;
  }

  async create(data: { name: string; assigned_to?: number; notes?: string }, userId: number): Promise<CycleCount> {
    const id = await this.repo.create({ ...data, created_by: userId });
    this.bus.emit('entity:mutated', {
      action: 'CREATE_CYCLE_COUNT', table: 'cycle_counts',
      recordId: id, userId, newValues: data
    });
    return await this.getById(id);
  }

  async start(id: number, userId: number, productIds?: number[]): Promise<CycleCount> {
    const cc = await this.getById(id);
    if (cc.status !== 'pending') throw new BusinessRuleError('Only pending cycle counts can be started');

    // Resolve which products to count.
    let productIdList: number[];
    if (productIds && productIds.length > 0) {
      productIdList = [...new Set(productIds)];
    } else {
      // No scope → every product that currently has active, non-expired, in-stock batches.
      const activeBatches = await this.batchRepo.getAll({ status: 'active' });
      const today = new Date().toISOString().split('T')[0];
      productIdList = [...new Set(
        activeBatches
          .filter(b => b.quantity_base > 0 && (!b.expiry_date || b.expiry_date >= today))
          .map(b => b.product_id)
      )];
    }

    // PRODUCT-LEVEL: one count row per product, expected = sum of its live batch quantities.
    // The stock count is total-based (e.g. "3 boxes + 2 strips"); the per-batch distribution
    // of any variance happens at apply time in complete(). A selected product always gets a
    // row even if it has no batches (expected 0), so nothing the user picks goes missing.
    const batches = await this.batchRepo.getBatchesForProducts(productIdList);
    const totals = new Map<number, number>();
    for (const pid of productIdList) totals.set(pid, 0);
    for (const b of batches) totals.set(b.product_id, (totals.get(b.product_id) ?? 0) + b.quantity_base);

    const items = productIdList.map(pid => ({
      cycle_count_id: id,
      product_id: pid,
      batch_id: null,
      expected_quantity: totals.get(pid) ?? 0,
    }));

    await this.repo.inTransaction(async () => {
      await this.repo.addItems(items);
      await this.repo.updateStatus(id, 'in_progress', 'started_at');
    });

    this.bus.emit('entity:mutated', {
      action: 'START_CYCLE_COUNT', table: 'cycle_counts',
      recordId: id, userId, newValues: { status: 'in_progress' }
    });

    return await this.getById(id);
  }

  async recordCount(itemId: number, counted_quantity: number, userId: number): Promise<void> {
    if (!Number.isInteger(counted_quantity) || counted_quantity < 0) {
      throw new BusinessRuleError('Counted quantity must be a non-negative integer');
    }

    const item = await this.repo.getItemById(itemId);
    if (!item) throw new NotFoundError('CycleCountItem', itemId);

    const variance = counted_quantity - item.expected_quantity;

    await this.repo.updateItemCount(itemId, counted_quantity, variance);

    this.bus.emit('entity:mutated', {
      action: 'RECORD_CYCLE_COUNT_ITEM', table: 'cycle_count_items',
      recordId: itemId, userId, newValues: { counted_quantity, variance }
    });
  }

  async complete(id: number, applyAdjustments: boolean, userId: number): Promise<CycleCount> {
    const cc = await this.getById(id);
    if (cc.status !== 'in_progress') throw new BusinessRuleError('Only in_progress cycle counts can be completed');

    await this.repo.inTransaction(async () => {
      await this.repo.updateStatus(id, 'completed', 'completed_at');
      
      if (applyAdjustments && cc.items) {
        // Guard: ensure all items have been counted before applying adjustments
        const uncounted = cc.items.filter(i => i.status === 'pending');
        if (uncounted.length > 0) {
          throw new BusinessRuleError(
            `Cannot apply adjustments: ${uncounted.length} item(s) have not been counted yet. Count all items or complete without adjustments.`
          );
        }

        for (const item of cc.items) {
          if (item.status !== 'counted' || item.counted_quantity == null) continue;
          await this._applyProductCount(item.product_id, item.counted_quantity, cc.name, userId);
        }
      }
    });

    this.bus.emit('entity:mutated', {
      action: 'COMPLETE_CYCLE_COUNT', table: 'cycle_counts',
      recordId: id, userId, newValues: { status: 'completed' }
    });

    return await this.getById(id);
  }

  /**
   * Reconcile a product's total stock to the physically-counted total by distributing the
   * difference across its live batches: shortages come off the oldest-expiry batch first
   * (FIFO), found stock is added to the newest-expiry batch. Each per-batch change is recorded
   * as a correction adjustment, so the reconciliation ledger stays in sync — the sum of the
   * adjustments equals the product-level variance. Uses CURRENT batch quantities (not the
   * start snapshot) so sales made during the count don't desync stock.
   */
  private async _applyProductCount(productId: number, countedBase: number, ccName: string, userId: number): Promise<void> {
    const batches = await this.batchRepo.getBatchesForProducts([productId]); // oldest-expiry first
    const currentTotal = batches.reduce((s, b) => s + b.quantity_base, 0);
    const delta = countedBase - currentTotal;
    if (delta === 0) return;

    if (delta < 0) {
      // Shortage — remove |delta| starting from the oldest-expiry batch.
      let toRemove = -delta;
      for (const b of batches) {
        if (toRemove <= 0) break;
        const take = Math.min(b.quantity_base, toRemove);
        if (take <= 0) continue;
        const newQty = b.quantity_base - take;
        const newStatus = newQty === 0 ? 'sold_out' : b.status;
        const ok = await this.batchRepo.updateQuantityOptimistic(b.id, newQty, newStatus, b.version);
        if (!ok) throw new BusinessRuleError(`Batch ${b.id} was modified concurrently. Please retry the count.`);
        await this.batchRepo.insertAdjustment({
          product_id: productId, batch_id: b.id, quantity_base: take,
          reason: `Stock count (${ccName})`, type: 'correction', user_id: userId,
        });
        toRemove -= take;
      }
    } else {
      // Overage / found stock — add to the newest-expiry batch (last in oldest-first order).
      if (batches.length === 0) return; // no batch to attribute found stock to
      const target = batches[batches.length - 1];
      const newQty = target.quantity_base + delta;
      const newStatus = newQty > 0 && target.status === 'sold_out' ? 'active' : target.status;
      const ok = await this.batchRepo.updateQuantityOptimistic(target.id, newQty, newStatus, target.version);
      if (!ok) throw new BusinessRuleError(`Batch ${target.id} was modified concurrently. Please retry the count.`);
      await this.batchRepo.insertAdjustment({
        product_id: productId, batch_id: target.id, quantity_base: -delta,
        reason: `Stock count (${ccName})`, type: 'correction', user_id: userId,
      });
    }
  }
}
