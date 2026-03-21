import { DashboardService } from '@core/services/dashboard.service';
import { createMockReportRepo } from '../../helpers/mocks';

const sampleStats = {
  todaySales: 50000,
  todayTransactions: 12,
  lowStockCount: 3,
  expiringCount: 5,
  openShifts: 1,
};

function createService() {
  const repo = createMockReportRepo();
  const svc  = new DashboardService(repo as any);
  return { svc, repo };
}

describe('DashboardService', () => {
  describe('getStats', () => {
    it('returns dashboard statistics', async () => {
      const { svc, repo } = createService();
      repo.getDashboardStats.mockResolvedValue(sampleStats);

      const result = await svc.getStats();
      expect(repo.getDashboardStats).toHaveBeenCalled();
      expect(result).toEqual(sampleStats);
    });

    it('delegates entirely to report repo', async () => {
      const { svc, repo } = createService();
      const customStats = { todaySales: 0, todayTransactions: 0, lowStockCount: 0, expiringCount: 0 };
      repo.getDashboardStats.mockResolvedValue(customStats);

      const result = await svc.getStats();
      expect(result).toBe(customStats);
    });
  });
});
