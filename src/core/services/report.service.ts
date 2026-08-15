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
   * show Variance ≠ 0). Paginated + filtered server-side — loading the whole
   * catalogue's reconciliation math (several correlated subqueries per
   * product) in one shot doesn't scale past a few hundred products.
   */
  async getProductStockLedger(opts: {
    page?: number; limit?: number; search?: string; onlyVariance?: boolean;
  } = {}): Promise<{
    data: Array<{
      product_id: number; name: string; parent_unit: string; child_unit: string;
      conversion_factor: number; purchased_base: number; sold_base: number;
      returned_base: number; adjusted_removed_base: number; on_hand_base: number;
      expected_base: number; variance_base: number;
    }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    varianceCount: number;
  }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 25));
    const result = await this.repo.getProductStockLedger({
      page, limit, search: opts.search, onlyVariance: opts.onlyVariance,
    });
    return {
      ...result, page, limit,
      totalPages: Math.max(1, Math.ceil(result.total / limit)),
    };
  }

  /** Drill-down: purchases, sales/returns, and adjustments (with reasons) for one product. */
  async getProductMovements(productId: number) {
    Validate.id(productId);
    return await this.repo.getProductMovements(productId);
  }
}
