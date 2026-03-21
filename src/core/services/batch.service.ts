import type { BatchRepository }   from '../repositories/sql/batch.repository';
import type { ProductRepository } from '../repositories/sql/product.repository';
import type { EventBus }          from '../events/event-bus';
import type {
  Batch, CreateBatchInput, UpdateBatchInput,
  InventoryAdjustment, AdjustmentFilters, AdjustmentType, BatchFilters,
} from '../types/models';
import { Validate }               from '../common/validation';
import { NotFoundError, ValidationError, ConflictError } from '../types/errors';
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

    Validate.dateString(data.expiry_date, 'Expiry date');
    // Warn but allow past expiry dates (admin may need to enter old stock for corrections)
    Validate.positiveInteger(data.quantity_base, 'Quantity');

    const costParent = Money.round(Validate.positiveNumber(data.cost_per_parent, 'Cost per base unit'));
    const sellParent = data.selling_price_parent
      ? Money.round(Validate.positiveNumber(data.selling_price_parent, 'Selling price'))
      : 0;

    const cf       = product.conversion_factor ?? 1;
    const costChild  = data.cost_per_child_override    ?? Money.divideToChild(costParent, cf);
    const sellChild  = data.selling_price_child_override ?? (sellParent ? Money.divideToChild(sellParent, cf) : 0);

    const result = await this.repo.create({
      ...data,
      cost_per_parent: costParent,
      selling_price_parent: sellParent,
      cost_per_child_override: costChild,
      selling_price_child_override: sellChild,
    });

    const newId = result.lastInsertRowid as number;
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

    if (data.expiry_date !== undefined) {
      Validate.dateString(data.expiry_date, 'Expiry date');
    }

    await this.repo.update(id, data);

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

    const batch = await this.repo.getById(batchId);
    if (!batch) throw new NotFoundError('Batch', batchId);
    if (batch.quantity_base < quantityBase) {
      throw new ValidationError(
        `Cannot adjust ${quantityBase} units — only ${batch.quantity_base} available`, 'quantity'
      );
    }

    const newQty = batch.quantity_base - quantityBase;
    const newStatus =
      newQty === 0 ? 'sold_out'
      : type === 'correction' ? 'active'
      : 'quarantine';

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
}
