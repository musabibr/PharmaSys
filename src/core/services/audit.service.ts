import type { AuditRepository } from '../repositories/sql/audit.repository';
import type { AuditLog, AuditLogFilters, PaginatedResult } from '../types/models';
import { Validate } from '../common/validation';

export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  async getAll(filters: AuditLogFilters): Promise<PaginatedResult<AuditLog>> {
    return await this.repo.getAll(filters);
  }

  /** Full audit trail for one product: its own edits + events on its batches (I4). */
  async getProductHistory(productId: number): Promise<AuditLog[]> {
    Validate.id(productId, 'Product');
    return await this.repo.getProductHistory(productId);
  }

  async purgeOlderThan(days = 365): Promise<number> {
    const d = Math.max(30, Math.min(3650, days));
    return await this.repo.purgeOlderThan(d);
  }
}
