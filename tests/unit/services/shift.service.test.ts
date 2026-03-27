import { ShiftService } from '@core/services/shift.service';
import { ValidationError, NotFoundError } from '@core/types/errors';
import {
  createMockShiftRepo, createMockBus, sampleShift, runResult,
} from '../../helpers/mocks';

function createService() {
  const shiftRepo = createMockShiftRepo();
  const bus       = createMockBus();
  const svc       = new ShiftService(shiftRepo as any, bus);
  return { svc, shiftRepo, bus };
}

describe('ShiftService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getCurrent
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getCurrent', () => {
    it('returns open shift for user', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getCurrent.mockResolvedValue(sampleShift);
      expect(await svc.getCurrent(1)).toEqual(sampleShift);
    });

    it('returns undefined when no open shift', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getCurrent.mockResolvedValue(undefined);
      expect(await svc.getCurrent(1)).toBeUndefined();
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.getCurrent(0)).rejects.toThrow(ValidationError);
      await expect(svc.getCurrent(-1)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getById
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getById', () => {
    it('returns shift when found', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(sampleShift);
      expect(await svc.getById(1)).toEqual(sampleShift);
    });

    it('throws NotFoundError when shift does not exist', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(99)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid id', async () => {
      const { svc } = createService();
      await expect(svc.getById(0)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('delegates to repo.getAll with filters', async () => {
      const { svc, shiftRepo } = createService();
      const page = { data: [sampleShift], total: 1, page: 1, limit: 50, totalPages: 1 };
      shiftRepo.getAll.mockResolvedValue(page);

      const result = await svc.getAll({ status: 'open' } as any);
      expect(shiftRepo.getAll).toHaveBeenCalledWith({ status: 'open' });
      expect(result.data).toHaveLength(1);
    });

    it('delegates with empty filters when none provided', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getAll.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });

      await svc.getAll();
      expect(shiftRepo.getAll).toHaveBeenCalledWith({});
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // open
  // ═══════════════════════════════════════════════════════════════════════════
  describe('open', () => {
    it('opens shift with valid opening amount', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      shiftRepo.open.mockResolvedValue(runResult(2));
      shiftRepo.getById.mockResolvedValue({ ...sampleShift, id: 2 });

      const result = await svc.open(1, 5000);
      expect(shiftRepo.open).toHaveBeenCalledWith(1, 5000);
      expect(result.id).toBe(2);
    });

    it('opens shift with zero opening amount', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      shiftRepo.open.mockResolvedValue(runResult(3));
      shiftRepo.getById.mockResolvedValue({ ...sampleShift, id: 3 });

      await svc.open(1, 0);
      expect(shiftRepo.open).toHaveBeenCalledWith(1, 0);
    });

    it('throws ValidationError when user already has an open shift', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      await expect(svc.open(1, 5000)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for negative opening amount', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      await expect(svc.open(1, -100)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.open(0, 0)).rejects.toThrow(ValidationError);
    });

    it('emits shift:changed event on open', async () => {
      const { svc, shiftRepo, bus } = createService();
      shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      shiftRepo.open.mockResolvedValue(runResult(1));
      shiftRepo.getById.mockResolvedValue(sampleShift);

      await svc.open(1, 5000);
      expect(bus.emit).toHaveBeenCalledWith('shift:changed', expect.objectContaining({
        action: 'opened',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // close
  // ═══════════════════════════════════════════════════════════════════════════
  describe('close', () => {
    const closedShift = {
      ...sampleShift,
      status: 'closed' as const,
      expected_cash: 10000,
      actual_cash: 10000,
      variance: 0,
      variance_type: 'balanced' as const,
    };

    it('closes shift and returns updated shift', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById
        .mockResolvedValueOnce(sampleShift)
        .mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({
        opening_amount: 5000, total_cash_sales: 5000, total_cash_returns: 0,
        total_cash_expenses: 0, total_cash_drops: 0, expected_cash: 10000,
      });

      const result = await svc.close(1, 10000, null, 1);
      expect(shiftRepo.close).toHaveBeenCalled();
      expect(result.status).toBe('closed');
    });

    it('calculates balanced variance correctly', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValueOnce(sampleShift).mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 10000 } as any);

      await svc.close(1, 10000, null, 1);
      expect(shiftRepo.close).toHaveBeenCalledWith(1, expect.objectContaining({
        variance: 0,
        variance_type: 'balanced',
      }));
    });

    it('calculates overage variance correctly', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValueOnce(sampleShift).mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 10000 } as any);

      await svc.close(1, 11000, null, 1);
      expect(shiftRepo.close).toHaveBeenCalledWith(1, expect.objectContaining({
        variance: 1000,
        variance_type: 'overage',
      }));
    });

    it('calculates shortage variance correctly', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValueOnce(sampleShift).mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 10000 } as any);

      await svc.close(1, 9000, null, 1);
      expect(shiftRepo.close).toHaveBeenCalledWith(1, expect.objectContaining({
        variance: -1000,
        variance_type: 'shortage',
      }));
    });

    it('throws NotFoundError when shift does not exist', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(undefined);
      await expect(svc.close(99, 0, null, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when shift is already closed', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue({ ...sampleShift, status: 'closed' });
      await expect(svc.close(1, 0, null, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for negative actual cash', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(sampleShift);
      await expect(svc.close(1, -100, null, 1)).rejects.toThrow(ValidationError);
    });

    it('emits shift:changed and entity:mutated on close', async () => {
      const { svc, shiftRepo, bus } = createService();
      shiftRepo.getById.mockResolvedValueOnce(sampleShift).mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 10000 } as any);

      await svc.close(1, 10000, null, 1);
      expect(bus.emit).toHaveBeenCalledWith('shift:changed', expect.objectContaining({
        action: 'closed',
      }));
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CLOSE_SHIFT',
      }));
    });

    it('passes notes to repo.close', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValueOnce(sampleShift).mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 0 } as any);

      await svc.close(1, 0, 'end of day', 1);
      expect(shiftRepo.close).toHaveBeenCalledWith(1, expect.objectContaining({
        notes: 'end of day',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getExpectedCash
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getExpectedCash', () => {
    it('returns expected cash breakdown', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(sampleShift);
      shiftRepo.getExpectedCash.mockResolvedValue({
        opening_amount: 5000, total_cash_sales: 3000, total_cash_returns: 0,
        total_cash_expenses: 500, total_cash_drops: 0, expected_cash: 7500,
      } as any);

      const result = await svc.getExpectedCash(1);
      expect(result.expected_cash).toBe(7500);
    });

    it('throws NotFoundError when shift does not exist', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getExpectedCash(99)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid shift id', async () => {
      const { svc } = createService();
      await expect(svc.getExpectedCash(0)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getReport
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getReport', () => {
    it('returns report for valid shift', async () => {
      const { svc, shiftRepo } = createService();
      const report = { shift: sampleShift, transactions: [], expenses: [] } as any;
      shiftRepo.getReport.mockResolvedValue(report);

      const result = await svc.getReport(1);
      expect(result).toBe(report);
    });

    it('throws NotFoundError when report is null', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getReport.mockResolvedValue(null);

      await expect(svc.getReport(1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid shiftId', async () => {
      const { svc } = createService();
      await expect(svc.getReport(0)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // forceClose
  // ═══════════════════════════════════════════════════════════════════════════
  describe('forceClose', () => {
    const closedShift = {
      ...sampleShift,
      status: 'closed' as const,
      expected_cash: 10000,
      actual_cash: 10000,
      variance: 0,
      variance_type: 'balanced' as const,
    };

    it('force-closes another user\'s shift (admin)', async () => {
      const { svc, shiftRepo } = createService();
      // Shift belongs to user 1, admin (user 99) force-closes it
      shiftRepo.getById
        .mockResolvedValueOnce(sampleShift) // first call: find the shift
        .mockResolvedValue(closedShift);    // second call: return after close
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 10000 } as any);

      const result = await svc.forceClose(1, 10000, 'Admin cleanup', 99);
      expect(shiftRepo.close).toHaveBeenCalled();
      expect(result.status).toBe('closed');
    });

    it('does not check user ownership', async () => {
      const { svc, shiftRepo } = createService();
      const otherUserShift = { ...sampleShift, user_id: 5 };
      shiftRepo.getById
        .mockResolvedValueOnce(otherUserShift)
        .mockResolvedValue({ ...otherUserShift, status: 'closed' });
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 0 } as any);

      // Should NOT throw even though admin (user 99) != shift owner (user 5)
      await expect(svc.forceClose(1, 0, null, 99)).resolves.toBeDefined();
    });

    it('throws NotFoundError when shift does not exist', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue(undefined);
      await expect(svc.forceClose(99, 0, null, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when shift is already closed', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getById.mockResolvedValue({ ...sampleShift, status: 'closed' });
      await expect(svc.forceClose(1, 0, null, 1)).rejects.toThrow(ValidationError);
    });

    it('emits FORCE_CLOSE_SHIFT event', async () => {
      const { svc, shiftRepo, bus } = createService();
      shiftRepo.getById
        .mockResolvedValueOnce(sampleShift)
        .mockResolvedValue(closedShift);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 10000 } as any);

      await svc.forceClose(1, 10000, null, 99);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'FORCE_CLOSE_SHIFT',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // autoCloseStale
  // ═══════════════════════════════════════════════════════════════════════════
  describe('autoCloseStale', () => {
    it('returns 0 when no stale shifts exist', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.findStaleShifts.mockResolvedValue([]);
      expect(await svc.autoCloseStale(24)).toBe(0);
    });

    it('closes stale shifts with balanced variance (cash not counted, uses expected)', async () => {
      const { svc, shiftRepo } = createService();
      const staleShift = { ...sampleShift, id: 10 };
      shiftRepo.findStaleShifts.mockResolvedValue([staleShift]);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 5000 } as any);

      const count = await svc.autoCloseStale(24);
      expect(count).toBe(1);
      expect(shiftRepo.close).toHaveBeenCalledWith(10, expect.objectContaining({
        actual_cash: 5000,
        expected_cash: 5000,
        variance: 0,
        variance_type: 'balanced',
      }));
    });

    it('continues processing if one shift fails', async () => {
      const { svc, shiftRepo } = createService();
      const shift1 = { ...sampleShift, id: 10 };
      const shift2 = { ...sampleShift, id: 11 };
      shiftRepo.findStaleShifts.mockResolvedValue([shift1, shift2]);
      shiftRepo.getExpectedCash
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({ expected_cash: 3000 } as any);

      const count = await svc.autoCloseStale(24);
      expect(count).toBe(1); // Only shift2 succeeded
    });

    it('emits shift:changed for each closed shift', async () => {
      const { svc, shiftRepo, bus } = createService();
      shiftRepo.findStaleShifts.mockResolvedValue([sampleShift]);
      shiftRepo.getExpectedCash.mockResolvedValue({ expected_cash: 0 } as any);

      await svc.autoCloseStale(24);
      expect(bus.emit).toHaveBeenCalledWith('shift:changed', expect.objectContaining({
        action: 'closed',
        shiftId: sampleShift.id,
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getLastClosedCash
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getLastClosedCash', () => {
    it('returns last closed cash for user', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getLastClosedCash.mockResolvedValue(8500);
      expect(await svc.getLastClosedCash(1)).toBe(8500);
    });

    it('returns 0 when no closed shifts', async () => {
      const { svc, shiftRepo } = createService();
      shiftRepo.getLastClosedCash.mockResolvedValue(0);
      expect(await svc.getLastClosedCash(1)).toBe(0);
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.getLastClosedCash(0)).rejects.toThrow(ValidationError);
    });
  });
});
