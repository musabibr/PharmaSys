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

  async start(id: number, userId: number): Promise<CycleCount> {
    const cc = await this.getById(id);
    if (cc.status !== 'pending') throw new BusinessRuleError('Only pending cycle counts can be started');
    
    // Auto-populate with active, non-expired batches that have stock.
    // Previously used getAll({}) which returned all batches including quarantined/expired/sold_out.
    const activeBatches = await this.batchRepo.getAll({ status: 'active' });
    const today = new Date().toISOString().split('T')[0];
    const items = activeBatches
      .filter(b => b.quantity_base > 0 && (!b.expiry_date || b.expiry_date >= today))
      .map(b => ({
        cycle_count_id: id,
        product_id: b.product_id,
        batch_id: b.id,
        expected_quantity: b.quantity_base
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
          if (item.status === 'counted' && item.variance !== null && item.variance !== 0 && item.batch_id) {
            // Apply correction
            const batch = await this.batchRepo.getById(item.batch_id);
            if (batch) {
              const newQty = item.counted_quantity ?? 0;
              const newStatus = newQty === 0 ? 'sold_out' : batch.status === 'sold_out' ? 'active' : batch.status;
              const success = await this.batchRepo.updateQuantityOptimistic(batch.id, newQty, newStatus, batch.version);
              if (!success) {
                throw new BusinessRuleError(
                  `Failed to update batch ${batch.id} (${item.product_name ?? 'unknown'}) — it was modified concurrently. Please retry the cycle count.`
                );
              }

              // Record adjustment: positive quantity = stock removed, negative = stock added
              // variance = counted - expected
              // If counted < expected → variance is negative → stock was lost → adjustment records positive (removed)
              // If counted > expected → variance is positive → stock was found → adjustment records negative (added)
              await this.batchRepo.insertAdjustment({
                product_id: item.product_id,
                batch_id: item.batch_id,
                quantity_base: -item.variance,
                reason: `Cycle Count correction (${cc.name})`,
                type: 'correction',
                user_id: userId
              });
            }
          }
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
