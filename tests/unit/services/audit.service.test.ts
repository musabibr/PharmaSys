import { AuditService } from '@core/services/audit.service';
import { createMockAuditRepo } from '../../helpers/mocks';

const sampleLog = {
  id: 1, user_id: 1, action: 'LOGIN', table_name: null,
  record_id: null, old_values: null, new_values: null,
  ip_address: null, created_at: '2026-02-25',
};

function createService() {
  const repo = createMockAuditRepo();
  const svc  = new AuditService(repo as any);
  return { svc, repo };
}

describe('AuditService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('delegates to repo.getAll with filters', async () => {
      const { svc, repo } = createService();
      const page = { data: [sampleLog], total: 1, page: 1, limit: 50, totalPages: 1 };
      repo.getAll.mockResolvedValue(page);

      const result = await svc.getAll({ user_id: 1 });
      expect(repo.getAll).toHaveBeenCalledWith({ user_id: 1 });
      expect(result.data).toHaveLength(1);
    });

    it('returns empty page when no logs match', async () => {
      const { svc, repo } = createService();
      repo.getAll.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });

      const result = await svc.getAll({});
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // purgeOlderThan
  // ═══════════════════════════════════════════════════════════════════════════
  describe('purgeOlderThan', () => {
    it('purges logs older than given days', async () => {
      const { svc, repo } = createService();
      repo.purgeOlderThan.mockResolvedValue(42);

      const deleted = await svc.purgeOlderThan(365);
      expect(repo.purgeOlderThan).toHaveBeenCalledWith(365);
      expect(deleted).toBe(42);
    });

    it('uses 365 days as default', async () => {
      const { svc, repo } = createService();
      repo.purgeOlderThan.mockResolvedValue(0);

      await svc.purgeOlderThan();
      expect(repo.purgeOlderThan).toHaveBeenCalledWith(365);
    });

    it('enforces minimum of 30 days', async () => {
      const { svc, repo } = createService();
      repo.purgeOlderThan.mockResolvedValue(0);

      await svc.purgeOlderThan(5);
      expect(repo.purgeOlderThan).toHaveBeenCalledWith(30);
    });

    it('enforces minimum when value is 0', async () => {
      const { svc, repo } = createService();
      repo.purgeOlderThan.mockResolvedValue(0);

      await svc.purgeOlderThan(0);
      expect(repo.purgeOlderThan).toHaveBeenCalledWith(30);
    });

    it('enforces maximum of 3650 days', async () => {
      const { svc, repo } = createService();
      repo.purgeOlderThan.mockResolvedValue(0);

      await svc.purgeOlderThan(9999);
      expect(repo.purgeOlderThan).toHaveBeenCalledWith(3650);
    });

    it('passes through values within allowed range', async () => {
      const { svc, repo } = createService();
      repo.purgeOlderThan.mockResolvedValue(10);

      await svc.purgeOlderThan(180);
      expect(repo.purgeOlderThan).toHaveBeenCalledWith(180);
    });
  });
});
