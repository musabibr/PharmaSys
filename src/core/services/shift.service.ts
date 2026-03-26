import type { ShiftRepository }   from '../repositories/sql/shift.repository';
import type { EventBus }           from '../events/event-bus';
import type {
  Shift, ShiftFilters, ShiftExpectedCash, ShiftReport,
  PaginatedResult, VarianceType,
} from '../types/models';
import { Validate }                from '../common/validation';
import { NotFoundError, ValidationError, InternalError } from '../types/errors';
import { Money }                   from '../common/money';

export class ShiftService {
  constructor(
    private readonly repo: ShiftRepository,
    private readonly bus:  EventBus
  ) {}

  async getCurrent(userId: number): Promise<Shift | undefined> {
    Validate.id(userId, 'User');
    return await this.repo.getCurrent(userId);
  }

  async getById(id: number): Promise<Shift> {
    Validate.id(id);
    const shift = await this.repo.getById(id);
    if (!shift) throw new NotFoundError('Shift', id);
    return shift;
  }

  async getAll(filters: ShiftFilters = {}): Promise<PaginatedResult<Shift>> {
    return await this.repo.getAll(filters);
  }

  async open(userId: number, openingAmount: number): Promise<Shift> {
    Validate.id(userId, 'User');

    const existing = await this.repo.findOpenByUser(userId);
    if (existing) {
      throw new ValidationError(
        'You already have an open shift. Please close it before opening a new one.',
        'shift'
      );
    }

    const amount = Money.round(Validate.nonNegativeNumber(openingAmount, 'Opening amount'));
    const result = await this.repo.open(userId, amount);

    const newShiftId = result.lastInsertRowid as number;
    this.bus.emit('shift:changed', {
      action: 'opened', shiftId: newShiftId, userId,
    });

    const shift = await this.repo.getById(newShiftId);
    if (!shift) throw new InternalError('Failed to retrieve opened shift');
    return shift;
  }

  async updateOpeningAmount(shiftId: number, newAmount: number, userId: number, userRole?: string, reason?: string): Promise<Shift> {
    Validate.id(shiftId);
    const shift = await this.repo.getById(shiftId);
    if (!shift) throw new NotFoundError('Shift', shiftId);

    if (userRole !== 'admin') {
      // Non-admin: own shift only, today only, reason required
      if (shift.user_id !== userId) {
        throw new ValidationError('You can only edit your own shift', 'shift');
      }
      const n = new Date();
      const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
      const shiftDate = shift.opened_at?.slice(0, 10);
      if (shiftDate !== today) {
        throw new ValidationError("You can only edit today's shift", 'shift');
      }
      if (!reason || reason.trim().length === 0) {
        throw new ValidationError('A reason is required when editing shift opening amount', 'reason');
      }
    }

    const amount = Money.round(Validate.nonNegativeNumber(newAmount, 'Opening amount'));
    const oldAmount = shift.opening_amount;

    await this.repo.updateOpeningAmount(shiftId, amount);

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_OPENING_AMOUNT',
      table: 'shifts',
      recordId: shiftId,
      userId,
      oldValues: { opening_amount: oldAmount },
      newValues: { opening_amount: amount, reason: reason ?? null },
    });

    const updated = await this.repo.getById(shiftId);
    if (!updated) throw new InternalError('Failed to retrieve updated shift');
    return updated;
  }

  async close(
    shiftId: number,
    actualCash: number,
    notes: string | null,
    userId: number
  ): Promise<Shift> {
    Validate.id(shiftId);

    const shift = await this.repo.getById(shiftId);
    if (!shift) throw new NotFoundError('Shift', shiftId);
    if (shift.status !== 'open') {
      throw new ValidationError('Shift is already closed', 'shift');
    }
    if (shift.user_id !== userId) {
      throw new ValidationError('You can only close your own shift', 'shift');
    }

    const actual   = Money.round(Validate.nonNegativeNumber(actualCash, 'Actual cash'));
    const expected = await this.repo.getExpectedCash(shiftId);

    const variance     = Money.subtract(actual, expected.expected_cash);
    const varianceType: VarianceType =
      variance > 0 ? 'overage'
      : variance < 0 ? 'shortage'
      : 'balanced';

    await this.repo.close(shiftId, {
      expected_cash: expected.expected_cash,
      actual_cash:   actual,
      variance:      variance,
      variance_type: varianceType,
      notes:         notes ?? null,
    });

    this.bus.emit('shift:changed', {
      action: 'closed', shiftId, userId,
      actualCash: actual,
      expectedCash: expected.expected_cash,
      variance,
    });
    this.bus.emit('entity:mutated', {
      action: 'CLOSE_SHIFT', table: 'shifts',
      recordId: shiftId, userId,
      newValues: { actual_cash: actual, variance, variance_type: varianceType },
    });

    const closed = await this.repo.getById(shiftId);
    if (!closed) throw new InternalError('Failed to retrieve closed shift');
    return closed;
  }

  async getExpectedCash(shiftId: number): Promise<ShiftExpectedCash> {
    Validate.id(shiftId);
    if (!await this.repo.getById(shiftId)) throw new NotFoundError('Shift', shiftId);
    return await this.repo.getExpectedCash(shiftId);
  }

  async getReport(shiftId: number): Promise<ShiftReport> {
    Validate.id(shiftId);
    const report = await this.repo.getReport(shiftId);
    if (!report) throw new NotFoundError('Shift', shiftId);
    return report;
  }

  async getLastClosedCash(userId: number): Promise<number> {
    Validate.id(userId, 'User');
    return await this.repo.getLastClosedCash(userId);
  }

  /**
   * Admin-only: force-close any user's shift (e.g. stale or orphaned shifts).
   */
  async forceClose(
    shiftId: number,
    actualCash: number,
    notes: string | null,
    adminUserId: number
  ): Promise<Shift> {
    Validate.id(shiftId);

    const shift = await this.repo.getById(shiftId);
    if (!shift) throw new NotFoundError('Shift', shiftId);
    if (shift.status !== 'open') {
      throw new ValidationError('Shift is already closed', 'shift');
    }

    const actual   = Money.round(Validate.nonNegativeNumber(actualCash, 'Actual cash'));
    const expected = await this.repo.getExpectedCash(shiftId);

    const variance     = Money.subtract(actual, expected.expected_cash);
    const varianceType: VarianceType =
      variance > 0 ? 'overage'
      : variance < 0 ? 'shortage'
      : 'balanced';

    await this.repo.close(shiftId, {
      expected_cash: expected.expected_cash,
      actual_cash:   actual,
      variance:      variance,
      variance_type: varianceType,
      notes:         notes ?? 'Force-closed by admin',
    });

    this.bus.emit('shift:changed', {
      action: 'closed', shiftId, userId: adminUserId,
      actualCash: actual,
      expectedCash: expected.expected_cash,
      variance,
    });
    this.bus.emit('entity:mutated', {
      action: 'FORCE_CLOSE_SHIFT', table: 'shifts',
      recordId: shiftId, userId: adminUserId,
      newValues: { actual_cash: actual, variance, variance_type: varianceType, original_user_id: shift.user_id },
    });

    const closed = await this.repo.getById(shiftId);
    if (!closed) throw new InternalError('Failed to retrieve closed shift');
    return closed;
  }

  /**
   * Auto-close shifts that have been open longer than maxAgeHours.
   * Closes with actual_cash = expected_cash (balanced variance).
   * Returns count of shifts closed.
   */
  async autoCloseStale(maxAgeHours: number = 24): Promise<number> {
    const staleShifts = await this.repo.findStaleShifts(maxAgeHours);
    let count = 0;

    for (const shift of staleShifts) {
      try {
        const expected = await this.repo.getExpectedCash(shift.id);

        // Auto-close with actual_cash=NULL to indicate cash was NEVER counted.
        // Do NOT fake a balanced result — that masks real shortages/overages.
        await this.repo.close(shift.id, {
          expected_cash: expected.expected_cash,
          actual_cash:   null as unknown as number,
          variance:      null as unknown as number,
          variance_type: null as unknown as string,
          notes:         'Auto-closed: shift exceeded ' + maxAgeHours + ' hours. Cash was not counted — manual audit required.',
        });

        this.bus.emit('shift:changed', {
          action: 'closed', shiftId: shift.id, userId: shift.user_id,
          actualCash: 0,
          expectedCash: expected.expected_cash,
          variance: 0,
        });

        count++;
      } catch {
        // Log but don't fail — other stale shifts should still be processed
      }
    }

    return count;
  }
}
