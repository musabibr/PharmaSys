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

  async getInventoryReconciliation(): Promise<any[]> {
    return await this.repo.getInventoryReconciliation();
  }

  /**
   * Per-product stock ledger: purchased vs sold vs returned vs adjusted vs
   * on-hand, with a derived Expected and Variance. Lets the owner audit every
   * product and spot discrepancies (e.g. products corrupted by past CF rescales
   * show Variance ≠ 0).
   */
  async getProductStockLedger(): Promise<Array<{
    product_id: number; name: string; parent_unit: string; child_unit: string;
    conversion_factor: number; purchased_base: number; sold_base: number;
    returned_base: number; adjusted_removed_base: number; on_hand_base: number;
    expected_base: number; variance_base: number;
  }>> {
    const rows = await this.repo.getProductStockLedger();
    return rows.map(r => {
      const expected_base = r.purchased_base + r.returned_base - r.sold_base - r.adjusted_removed_base;
      return { ...r, expected_base, variance_base: r.on_hand_base - expected_base };
    });
  }

  /** Drill-down: purchases, sales/returns, and adjustments (with reasons) for one product. */
  async getProductMovements(productId: number) {
    Validate.id(productId);
    return await this.repo.getProductMovements(productId);
  }
}
