import type { BaseRepository } from './base.repository';
import type { IReportRepository } from '../../types/repositories';
import type {
  CashFlowReport, ProfitLossReport, ReorderRecommendation,
  DeadCapitalItem, InventoryValuationResult, InventoryValuationFilters,
  DashboardStats, PurchaseReport, PurchaseReportFilters,
} from '../../types/models';
import { TODAY_SQL } from '../../common/expiry';

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

/**
 * A batch counts as "sellable" the same way everywhere it's asked (E1): the
 * Dashboard's stock/expiry alert counts already used this exact filter,
 * while Inventory Valuation and the Reorder/Dead-Capital reports counted
 * ANY batch with quantity_base > 0 — including expired and quarantined
 * stock, booked as a sellable asset at full retail. Shared here so the
 * definition can't drift apart between reports again.
 */
const SELLABLE_BATCH_SQL = `b.status = 'active' AND b.expiry_date >= ${TODAY_SQL}`;

export class ReportRepository implements IReportRepository {
  constructor(
    private readonly base: BaseRepository,
    private readonly getSettingFn: (key: string) => Promise<string | null>
  ) {}

  /**
   * Per-product stock reconciliation ledger (base units), paginated and
   * filtered server-side. Purchased is summed from purchase invoices
   * (quantity_received × current CF); sold/returned from non-voided
   * transactions; adjusted_removed is the net removed via inventory
   * adjustments (convention: quantity_base > 0 = removed); on_hand from
   * batches. Correlated subqueries prevent join fan-out.
   *
   * Expected/Variance are computed in SQL (not the service) specifically so
   * `onlyVariance` can filter on them and LIMIT/OFFSET only run the
   * per-product subquery set for one page of products instead of the whole
   * catalogue — the previous unpaginated version ran ~5 correlated
   * subqueries per product for every product on every load.
   */
  async getProductStockLedger(opts: {
    page: number; limit: number; search?: string; onlyVariance?: boolean;
  }): Promise<{
    data: Array<{
      product_id: number; name: string; parent_unit: string; child_unit: string;
      conversion_factor: number; purchased_base: number; sold_base: number;
      returned_base: number; adjusted_removed_base: number; on_hand_base: number;
      expected_base: number; variance_base: number;
    }>;
    total: number;
    varianceCount: number;
  }> {
    const page = Math.max(1, opts.page);
    const limit = Math.min(200, Math.max(1, opts.limit));
    const offset = (page - 1) * limit;

    const searchWhere = opts.search?.trim() ? 'AND name LIKE ?' : '';
    const searchParam = opts.search?.trim() ? [`%${opts.search.trim()}%`] : [];
    const varianceWhere = opts.onlyVariance ? 'AND variance_base != 0' : '';

    const ledgerCte = `
      WITH raw AS (
        SELECT
          p.id AS product_id, p.name, p.parent_unit, p.child_unit,
          COALESCE(NULLIF(p.conversion_factor, 0), 1) AS conversion_factor,
          COALESCE((SELECT SUM(pi.quantity_received) FROM purchase_items pi
                    WHERE pi.product_id = p.id), 0)
            * COALESCE(NULLIF(p.conversion_factor, 0), 1) AS purchased_base,
          COALESCE((SELECT SUM(ti.quantity_base) FROM transaction_items ti
                    JOIN transactions t ON ti.transaction_id = t.id
                    WHERE ti.product_id = p.id AND t.transaction_type = 'sale'
                      AND t.is_voided = 0), 0) AS sold_base,
          COALESCE((SELECT SUM(ti.quantity_base) FROM transaction_items ti
                    JOIN transactions t ON ti.transaction_id = t.id
                    WHERE ti.product_id = p.id AND t.transaction_type = 'return'
                      AND t.is_voided = 0), 0) AS returned_base,
          COALESCE((SELECT SUM(ia.quantity_base) FROM inventory_adjustments ia
                    WHERE ia.product_id = p.id), 0) AS adjusted_removed_base,
          COALESCE((SELECT SUM(bt.quantity_base) FROM batches bt
                    WHERE bt.product_id = p.id), 0) AS on_hand_base
        FROM products p
        WHERE p.is_active = 1
      ),
      ledger AS (
        SELECT *,
          (purchased_base + returned_base - sold_base - adjusted_removed_base) AS expected_base,
          (on_hand_base - (purchased_base + returned_base - sold_base - adjusted_removed_base)) AS variance_base
        FROM raw
      )`;

    // Combined into a single pass over the ledger CTE — total (matching the
    // current search/variance filter) and varianceCount (always catalog-wide,
    // independent of the search box) used to each run their own SELECT over
    // the same correlated-subquery CTE, doubling the cost for no reason.
    const searchCond = opts.search?.trim() ? 'name LIKE ?' : '1=1';
    const varianceCond = opts.onlyVariance ? 'variance_base != 0' : '1=1';
    const countsRow = await this.base.getOne<{ total: number; variance_total: number }>(
      `${ledgerCte}
       SELECT
         SUM(CASE WHEN ${searchCond} AND ${varianceCond} THEN 1 ELSE 0 END) as total,
         SUM(CASE WHEN variance_base != 0 THEN 1 ELSE 0 END) as variance_total
       FROM ledger`,
      [...searchParam]
    );

    const data = await this.base.getAll<{
      product_id: number; name: string; parent_unit: string; child_unit: string;
      conversion_factor: number; purchased_base: number; sold_base: number;
      returned_base: number; adjusted_removed_base: number; on_hand_base: number;
      expected_base: number; variance_base: number;
    }>(
      `${ledgerCte}
       SELECT * FROM ledger WHERE 1=1 ${searchWhere} ${varianceWhere}
       ORDER BY name
       LIMIT ? OFFSET ?`,
      [...searchParam, limit, offset]
    );

    return { data, total: countsRow?.total ?? 0, varianceCount: countsRow?.variance_total ?? 0 };
  }

  /**
   * Full movement history for one product (drill-down from the Stock Ledger):
   * every purchase, every sale/return, and every inventory adjustment (with its
   * reason, e.g. "Manual batch quantity edit") that explains stock changes.
   */
  async getProductMovements(productId: number): Promise<{
    purchases: Array<{
      purchase_number: string; invoice_reference: string | null; purchase_date: string;
      supplier_name: string | null; quantity_received: number; cost_per_parent: number;
      line_total: number; expiry_date: string | null; batch_number: string | null;
    }>;
    sales: Array<{
      transaction_number: string; transaction_type: string; created_at: string;
      is_voided: number; quantity_base: number; unit_type: string;
      unit_price: number; line_total: number;
    }>;
    adjustments: Array<{
      created_at: string; type: string; reason: string | null;
      quantity_base: number; batch_id: number | null; username: string | null;
    }>;
  }> {
    const purchases = await this.base.getAll<{
      purchase_number: string; invoice_reference: string | null; purchase_date: string;
      supplier_name: string | null; quantity_received: number; cost_per_parent: number;
      line_total: number; expiry_date: string | null; batch_number: string | null;
    }>(
      `SELECT pu.purchase_number, pu.invoice_reference, pu.purchase_date,
              s.name AS supplier_name, pi.quantity_received, pi.cost_per_parent,
              pi.line_total, pi.expiry_date, pi.batch_number
       FROM purchase_items pi
       JOIN purchases pu ON pi.purchase_id = pu.id
       LEFT JOIN suppliers s ON pu.supplier_id = s.id
       WHERE pi.product_id = ?
       ORDER BY pu.purchase_date DESC, pu.id DESC`,
      [productId]
    );
    const sales = await this.base.getAll<{
      transaction_number: string; transaction_type: string; created_at: string;
      is_voided: number; quantity_base: number; unit_type: string;
      unit_price: number; line_total: number;
    }>(
      `SELECT t.transaction_number, t.transaction_type, t.created_at, t.is_voided,
              ti.quantity_base, ti.unit_type, ti.unit_price, ti.line_total
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE ti.product_id = ? AND t.transaction_type IN ('sale','return')
       ORDER BY t.created_at DESC, t.id DESC`,
      [productId]
    );
    const adjustments = await this.base.getAll<{
      created_at: string; type: string; reason: string | null;
      quantity_base: number; batch_id: number | null; username: string | null;
    }>(
      `SELECT ia.created_at, ia.type, ia.reason, ia.quantity_base, ia.batch_id, u.username
       FROM inventory_adjustments ia
       LEFT JOIN users u ON ia.user_id = u.id
       WHERE ia.product_id = ?
       ORDER BY ia.created_at DESC, ia.id DESC`,
      [productId]
    );
    return { purchases, sales, adjustments };
  }

  async getCashFlow(startDate: string, endDate: string): Promise<CashFlowReport> {
    // CTE 1: Transaction totals (from transactions table only — no JOIN inflation)
    // CTE 2: COGS totals — fix unit mismatch: cost_price is per-display-unit,
    //   so for parent sales divide quantity_base by CF to get display qty.
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
          COALESCE(SUM(CASE WHEN transaction_type='sale' AND payment_method='bank_transfer' THEN total_amount
                        WHEN transaction_type='sale' AND payment_method='mixed' THEN total_amount - COALESCE(cash_tendered, 0)
                        ELSE 0 END), 0) as bank_sales
        FROM transactions
        WHERE is_voided = 0
          AND DATE(created_at) BETWEEN ? AND ?
      ),
      cogs_totals AS (
        SELECT
          COALESCE(SUM(CASE WHEN t.transaction_type='sale' THEN
            CASE WHEN ti.unit_type='parent'
              THEN ti.cost_price * ti.quantity_base / ti.conversion_factor_snapshot
              ELSE ti.cost_price * ti.quantity_base END
          ELSE 0 END), 0) as sale_cogs,
          COALESCE(SUM(CASE WHEN t.transaction_type='return' THEN
            CASE WHEN ti.unit_type='parent'
              THEN ti.cost_price * ti.quantity_base / ti.conversion_factor_snapshot
              ELSE ti.cost_price * ti.quantity_base END
          ELSE 0 END), 0) as return_cogs
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.is_voided = 0
          AND DATE(t.created_at) BETWEEN ? AND ?
      )
      SELECT * FROM txn_totals, cogs_totals`,
      [startDate, endDate, startDate, endDate]
    );

    // Expense totals (excluding purchase-linked expenses)
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

    // Sales by payment method (GROUP BY — must be separate)
    const salesByPayment = await this.base.getAll<{ payment_method: string; total: number; count: number }>(
      `SELECT payment_method, COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
       FROM transactions
       WHERE DATE(created_at) BETWEEN ? AND ? AND is_voided = 0 AND transaction_type = 'sale'
       GROUP BY payment_method ORDER BY total DESC`,
      [startDate, endDate]
    );

    const totalSales      = Math.round(txn?.sale_total   ?? 0);
    const totalReturns    = Math.round(txn?.return_total  ?? 0);
    const netSales        = Math.round(totalSales - totalReturns);
    const totalCogs       = Math.round((txn?.sale_cogs ?? 0) - (txn?.return_cogs ?? 0));
    const grossProfit     = Math.round(netSales - totalCogs);
    const totalExp        = Math.round(exp?.total_expenses ?? 0);
    const netProfit       = Math.round(grossProfit - totalExp);

    return {
      total_sales:          totalSales,
      total_returns:        totalReturns,
      net_sales:            netSales,
      cost_of_goods_sold:   totalCogs,
      gross_profit:         grossProfit,
      gross_margin:         netSales > 0 ? Math.round((grossProfit / netSales) * 100) : 0,
      operational_expenses: totalExp,
      supplier_payments:    0, // Already included in COGS via batch cost_per_parent
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
    // Use two sub-selects to avoid JOIN inflation:
    // - sales/returns come from transactions (1 row per txn)
    // - profit comes from transaction_items (1 row per item, SUM is correct)
    const dailyData = await this.base.getAll<{
      date: string; sales: number; returns: number; profit: number;
    }>(
      `SELECT
         d.date,
         COALESCE(txn.sales, 0) as sales,
         COALESCE(txn.returns, 0) as returns,
         COALESCE(items.profit, 0) as profit
       FROM (
         SELECT DISTINCT DATE(created_at) as date
         FROM transactions
         WHERE is_voided = 0 AND DATE(created_at) BETWEEN ? AND ?
       ) d
       LEFT JOIN (
         SELECT DATE(created_at) as date,
           SUM(CASE WHEN transaction_type='sale' THEN total_amount ELSE 0 END) as sales,
           SUM(CASE WHEN transaction_type='return' THEN total_amount ELSE 0 END) as returns
         FROM transactions
         WHERE is_voided = 0 AND DATE(created_at) BETWEEN ? AND ?
         GROUP BY DATE(created_at)
       ) txn ON d.date = txn.date
       LEFT JOIN (
         SELECT DATE(t.created_at) as date, SUM(ti.gross_profit) as profit
         FROM transaction_items ti
         JOIN transactions t ON ti.transaction_id = t.id
         WHERE t.is_voided = 0 AND DATE(t.created_at) BETWEEN ? AND ?
         GROUP BY DATE(t.created_at)
       ) items ON d.date = items.date
       ORDER BY d.date`,
      [startDate, endDate, startDate, endDate, startDate, endDate]
    );

    const expensesByCategory = await this.base.getAll<{ category: string; total: number }>(
      `SELECT ec.name as category, SUM(e.amount) as total
       FROM expenses e JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.expense_date BETWEEN ? AND ?
         AND e.id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)
       GROUP BY e.category_id ORDER BY total DESC`,
      [startDate, endDate]
    );

    // E4: line_total/gross_profit are the PRE-checkout-discount figures.
    // checkout_discount_allocation exists precisely to attribute the
    // order-level discount back to each line and wasn't being subtracted —
    // a product sold mostly in heavily-discounted baskets looked more
    // profitable than it actually was.
    const topProducts = await this.base.getAll<{ name: string; total_sold: number; revenue: number; profit: number }>(
      `SELECT p.name, SUM(ti.quantity_base) as total_sold,
              SUM(ti.line_total - COALESCE(ti.checkout_discount_allocation, 0)) as revenue,
              SUM(ti.gross_profit - COALESCE(ti.checkout_discount_allocation, 0)) as profit
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
    // E2: expired/quarantined stock used to count as "on hand" here, so a
    // product whose entire stock expired last month looked fully stocked
    // and was never recommended for reorder — it silently went out of
    // stock on the shelf with no warning. Also, velocity was always
    // SUM(sold in last 30 days) / 30 regardless of how long the product has
    // actually been stocked, so a product introduced 3 days ago got a
    // velocity ~10x too low (its true daily rate divided by a 30-day window
    // it wasn't even stocked for). Divide by the actual number of days
    // stocked instead, capped at 30 and floored at 1.
    const daysStockedSql = `MAX(1, MIN(30, CAST(JULIANDAY('now','localtime') - JULIANDAY(p.created_at) AS INTEGER)))`;
    return await this.base.getAll<ReorderRecommendation>(`
      WITH velocity AS (
        SELECT ti.product_id, SUM(ti.quantity_base) as sold_base_30d
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.is_voided = 0 AND t.transaction_type = 'sale'
          AND t.created_at >= datetime('now', '-30 days')
        GROUP BY ti.product_id
      )
      SELECT p.id, p.name, p.parent_unit, p.child_unit, p.conversion_factor,
             p.min_stock_level,
             COALESCE(SUM(b.quantity_base), 0) as current_stock_base,
             (COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql}) as daily_velocity_base,
             MAX(0, COALESCE(
               CASE WHEN (COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql}) > 0
                    THEN CAST(((COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql}) * 14 - COALESCE(SUM(b.quantity_base), 0))
                         / COALESCE(NULLIF(p.conversion_factor, 0), 1) AS INTEGER)
                    ELSE p.min_stock_level - CAST(COALESCE(SUM(b.quantity_base), 0)
                         / COALESCE(NULLIF(p.conversion_factor, 0), 1) AS INTEGER)
               END, 0)) as recommended_order
      FROM products p
      LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0 AND ${SELLABLE_BATCH_SQL}
      LEFT JOIN velocity v ON v.product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.id
      HAVING COALESCE(SUM(b.quantity_base), 0) <= (p.min_stock_level * COALESCE(NULLIF(p.conversion_factor, 0), 1))
         OR ((COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql}) > 0
             AND COALESCE(SUM(b.quantity_base), 0) / (COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql}) <= 14)
      ORDER BY CASE WHEN (COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql}) > 0
                    THEN COALESCE(SUM(b.quantity_base), 0) / (COALESCE(v.sold_base_30d, 0) * 1.0 / ${daysStockedSql})
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
      -- E2: expired/quarantined stock isn't "dead capital" (slow-moving,
      -- still sellable if it moved) — it's already a realized write-off, a
      -- different problem entirely (surfaced separately in Inventory
      -- Valuation's unsellable_cost_value). Without this filter it inflated
      -- stock_value and hid which products are genuinely just slow to sell.
      LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0 AND ${SELLABLE_BATCH_SQL}
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

    // E1: cost_value/retail_value now count only SELLABLE stock (matching
    // the Dashboard's definition exactly) instead of any batch with
    // quantity_base > 0 — the old query booked expired and quarantined
    // stock as a full-value asset, and disagreed with the Dashboard's total
    // for the same moment. total_stock_base stays a RAW count across every
    // status so a product whose entire stock has expired still appears in
    // the report (with $0 sellable value) instead of silently vanishing —
    // its write-off exposure is now visible via unsellable_cost_value/
    // unsellable_retail_value rather than hidden by a HAVING filter.
    const data = await this.base.getAll<{
      product_id: number; name: string; category_id: number | null; category_name: string | null;
      parent_unit: string; child_unit: string; conversion_factor: number;
      total_stock_base: number; cost_value: number; retail_value: number;
      unsellable_cost_value: number; unsellable_retail_value: number; batch_count: number;
    }>(`
      SELECT p.id as product_id, p.name, p.category_id, c.name as category_name,
             p.parent_unit, p.child_unit, p.conversion_factor,
             COALESCE(SUM(b.quantity_base), 0) as total_stock_base,
             COALESCE(SUM(CASE WHEN ${SELLABLE_BATCH_SQL} THEN b.quantity_base * ${COST_PER_CHILD_SQL} ELSE 0 END), 0) as cost_value,
             COALESCE(SUM(CASE WHEN ${SELLABLE_BATCH_SQL} THEN b.quantity_base * ${SELL_PER_CHILD_SQL} ELSE 0 END), 0) as retail_value,
             COALESCE(SUM(CASE WHEN NOT (${SELLABLE_BATCH_SQL}) THEN b.quantity_base * ${COST_PER_CHILD_SQL} ELSE 0 END), 0) as unsellable_cost_value,
             COALESCE(SUM(CASE WHEN NOT (${SELLABLE_BATCH_SQL}) THEN b.quantity_base * ${SELL_PER_CHILD_SQL} ELSE 0 END), 0) as unsellable_retail_value,
             COUNT(b.id) as batch_count
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0
      ${where}
      GROUP BY p.id
      HAVING total_stock_base > 0
      ORDER BY cost_value DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const totalsRow = await this.base.getOne<{
      total: number; total_cost: number; total_retail: number;
      total_unsellable_cost: number; total_unsellable_retail: number;
    }>(`
      SELECT COUNT(*) as total,
             COALESCE(SUM(cost_value), 0) as total_cost,
             COALESCE(SUM(retail_value), 0) as total_retail,
             COALESCE(SUM(unsellable_cost_value), 0) as total_unsellable_cost,
             COALESCE(SUM(unsellable_retail_value), 0) as total_unsellable_retail
      FROM (
        SELECT p.id,
               COALESCE(SUM(CASE WHEN ${SELLABLE_BATCH_SQL} THEN b.quantity_base * ${COST_PER_CHILD_SQL} ELSE 0 END), 0) as cost_value,
               COALESCE(SUM(CASE WHEN ${SELLABLE_BATCH_SQL} THEN b.quantity_base * ${SELL_PER_CHILD_SQL} ELSE 0 END), 0) as retail_value,
               COALESCE(SUM(CASE WHEN NOT (${SELLABLE_BATCH_SQL}) THEN b.quantity_base * ${COST_PER_CHILD_SQL} ELSE 0 END), 0) as unsellable_cost_value,
               COALESCE(SUM(CASE WHEN NOT (${SELLABLE_BATCH_SQL}) THEN b.quantity_base * ${SELL_PER_CHILD_SQL} ELSE 0 END), 0) as unsellable_retail_value
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0
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
      total_unsellable_cost:  totalsRow?.total_unsellable_cost ?? 0,
      total_unsellable_retail: totalsRow?.total_unsellable_retail ?? 0,
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
        WHERE b.quantity_base > 0 AND ${SELLABLE_BATCH_SQL} AND p.is_active = 1
      ),
      low_stock AS (
        SELECT COUNT(*) as low_stock_count FROM (
          SELECT p.id FROM products p
          LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0
            AND ${SELLABLE_BATCH_SQL}
          WHERE p.is_active = 1
          GROUP BY p.id
          HAVING COALESCE(SUM(b.quantity_base), 0) <= (p.min_stock_level * COALESCE(NULLIF(p.conversion_factor, 0), 1))
             AND p.min_stock_level > 0
        )
      ),
      expiring AS (
        SELECT COUNT(*) as expiring_count FROM batches b JOIN products p ON b.product_id = p.id
        WHERE b.quantity_base > 0 AND b.status IN ('active', 'quarantine')
          AND b.expiry_date <= ? AND b.expiry_date > ? AND p.is_active = 1
      ),
      expired AS (
        SELECT COUNT(*) as expired_count FROM batches b JOIN products p ON b.product_id = p.id
        WHERE b.quantity_base > 0 AND b.status IN ('active', 'quarantine')
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

  async getInventoryReconciliation(): Promise<any[]> {
    return await this.base.getAll(`
      WITH 
      PurchaseTotals AS (
        -- E3: conversion_factor_snapshot is the CF that was actually true
        -- when each purchase happened, not today's — SalesTotals already
        -- uses quantity_base, which was computed at sale time from
        -- transaction_items' own snapshot. Using the live products.cf here
        -- instead made any later CF change (B2) permanently desync the two
        -- sides, producing a phantom variance no physical count could clear.
        SELECT pi.product_id, SUM(pi.quantity_received * COALESCE(NULLIF(pi.conversion_factor_snapshot, 0), 1)) as qty
        FROM purchase_items pi
        GROUP BY pi.product_id
      ),
      SalesTotals AS (
        SELECT product_id, SUM(quantity_base) as qty
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.transaction_type = 'sale' AND t.is_voided = 0
        GROUP BY product_id
      ),
      ReturnsTotals AS (
        SELECT product_id, SUM(quantity_base) as qty
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.transaction_type = 'return' AND t.is_voided = 0
        GROUP BY product_id
      ),
      AdjustmentsTotals AS (
        SELECT product_id, 
          SUM(-quantity_base) as qty
        FROM inventory_adjustments
        GROUP BY product_id
      ),
      ActualTotals AS (
        SELECT product_id, SUM(quantity_base) as qty
        FROM batches
        GROUP BY product_id
      )
      SELECT
        p.id as product_id,
        p.name as product_name,
        p.parent_unit as parent_unit,
        p.child_unit as child_unit,
        COALESCE(NULLIF(p.conversion_factor, 0), 1) as conversion_factor,
        COALESCE(pt.qty, 0) as purchased,
        COALESCE(st.qty, 0) as sold,
        COALESCE(rt.qty, 0) as returned,
        COALESCE(adt.qty, 0) as adjustments,
        (COALESCE(pt.qty, 0) - COALESCE(st.qty, 0) + COALESCE(rt.qty, 0) + COALESCE(adt.qty, 0)) as expected_qty,
        COALESCE(act.qty, 0) as actual_qty,
        COALESCE(act.qty, 0) - (COALESCE(pt.qty, 0) - COALESCE(st.qty, 0) + COALESCE(rt.qty, 0) + COALESCE(adt.qty, 0)) as variance
      FROM products p
      LEFT JOIN PurchaseTotals pt ON p.id = pt.product_id
      LEFT JOIN SalesTotals st ON p.id = st.product_id
      LEFT JOIN ReturnsTotals rt ON p.id = rt.product_id
      LEFT JOIN AdjustmentsTotals adt ON p.id = adt.product_id
      LEFT JOIN ActualTotals act ON p.id = act.product_id
      WHERE variance != 0
      ORDER BY ABS(variance) DESC
    `);
  }
}
