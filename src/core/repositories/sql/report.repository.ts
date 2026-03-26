import type { BaseRepository } from './base.repository';
import type { IReportRepository } from '../../types/repositories';
import type {
  CashFlowReport, ProfitLossReport, ReorderRecommendation,
  DeadCapitalItem, InventoryValuationResult, InventoryValuationFilters,
  DashboardStats, PurchaseReport, PurchaseReportFilters,
} from '../../types/models';

/**
 * Consistent cost-per-child SQL fragment.
 * Priority: override (if > 0) → pre-calculated child → parent / cf fallback.
 */
const COST_PER_CHILD_SQL = `COALESCE(
  NULLIF(b.cost_per_child_override, 0),
  b.cost_per_child,
  CASE WHEN p.conversion_factor > 0
       THEN CAST(b.cost_per_parent / p.conversion_factor AS INTEGER)
       ELSE b.cost_per_parent END)`;

/**
 * Consistent selling-price-per-child SQL fragment.
 * Priority: override (if > 0) → pre-calculated child → parent / cf fallback.
 */
const SELL_PER_CHILD_SQL = `COALESCE(
  NULLIF(b.selling_price_child_override, 0),
  b.selling_price_child,
  CASE WHEN p.conversion_factor > 0
       THEN CAST(b.selling_price_parent / p.conversion_factor AS INTEGER)
       ELSE b.selling_price_parent END)`;

export class ReportRepository implements IReportRepository {
  constructor(
    private readonly base: BaseRepository,
    private readonly getSettingFn: (key: string) => Promise<string | null>
  ) {}

  async getCashFlow(startDate: string, endDate: string): Promise<CashFlowReport> {
    // CTE 1: Transaction totals + COGS in a single query (replaces 8 sequential queries)
    const txn = await this.base.getOne<{
      sale_total: number; return_total: number; cash_sales: number;
      cash_returns: number; bank_sales: number; sale_cogs: number; return_cogs: number;
    }>(
      `WITH txn_totals AS (
        SELECT
          COALESCE(SUM(CASE WHEN transaction_type='sale' THEN total_amount ELSE 0 END), 0) as sale_total,
          COALESCE(SUM(CASE WHEN transaction_type='return' THEN total_amount ELSE 0 END), 0) as return_total,
          COALESCE(SUM(CASE WHEN transaction_type='sale' THEN cash_tendered ELSE 0 END), 0) as cash_sales,
          COALESCE(SUM(CASE WHEN transaction_type='return' THEN cash_tendered ELSE 0 END), 0) as cash_returns,
          COALESCE(SUM(CASE WHEN transaction_type='sale' AND payment_method='bank_transfer' THEN total_amount ELSE 0 END), 0) as bank_sales
        FROM transactions
        WHERE is_voided = 0
          AND DATE(created_at) BETWEEN ? AND ?
      ),
      cogs_totals AS (
        SELECT
          COALESCE(SUM(CASE WHEN t.transaction_type='sale' THEN ti.cost_price * ti.quantity_base ELSE 0 END), 0) as sale_cogs,
          COALESCE(SUM(CASE WHEN t.transaction_type='return' THEN ti.cost_price * ti.quantity_base ELSE 0 END), 0) as return_cogs
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.is_voided = 0
          AND DATE(t.created_at) BETWEEN ? AND ?
      )
      SELECT * FROM txn_totals, cogs_totals`,
      [startDate, endDate, startDate, endDate]
    );

    // CTE 2: Expense totals in a single query (replaces 3 sequential queries)
    const exp = await this.base.getOne<{
      total_expenses: number; cash_expenses: number; bank_expenses: number;
    }>(
      `SELECT
        COALESCE(SUM(amount), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN payment_method = 'cash' OR payment_method IS NULL THEN amount ELSE 0 END), 0) as cash_expenses,
        COALESCE(SUM(CASE WHEN payment_method = 'bank_transfer' THEN amount ELSE 0 END), 0) as bank_expenses
       FROM expenses
       WHERE expense_date BETWEEN ? AND ?
         AND id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)`,
      [startDate, endDate]
    );

    // Query 3: Sales by payment method (GROUP BY — must be separate)
    const salesByPayment = await this.base.getAll<{ payment_method: string; total: number; count: number }>(
      `SELECT payment_method, COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
       FROM transactions
       WHERE DATE(created_at) BETWEEN ? AND ? AND is_voided = 0 AND transaction_type = 'sale'
       GROUP BY payment_method ORDER BY total DESC`,
      [startDate, endDate]
    );

    const totalSales   = Math.round(txn?.sale_total   ?? 0);
    const totalReturns = Math.round(txn?.return_total  ?? 0);
    const netSales     = Math.round(totalSales - totalReturns);
    const totalCogs    = Math.round((txn?.sale_cogs ?? 0) - (txn?.return_cogs ?? 0));
    const grossProfit  = Math.round(netSales - totalCogs);
    const totalExp     = Math.round(exp?.total_expenses ?? 0);
    const netProfit    = Math.round(grossProfit - totalExp);

    return {
      total_sales:          totalSales,
      total_returns:        totalReturns,
      net_sales:            netSales,
      cost_of_goods_sold:   totalCogs,
      gross_profit:         grossProfit,
      gross_margin:         netSales > 0 ? Math.round((grossProfit / netSales) * 100) : 0,
      operational_expenses: totalExp,
      supplier_payments:    0,
      net_profit:           netProfit,
      net_margin:           netSales > 0 ? Math.round((netProfit / netSales) * 100) : 0,
      cash_sales:           Math.round(txn?.cash_sales   ?? 0),
      bank_sales:           Math.round(txn?.bank_sales   ?? 0),
      cash_returns:         Math.round(txn?.cash_returns  ?? 0),
      cash_expenses:        Math.round(exp?.cash_expenses ?? 0),
      bank_expenses:        Math.round(exp?.bank_expenses ?? 0),
      sales_by_payment:     salesByPayment,
    };
  }

  async getProfitLoss(startDate: string, endDate: string): Promise<ProfitLossReport> {
    const dailyData = await this.base.getAll<{
      date: string; sales: number; returns: number; profit: number;
    }>(
      `SELECT DATE(t.created_at) as date,
              COALESCE(SUM(CASE WHEN t.transaction_type='sale'   THEN t.total_amount ELSE 0 END), 0) as sales,
              COALESCE(SUM(CASE WHEN t.transaction_type='return' THEN t.total_amount ELSE 0 END), 0) as returns,
              COALESCE(SUM(ti.gross_profit), 0) as profit
       FROM transactions t
       JOIN transaction_items ti ON t.id = ti.transaction_id
       WHERE t.is_voided = 0
         AND DATE(t.created_at) BETWEEN ? AND ?
       GROUP BY DATE(t.created_at) ORDER BY date`,
      [startDate, endDate]
    );

    const expensesByCategory = await this.base.getAll<{ category: string; total: number }>(
      `SELECT ec.name as category, SUM(e.amount) as total
       FROM expenses e JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.expense_date BETWEEN ? AND ?
         AND e.id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)
       GROUP BY e.category_id ORDER BY total DESC`,
      [startDate, endDate]
    );

    const topProducts = await this.base.getAll<{ name: string; total_sold: number; revenue: number; profit: number }>(
      `SELECT p.name, SUM(ti.quantity_base) as total_sold,
              SUM(ti.line_total) as revenue, SUM(ti.gross_profit) as profit
       FROM transaction_items ti
       JOIN products p ON ti.product_id = p.id
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE DATE(t.created_at) BETWEEN ? AND ? AND t.is_voided = 0 AND t.transaction_type = 'sale'
       GROUP BY ti.product_id ORDER BY revenue DESC LIMIT 20`,
      [startDate, endDate]
    );

    return { dailyData, expensesByCategory, topProducts };
  }

  async getReorderRecommendations(): Promise<ReorderRecommendation[]> {
    return await this.base.getAll<ReorderRecommendation>(`
      WITH velocity AS (
        SELECT ti.product_id, SUM(ti.quantity_base) / 30.0 as daily_velocity_base
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.is_voided = 0 AND t.transaction_type = 'sale'
          AND t.created_at >= datetime('now', '-30 days')
        GROUP BY ti.product_id
      )
      SELECT p.id, p.name, p.parent_unit, p.child_unit, p.conversion_factor,
             p.min_stock_level,
             COALESCE(SUM(b.quantity_base), 0) as current_stock_base,
             COALESCE(v.daily_velocity_base, 0) as daily_velocity_base,
             MAX(0, COALESCE(
               CASE WHEN COALESCE(v.daily_velocity_base, 0) > 0
                    THEN CAST((COALESCE(v.daily_velocity_base, 0) * 14 - COALESCE(SUM(b.quantity_base), 0))
                         / COALESCE(NULLIF(p.conversion_factor, 0), 1) AS INTEGER)
                    ELSE p.min_stock_level - CAST(COALESCE(SUM(b.quantity_base), 0)
                         / COALESCE(NULLIF(p.conversion_factor, 0), 1) AS INTEGER)
               END, 0)) as recommended_order
      FROM products p
      LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0 AND b.status = 'active'
      LEFT JOIN velocity v ON v.product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.id
      HAVING COALESCE(SUM(b.quantity_base), 0) <= (p.min_stock_level * COALESCE(NULLIF(p.conversion_factor, 0), 1))
         OR (COALESCE(v.daily_velocity_base, 0) > 0
             AND COALESCE(SUM(b.quantity_base), 0) / COALESCE(v.daily_velocity_base, 0) <= 14)
      ORDER BY CASE WHEN COALESCE(v.daily_velocity_base, 0) > 0
                    THEN COALESCE(SUM(b.quantity_base), 0) / v.daily_velocity_base
                    ELSE 9999 END ASC
    `);
  }

  async getDeadCapital(daysThreshold: number): Promise<DeadCapitalItem[]> {
    const days = Math.max(1, Math.min(365, daysThreshold));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');

    return await this.base.getAll<DeadCapitalItem>(`
      WITH last_sale AS (
        SELECT ti.product_id, MAX(t.created_at) as last_sold
        FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.is_voided = 0 AND t.transaction_type = 'sale'
        GROUP BY ti.product_id
      )
      SELECT p.id, p.name, p.parent_unit, p.child_unit, p.conversion_factor,
             COALESCE(SUM(b.quantity_base), 0) as stock_quantity,
             COALESCE(SUM(b.quantity_base * ${COST_PER_CHILD_SQL}), 0) as stock_value,
             ls.last_sold,
             CAST(JULIANDAY('now', 'localtime') - JULIANDAY(COALESCE(ls.last_sold, '2000-01-01')) AS INTEGER) as days_since_sale,
             MIN(b.created_at) as oldest_batch_date,
             CAST(JULIANDAY('now', 'localtime') - JULIANDAY(COALESCE(MIN(b.created_at), datetime('now', 'localtime'))) AS INTEGER) as days_in_inventory
      FROM products p
      LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0 AND b.status = 'active'
      LEFT JOIN last_sale ls ON ls.product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.id
      HAVING COALESCE(SUM(b.quantity_base), 0) > 0
         AND (ls.last_sold IS NULL OR ls.last_sold < ?)
      ORDER BY stock_value DESC
    `, [cutoffStr]);
  }

  async getInventoryValuation(filters: InventoryValuationFilters): Promise<InventoryValuationResult> {
    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(5000, filters.limit ?? 50);
    const offset = (page - 1) * limit;
    const conditions: string[] = ['p.is_active = 1'];
    const params: unknown[] = [];

    if (filters.category_id) { conditions.push('p.category_id = ?');                      params.push(filters.category_id); }
    if (filters.search) {
      const like = `%${filters.search}%`;
      conditions.push(`(p.name LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const data = await this.base.getAll<{
      product_id: number; name: string; category_id: number | null; category_name: string | null;
      parent_unit: string; child_unit: string; conversion_factor: number;
      total_stock_base: number; cost_value: number; retail_value: number; batch_count: number;
    }>(`
      SELECT p.id as product_id, p.name, p.category_id, c.name as category_name,
             p.parent_unit, p.child_unit, p.conversion_factor,
             COALESCE(SUM(b.quantity_base), 0) as total_stock_base,
             COALESCE(SUM(b.quantity_base * ${COST_PER_CHILD_SQL}), 0) as cost_value,
             COALESCE(SUM(b.quantity_base * ${SELL_PER_CHILD_SQL}), 0) as retail_value,
             COUNT(b.id) as batch_count
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0 AND b.status = 'active'
      ${where}
      GROUP BY p.id
      HAVING total_stock_base > 0
      ORDER BY cost_value DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const totalsRow = await this.base.getOne<{ total: number; total_cost: number; total_retail: number }>(`
      SELECT COUNT(*) as total,
             COALESCE(SUM(cost_value), 0) as total_cost,
             COALESCE(SUM(retail_value), 0) as total_retail
      FROM (
        SELECT p.id,
               COALESCE(SUM(b.quantity_base * ${COST_PER_CHILD_SQL}), 0) as cost_value,
               COALESCE(SUM(b.quantity_base * ${SELL_PER_CHILD_SQL}), 0) as retail_value
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0 AND b.status = 'active'
        ${where} GROUP BY p.id HAVING COALESCE(SUM(b.quantity_base), 0) > 0
      )
    `, [...params]);

    return {
      data,
      total: totalsRow?.total ?? 0,
      page,
      limit,
      total_cost:   totalsRow?.total_cost ?? 0,
      total_retail:  totalsRow?.total_retail ?? 0,
    };
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const expiryDays = parseInt(await this.getSettingFn('expiry_warning_days') ?? '90', 10) || 90;
    const exp = new Date(now.getFullYear(), now.getMonth(), now.getDate() + expiryDays);
    const expiryDate = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}`;

    // CTE 1: All transaction aggregates (today + 30-day) in one query (replaces 4 queries)
    const txn = await this.base.getOne<{
      today_sales: number; today_returns: number; today_count: number;
      month_sales: number; month_returns: number; month_count: number;
    }>(
      `WITH today_txn AS (
        SELECT
          COALESCE(SUM(CASE WHEN transaction_type='sale' THEN total_amount ELSE 0 END), 0) as today_sales,
          COALESCE(SUM(CASE WHEN transaction_type='return' THEN total_amount ELSE 0 END), 0) as today_returns,
          COUNT(CASE WHEN transaction_type='sale' THEN 1 END) as today_count
        FROM transactions WHERE is_voided = 0
          AND DATE(created_at) = ?
      ),
      month_txn AS (
        SELECT
          COALESCE(SUM(CASE WHEN transaction_type='sale' THEN total_amount ELSE 0 END), 0) as month_sales,
          COALESCE(SUM(CASE WHEN transaction_type='return' THEN total_amount ELSE 0 END), 0) as month_returns,
          COUNT(CASE WHEN transaction_type='sale' THEN 1 END) as month_count
        FROM transactions WHERE is_voided = 0
          AND DATE(created_at) BETWEEN ? AND ?
      )
      SELECT * FROM today_txn, month_txn`,
      [today, monthStart, today]
    );

    // CTE 2: All inventory/alert stats in one query (replaces 5 queries)
    const inv = await this.base.getOne<{
      inv_cost: number; inv_retail: number; low_stock_count: number;
      expiring_count: number; expired_count: number; open_shifts: number;
    }>(`
      WITH inv_val AS (
        SELECT
          COALESCE(SUM(b.quantity_base * ${COST_PER_CHILD_SQL}), 0) as inv_cost,
          COALESCE(SUM(b.quantity_base * ${SELL_PER_CHILD_SQL}), 0) as inv_retail
        FROM batches b
        JOIN products p ON b.product_id = p.id
        WHERE b.quantity_base > 0 AND b.status = 'active' AND p.is_active = 1
      ),
      low_stock AS (
        SELECT COUNT(*) as low_stock_count FROM (
          SELECT p.id FROM products p
          LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0
          WHERE p.is_active = 1
          GROUP BY p.id
          HAVING COALESCE(SUM(b.quantity_base), 0) <= (p.min_stock_level * COALESCE(NULLIF(p.conversion_factor, 0), 1))
             AND p.min_stock_level > 0
        )
      ),
      expiring AS (
        SELECT COUNT(*) as expiring_count FROM batches b JOIN products p ON b.product_id = p.id
        WHERE b.quantity_base > 0 AND b.status = 'active'
          AND b.expiry_date <= ? AND b.expiry_date > ? AND p.is_active = 1
      ),
      expired AS (
        SELECT COUNT(*) as expired_count FROM batches b JOIN products p ON b.product_id = p.id
        WHERE b.quantity_base > 0 AND b.status = 'active'
          AND b.expiry_date <= ? AND p.is_active = 1
      ),
      open_shifts AS (
        SELECT COUNT(*) as open_shifts FROM shifts WHERE status = 'open'
      )
      SELECT * FROM inv_val, low_stock, expiring, expired, open_shifts
    `, [expiryDate, today, today]);

    const tSales   = Math.round(txn?.today_sales ?? 0);
    const tReturns = Math.round(txn?.today_returns ?? 0);
    const mSales   = Math.round(txn?.month_sales ?? 0);
    const mReturns = Math.round(txn?.month_returns ?? 0);

    return {
      today_sales:           tSales,
      today_returns:         tReturns,
      today_net_sales:       tSales - tReturns,
      today_transactions:    txn?.today_count ?? 0,
      month_sales:           mSales,
      month_returns:         mReturns,
      month_net_sales:       mSales - mReturns,
      month_transactions:    txn?.month_count ?? 0,
      inventory_cost_value:  Math.round(inv?.inv_cost ?? 0),
      inventory_retail_value: Math.round(inv?.inv_retail ?? 0),
      low_stock_count:       inv?.low_stock_count ?? 0,
      expiring_soon_count:   inv?.expiring_count ?? 0,
      expired_count:         inv?.expired_count ?? 0,
      open_shifts:           inv?.open_shifts ?? 0,
    };
  }

  async getPurchaseReport(filters: PurchaseReportFilters): Promise<PurchaseReport> {
    const conditions: string[] = ['p.purchase_date BETWEEN ? AND ?'];
    const params: unknown[] = [filters.start_date, filters.end_date];

    if (filters.supplier_id) {
      conditions.push('p.supplier_id = ?');
      params.push(filters.supplier_id);
    }
    if (filters.payment_status) {
      conditions.push('p.payment_status = ?');
      params.push(filters.payment_status);
    }

    const where = conditions.join(' AND ');

    // Summary
    const summary = await this.base.getOne<{
      total_purchases: number;
      total_amount: number;
      total_paid: number;
      paid_count: number;
      partial_count: number;
      unpaid_count: number;
    }>(
      `SELECT
         COUNT(*) as total_purchases,
         COALESCE(SUM(p.total_amount), 0) as total_amount,
         COALESCE(SUM(p.total_paid), 0) as total_paid,
         COUNT(CASE WHEN p.payment_status = 'paid' THEN 1 END) as paid_count,
         COUNT(CASE WHEN p.payment_status = 'partial' THEN 1 END) as partial_count,
         COUNT(CASE WHEN p.payment_status = 'unpaid' THEN 1 END) as unpaid_count
       FROM purchases p
       WHERE ${where}`,
      params
    );

    // Detail list
    const purchases = await this.base.getAll<{
      id: number;
      purchase_number: string;
      purchase_date: string;
      supplier_name: string | null;
      invoice_reference: string | null;
      total_amount: number;
      total_paid: number;
      payment_status: string;
      item_count: number;
      created_by: string;
    }>(
      `SELECT
         p.id, p.purchase_number, p.purchase_date,
         s.name as supplier_name, p.invoice_reference,
         p.total_amount, p.total_paid, p.payment_status,
         (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) as item_count,
         u.username as created_by
       FROM purchases p
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       LEFT JOIN users u ON p.user_id = u.id
       WHERE ${where}
       ORDER BY p.purchase_date DESC, p.id DESC`,
      params
    );

    const s = summary ?? {
      total_purchases: 0, total_amount: 0, total_paid: 0,
      paid_count: 0, partial_count: 0, unpaid_count: 0,
    };

    return {
      total_purchases: s.total_purchases,
      total_amount: s.total_amount,
      total_paid: s.total_paid,
      total_outstanding: s.total_amount - s.total_paid,
      paid_count: s.paid_count,
      partial_count: s.partial_count,
      unpaid_count: s.unpaid_count,
      purchases: purchases as PurchaseReport['purchases'],
    };
  }
}
