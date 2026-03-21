import type { HeldSaleRepository } from '../repositories/sql/held-sale.repository';
import type { EventBus }            from '../events/event-bus';
import type { HeldSale }            from '../types/models';
import { Validate }                 from '../common/validation';
import { NotFoundError, ValidationError, InternalError } from '../types/errors';

export class HeldSaleService {
  constructor(
    private readonly repo: HeldSaleRepository,
    private readonly bus:  EventBus
  ) {}

  async getAll(userId?: number): Promise<HeldSale[]> {
    return await this.repo.getAll(userId);
  }

  async save(userId: number, items: unknown[], customerNote?: string): Promise<HeldSale> {
    Validate.id(userId, 'User');
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('Cart cannot be empty', 'items');
    }

    // Calculate total from items (matches legacy saveHeldSale)
    const totalAmount = (items as Array<{ quantity?: unknown; unit_price?: unknown }>).reduce(
      (s, i) => s + Math.round((Number(i.quantity) || 0) * (Number(i.unit_price) || 0)),
      0
    );

    const result = await this.repo.save({
      user_id: userId,
      customer_note: customerNote ?? null,
      items_json: JSON.stringify(items),
      total_amount: totalAmount,
    });

    this.bus.emit('entity:mutated', {
      action: 'HOLD_SALE', table: 'held_sales',
      recordId: result.lastInsertRowid, userId,
      newValues: { item_count: items.length, total_amount: totalAmount },
    });

    const saved = (await this.repo.getAll(userId)).find(s => s.id === result.lastInsertRowid);
    if (!saved) throw new InternalError('Failed to retrieve held sale after save');
    return saved;
  }

  async delete(id: number, userId: number): Promise<void> {
    Validate.id(id);
    await this.repo.delete(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_HELD_SALE', table: 'held_sales',
      recordId: id, userId,
    });
  }
}
