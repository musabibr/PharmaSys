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

    let items;
    if (productIds && productIds.length > 0) {
      // Scoped count: every live (active/quarantine) batch of the selected products,
      // including expired ones — the whole point is to physically verify them.
      const batches = await this.batchRepo.getBatchesForProducts(productIds);
      items = batches.map(b => ({
        cycle_count_id: id,
        product_id: b.product_id,
        batch_id: b.id,
        expected_quantity: b.quantity_base,
      }));
    } else {
      // No scope → all active, non-expired, in-stock batches (legacy behaviour).
      const activeBatches = await this.batchRepo.getAll({ status: 'active' });
      const today = new Date().toISOString().split('T')[0];
      items = activeBatches
        .filter(b => b.quantity_base > 0 && (!b.expiry_date || b.expiry_date >= today))
        .map(b => ({
          cycle_count_id: id,
          product_id: b.product_id,
          batch_id: b.id,
          expected_quantity: b.quantity_base,
        }));
    }

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
          if (item.status !== 'counted' || item.batch_id == null || item.counted_quantity == null) continue;

          const batch = await this.batchRepo.getById(item.batch_id);
          if (!batch) continue;

          const newQty = item.counted_quantity;
          // INTEGRITY FIX: compute the adjustment from the batch's CURRENT quantity at apply
          // time, not from item.variance (which was snapshotted at count start). If a sale
          // happened between counting and completing, the stale variance would desync the
          // reconciliation ledger from actual stock. realDelta > 0 = stock removed (lost),
          // < 0 = stock added (found).
          const realDelta = batch.quantity_base - newQty;
          if (realDelta === 0) continue; // batch already matches the count — nothing to do

          const newStatus = newQty === 0 ? 'sold_out' : batch.status === 'sold_out' ? 'active' : batch.status;
          const success = await this.batchRepo.updateQuantityOptimistic(batch.id, newQty, newStatus, batch.version);
          if (!success) {
            throw new BusinessRuleError(
              `Failed to update batch ${batch.id} (${item.product_name ?? 'unknown'}) — it was modified concurrently. Please retry the cycle count.`
            );
          }

          // Record adjustment: positive quantity_base = stock removed, negative = stock added.
          await this.batchRepo.insertAdjustment({
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity_base: realDelta,
            reason: `Cycle Count correction (${cc.name})`,
            type: 'correction',
            user_id: userId
          });
        }
      }
    });

    this.bus.emit('entity:mutated', {
      action: 'COMPLETE_CYCLE_COUNT', table: 'cycle_counts',
      recordId: id, userId, newValues: { status: 'completed' }
    });

    return await this.getById(id);
  }
}
