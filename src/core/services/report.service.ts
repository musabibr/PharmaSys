import type { ReportRepository }  from '../repositories/sql/report.repository';
import type {
  CashFlowReport, ProfitLossReport,
  ReorderRecommendation, DeadCapitalItem,
  InventoryValuationResult, InventoryValuationFilters,
  PurchaseReport, PurchaseReportFilters,
} from '../types/models';
import { Validate } from '../common/validation';

export class ReportService {
  constructor(private readonly repo: ReportRepository) {}

  async getCashFlow(startDate: string, endDate: string): Promise<CashFlowReport> {
    Validate.dateString(startDate, 'Start date');
    Validate.dateString(endDate,   'End date');
    return await this.repo.getCashFlow(startDate, endDate);
  }

  async getProfitLoss(startDate: string, endDate: string): Promise<ProfitLossReport> {
    Validate.dateString(startDate, 'Start date');
    Validate.dateString(endDate,   'End date');
    return await this.repo.getProfitLoss(startDate, endDate);
  }

  async getReorderRecommendations(): Promise<ReorderRecommendation[]> {
    return await this.repo.getReorderRecommendations();
  }

  async getDeadCapital(daysThreshold = 90): Promise<DeadCapitalItem[]> {
    return await this.repo.getDeadCapital(daysThreshold);
  }

  async getInventoryValuation(filters: InventoryValuationFilters = {}): Promise<InventoryValuationResult> {
    return await this.repo.getInventoryValuation(filters);
  }

  async getPurchaseReport(filters: PurchaseReportFilters): Promise<PurchaseReport> {
    Validate.dateString(filters.start_date, 'Start date');
    Validate.dateString(filters.end_date, 'End date');
    return await this.repo.getPurchaseReport(filters);
  }
}
