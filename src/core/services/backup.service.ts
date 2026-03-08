import type { BackupRepository } from '../repositories/sql/backup.repository';
import type { AuditRepository }  from '../repositories/sql/audit.repository';
import type { EventBus }          from '../events/event-bus';
import type { BackupEntry }       from '../types/repositories';
import { ValidationError }        from '../types/errors';

export class BackupService {
  constructor(
    private readonly repo:  BackupRepository,
    private readonly audit: AuditRepository,
    private readonly bus:   EventBus
  ) {}

  async create(userId: number, label?: string): Promise<BackupEntry> {
    const entry = await this.repo.create(label);
    this.bus.emit('entity:mutated', {
      action: 'MANUAL_BACKUP', table: 'backups',
      recordId: null, userId,
      newValues: { filename: entry.filename, size: entry.size },
    });
    return entry;
  }

  async list(): Promise<BackupEntry[]> {
    return await this.repo.list();
  }

  async restore(filename: string, userId: number): Promise<void> {
    // Sanitize filename (no directory traversal)
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new ValidationError('Invalid backup filename', 'filename');
    }
    await this.repo.restore(filename);
    this.bus.emit('entity:mutated', {
      action: 'RESTORE_BACKUP', table: 'backups',
      recordId: null, userId,
      newValues: { filename },
    });
  }
}
