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
}
