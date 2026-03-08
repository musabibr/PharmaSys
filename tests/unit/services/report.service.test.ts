import { ReportService } from '@core/services/report.service';
import { ValidationError } from '@core/types/errors';
import { createMockReportRepo } from '../../helpers/mocks';

const cashFlowReport = {
  totalSales: 100000, totalReturns: 5000,
  totalExpenses: 20000, netCash: 75000,
  transactions: [],
};
const profitLossReport = {
  grossRevenue: 100000, cogs: 60000,
  grossProfit: 40000, expenses: 20000,
  netProfit: 20000,
};
const reorderItems  = [{ product_id: 1, product_name: 'Aspirin', current_stock: 5, min_stock: 10 }];
const deadCapital   = [{ product_id: 2, product_name: 'OldDrug', total_value: 2000 }];
const valuationResult = { items: [], total_cost: 0, total_value: 0 };

function createService() {
  const repo = createMockReportRepo();
  const svc  = new ReportService(repo as any);
  return { svc, repo };
}

describe('ReportService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getCashFlow
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getCashFlow', () => {
    it('returns cash flow report for valid date range', async () => {
      const { svc, repo } = createService();
      repo.getCashFlow.mockResolvedValue(cashFlowReport);

      const result = await svc.getCashFlow('2026-01-01', '2026-01-31');
      expect(repo.getCashFlow).toHaveBeenCalledWith('2026-01-01', '2026-01-31');
      expect(result).toEqual(cashFlowReport);
    });

    it('throws ValidationError for invalid start date', async () => {
      const { svc } = createService();
      await expect(svc.getCashFlow('not-a-date', '2026-01-31')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid end date', async () => {
      const { svc } = createService();
      await expect(svc.getCashFlow('2026-01-01', 'bad-date')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty dates', async () => {
      const { svc } = createService();
      await expect(svc.getCashFlow('', '2026-01-31')).rejects.toThrow(ValidationError);
      await expect(svc.getCashFlow('2026-01-01', '')).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getProfitLoss
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getProfitLoss', () => {
    it('returns profit/loss report for valid date range', async () => {
      const { svc, repo } = createService();
      repo.getProfitLoss.mockResolvedValue(profitLossReport);

      const result = await svc.getProfitLoss('2026-02-01', '2026-02-28');
      expect(repo.getProfitLoss).toHaveBeenCalledWith('2026-02-01', '2026-02-28');
      expect(result).toEqual(profitLossReport);
    });

    it('throws ValidationError for invalid start date', async () => {
      const { svc } = createService();
      await expect(svc.getProfitLoss('2026/01/01', '2026-01-31')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid end date', async () => {
      const { svc } = createService();
      await expect(svc.getProfitLoss('2026-01-01', '31-01-2026')).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getReorderRecommendations
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getReorderRecommendations', () => {
    it('returns reorder recommendations', async () => {
      const { svc, repo } = createService();
      repo.getReorderRecommendations.mockResolvedValue(reorderItems);

      const result = await svc.getReorderRecommendations();
      expect(result).toEqual(reorderItems);
      expect(repo.getReorderRecommendations).toHaveBeenCalled();
    });

    it('returns empty array when nothing to reorder', async () => {
      const { svc, repo } = createService();
      repo.getReorderRecommendations.mockResolvedValue([]);
      expect(await svc.getReorderRecommendations()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getDeadCapital
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getDeadCapital', () => {
    it('returns dead capital items with default threshold', async () => {
      const { svc, repo } = createService();
      repo.getDeadCapital.mockResolvedValue(deadCapital);

      const result = await svc.getDeadCapital();
      expect(repo.getDeadCapital).toHaveBeenCalledWith(90);
      expect(result).toEqual(deadCapital);
    });

    it('passes custom threshold to repo', async () => {
      const { svc, repo } = createService();
      repo.getDeadCapital.mockResolvedValue([]);

      await svc.getDeadCapital(180);
      expect(repo.getDeadCapital).toHaveBeenCalledWith(180);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getInventoryValuation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getInventoryValuation', () => {
    it('returns valuation with empty filters by default', async () => {
      const { svc, repo } = createService();
      repo.getInventoryValuation.mockResolvedValue(valuationResult);

      const result = await svc.getInventoryValuation();
      expect(repo.getInventoryValuation).toHaveBeenCalledWith({});
      expect(result).toEqual(valuationResult);
    });

    it('passes filters to repo', async () => {
      const { svc, repo } = createService();
      repo.getInventoryValuation.mockResolvedValue(valuationResult);

      await svc.getInventoryValuation({ category_id: 1 });
      expect(repo.getInventoryValuation).toHaveBeenCalledWith({ category_id: 1 });
    });
  });
});
