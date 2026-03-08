import { BackupService } from '@core/services/backup.service';
import { createMockBackupRepo, createMockAuditRepo, createMockBus } from '../../helpers/mocks';

const sampleEntry = { filename: 'backup-2026.db', size: 1024, createdAt: '2026-01-01' };

function createService() {
  const backupRepo = createMockBackupRepo();
  const auditRepo  = createMockAuditRepo();
  const bus        = createMockBus();
  const svc        = new BackupService(backupRepo as any, auditRepo as any, bus);
  return { svc, backupRepo, auditRepo, bus };
}

describe('BackupService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('creates backup and returns entry', async () => {
      const { svc, backupRepo } = createService();
      backupRepo.create.mockResolvedValue(sampleEntry);

      const result = await svc.create(1);
      expect(backupRepo.create).toHaveBeenCalled();
      expect(result.filename).toBe('backup-2026.db');
    });

    it('passes optional label to repo', async () => {
      const { svc, backupRepo } = createService();
      backupRepo.create.mockResolvedValue(sampleEntry);

      await svc.create(1, 'pre-upgrade');
      expect(backupRepo.create).toHaveBeenCalledWith('pre-upgrade');
    });

    it('emits MANUAL_BACKUP event', async () => {
      const { svc, backupRepo, bus } = createService();
      backupRepo.create.mockResolvedValue(sampleEntry);

      await svc.create(1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'MANUAL_BACKUP',
        newValues: { filename: 'backup-2026.db', size: 1024 },
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // list
  // ═══════════════════════════════════════════════════════════════════════════
  describe('list', () => {
    it('returns list of backups', async () => {
      const { svc, backupRepo } = createService();
      backupRepo.list.mockResolvedValue([sampleEntry]);

      const result = await svc.list();
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('backup-2026.db');
    });

    it('returns empty array when no backups', async () => {
      const { svc, backupRepo } = createService();
      backupRepo.list.mockResolvedValue([]);
      expect(await svc.list()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // restore
  // ═══════════════════════════════════════════════════════════════════════════
  describe('restore', () => {
    it('restores a valid backup file', async () => {
      const { svc, backupRepo } = createService();
      await svc.restore('backup-2026.db', 1);
      expect(backupRepo.restore).toHaveBeenCalledWith('backup-2026.db');
    });

    it('emits RESTORE_BACKUP event', async () => {
      const { svc, bus } = createService();
      await svc.restore('backup-2026.db', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'RESTORE_BACKUP',
        newValues: { filename: 'backup-2026.db' },
      }));
    });

    it('throws Error for filename with forward slash (path traversal)', async () => {
      const { svc } = createService();
      await expect(svc.restore('../../etc/passwd', 1)).rejects.toThrow('Invalid backup filename');
    });

    it('throws Error for filename with backslash (path traversal)', async () => {
      const { svc } = createService();
      await expect(svc.restore('..\\..\\system', 1)).rejects.toThrow('Invalid backup filename');
    });

    it('throws Error for filename containing double-dot', async () => {
      const { svc } = createService();
      await expect(svc.restore('backup..db', 1)).rejects.toThrow('Invalid backup filename');
    });

    it('does not call repo when filename is invalid', async () => {
      const { svc, backupRepo } = createService();
      try { await svc.restore('../../bad', 1); } catch { /* expected */ }
      expect(backupRepo.restore).not.toHaveBeenCalled();
    });
  });
});
