import type { ReportRepository } from '../repositories/sql/report.repository';
import type { DashboardStats }   from '../types/models';

export class DashboardService {
  constructor(private readonly repo: ReportRepository) {}

  async getStats(): Promise<DashboardStats> {
    return await this.repo.getDashboardStats();
  }
}
