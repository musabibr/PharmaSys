import type { AuditRepository } from '../repositories/sql/audit.repository';
import type { AuditLog, AuditLogFilters, PaginatedResult } from '../types/models';

export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  async getAll(filters: AuditLogFilters): Promise<PaginatedResult<AuditLog>> {
    return await this.repo.getAll(filters);
  }

  async purgeOlderThan(days = 365): Promise<number> {
    const d = Math.max(30, Math.min(3650, days));
    return await this.repo.purgeOlderThan(d);
  }
}
