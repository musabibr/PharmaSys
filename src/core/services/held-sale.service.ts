import type { HeldSaleRepository } from '../repositories/sql/held-sale.repository';
import type { EventBus }            from '../events/event-bus';
import type { HeldSale }            from '../types/models';
import { Validate }                 from '../common/validation';
import { Money }                     from '../common/money';
import { NotFoundError, ValidationError, InternalError, PermissionError } from '../types/errors';

export class HeldSaleService {
  constructor(
    private readonly repo: HeldSaleRepository,
    private readonly bus:  EventBus
  ) {}

  async getAll(requestingUserId: number, requestingUserRole: string): Promise<HeldSale[]> {
    if (requestingUserRole === 'admin') {
      return await this.repo.getAll();
    }
    return await this.repo.getAll(requestingUserId);
  }

  async save(userId: number, items: unknown[], customerNote?: string): Promise<HeldSale> {
    Validate.id(userId, 'User');
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError('Cart cannot be empty', 'items');
    }

    // Calculate total from items (matches legacy saveHeldSale)
    const totalAmount = (items as Array<{ quantity?: unknown; unit_price?: unknown }>).reduce(
      (s, i) => s + Money.round((Number(i.quantity) || 0) * (Number(i.unit_price) || 0)),
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

  async delete(id: number, userId: number, userRole?: string): Promise<void> {
    Validate.id(id);

    // H6: getAll already scopes to the requesting user unless admin, but
    // delete did not — any cashier could remove a colleague's parked sale
    // just by guessing a sequential id. Ownership is enforced here so both
    // transports get it, not only whichever one remembered to check.
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('HeldSale', id);
    if (existing.user_id !== userId && userRole !== 'admin') {
      throw new PermissionError('You can only delete your own held sales');
    }

    await this.repo.delete(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_HELD_SALE', table: 'held_sales',
      recordId: id, userId,
      oldValues: {
        owner_user_id: existing.user_id,
        total_amount: existing.total_amount,
        customer_note: existing.customer_note,
      },
    });
  }
}
