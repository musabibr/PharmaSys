import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Loader2,
  Printer,
  TrendingDown,
  TrendingUp,
  BarChart3,
  ShoppingCart,
  RotateCcw,
  FileText,
  Package,
} from 'lucide-react';
import { api } from '@/api';
import { printHtml } from '@/lib/print';
import type { ProfitLossReport } from '@/api/types';
import { formatCurrency, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DailyTrendChart } from './DailyTrendChart';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Return the first day of the current month as YYYY-MM-DD */
function firstOfMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Return today as YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// StatCard (local)
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  variant?: 'default' | 'success' | 'destructive' | 'warning';
  subtitle?: string;
}

function StatCard({ label, value, icon, variant = 'default', subtitle }: StatCardProps) {
  const valueColor: Record<string, string> = {
    default: 'text-foreground',
    success: 'text-emerald-600 dark:text-emerald-400',
    destructive: 'text-red-600 dark:text-red-400',
    warning: 'text-amber-600 dark:text-amber-400',
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div className="text-muted-foreground/60">{icon}</div>
        </div>
        <p className={cn('mt-2 text-2xl font-bold', valueColor[variant])}>
          {value}
        </p>
        {subtitle && (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ProfitLossSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header + date controls skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      {/* Summary cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="h-8 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Chart skeleton */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[350px] w-full" />
        </CardContent>
      </Card>

      {/* Tables skeleton */}
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, j) => (
                  <Skeleton key={j} className="h-10 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Margin badge color
// ---------------------------------------------------------------------------

function marginBgClass(margin: number): string {
  if (margin >= 20) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
  if (margin >= 10) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
}

// ---------------------------------------------------------------------------
// ProfitLossPage
// ---------------------------------------------------------------------------

const ROWS_PER_PAGE = 5;

export function ProfitLossPage() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.dir() === 'rtl';

  // ── Date range state ────────────────────────────────────────────────────
  const [startDate, setStartDate] = useState(firstOfMonth);
  const [endDate, setEndDate] = useState(todayStr);

  // ── Report data state ───────────────────────────────────────────────────
  const [report, setReport] = useState<ProfitLossReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // ── Pagination state ──────────────────────────────────────────────────
  const [productsPage, setProductsPage] = useState(0);
  const [expensesPage, setExpensesPage] = useState(0);

  // ── Fetch report ────────────────────────────────────────────────────────
  const fetchReport = useCallback(async (from: string, to: string) => {
    if (!from || !to) {
      toast.error(t('Please select both start and end dates'));
      return;
    }
    if (from > to) {
      toast.error(t('Start date must be before end date'));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api.reports.profitLoss(from, to);
      setReport(data);
      setHasLoaded(true);
      setProductsPage(0);
      setExpensesPage(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to load report');
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // ── Auto-generate on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetchReport(firstOfMonth(), todayStr());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Computed summaries ──────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (!report) return null;

    const dailyData = Array.isArray(report.dailyData) ? report.dailyData : [];
    const totalSales = dailyData.reduce((sum, d) => sum + d.sales, 0);
    const totalReturns = dailyData.reduce((sum, d) => sum + d.returns, 0);
    const totalProfit = dailyData.reduce((sum, d) => sum + d.profit, 0);
    const dayCount = dailyData.length || 1;
    const avgDailyProfit = Math.round(totalProfit / dayCount);

    return { totalSales, totalReturns, totalProfit, avgDailyProfit, dayCount };
  }, [report]);

  const expenseTotal = useMemo(() => {
    if (!report) return 0;
    const expenses = Array.isArray(report.expensesByCategory) ? report.expensesByCategory : [];
    return expenses.reduce((sum, e) => sum + e.total, 0);
  }, [report]);

  // ── Print handler ───────────────────────────────────────────────────────
  function handlePrint() {
    if (!report) return;

    // Top products table
    const topProductRows = topProducts
      .map((p, i) => {
        const margin = p.revenue > 0
          ? Math.round((p.profit / p.revenue) * 100)
          : 0;
        const marginBadge = margin >= 20
          ? 'badge badge-green'
          : margin >= 10
            ? 'badge badge-yellow'
            : 'badge badge-red';
        return `<tr>
          <td>${i + 1}</td>
          <td>${p.name}</td>
          <td class="num">${p.total_sold}</td>
          <td class="num">${formatCurrency(p.revenue)}</td>
          <td class="num">${formatCurrency(p.profit)}</td>
          <td class="num"><span class="${marginBadge}">${margin}%</span></td>
        </tr>`;
      })
      .join('');

    // Expenses by category table
    const expenseRows = expensesByCategory
      .map((e) => {
        const pct = expenseTotal > 0
          ? Math.round((e.total / expenseTotal) * 100)
          : 0;
        return `<tr>
          <td>${e.category}</td>
          <td class="num">${formatCurrency(e.total)}</td>
          <td class="num">${pct}%</td>
        </tr>`;
      })
      .join('');

    // Daily breakdown table
    const dailyRows = dailyData
      .map((d) => `<tr>
          <td>${d.date}</td>
          <td class="num">${formatCurrency(d.sales)}</td>
          <td class="num">${formatCurrency(d.returns)}</td>
          <td class="num">${formatCurrency(d.profit)}</td>
        </tr>`)
      .join('');

    const html = `
      <div class="header">
        <div>
          <h2>${t('Profit & Loss Report')}</h2>
          <p>${startDate} &mdash; ${endDate}</p>
        </div>
      </div>
      <div class="summary">
        <p><strong>${t('Total Sales')}:</strong> ${formatCurrency(summary?.totalSales ?? 0)}</p>
        <p><strong>${t('Total Returns')}:</strong> ${formatCurrency(summary?.totalReturns ?? 0)}</p>
        <p><strong>${t('Total Profit')}:</strong> ${formatCurrency(summary?.totalProfit ?? 0)}</p>
        <p><strong>${t('Avg Daily Profit')}:</strong> ${formatCurrency(summary?.avgDailyProfit ?? 0)} (${summary?.dayCount ?? 0} ${t('days')})</p>
      </div>
      ${topProducts.length > 0 ? `
        <h3>${t('Top Selling Products')}</h3>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>${t('Product')}</th>
              <th>${t('Units Sold')}</th>
              <th>${t('Revenue')}</th>
              <th>${t('Profit')}</th>
              <th>${t('Margin %')}</th>
            </tr>
          </thead>
          <tbody>${topProductRows}</tbody>
        </table>
      ` : ''}
      ${dailyData.length > 0 ? `
        <h3>${t('Daily Breakdown')}</h3>
        <table>
          <thead>
            <tr>
              <th>${t('Date')}</th>
              <th>${t('Sales')}</th>
              <th>${t('Returns')}</th>
              <th>${t('Profit')}</th>
            </tr>
          </thead>
          <tbody>${dailyRows}</tbody>
        </table>
      ` : ''}
      ${expensesByCategory.length > 0 ? `
        <h3>${t('Expenses by Category')}</h3>
        <table>
          <thead>
            <tr>
              <th>${t('Category')}</th>
              <th>${t('Amount')}</th>
              <th>${t('% of Total')}</th>
            </tr>
          </thead>
          <tbody>${expenseRows}</tbody>
          <tfoot>
            <tr>
              <th>${t('Total')}</th>
              <th>${formatCurrency(expenseTotal)}</th>
              <th>100%</th>
            </tr>
          </tfoot>
        </table>
      ` : ''}
    `;

    printHtml(html);
  }

  // ── Initial state (no report generated yet) ─────────────────────────────
  if (!hasLoaded && !loading && !error) {
    return (
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Profit & Loss')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Analyze revenue, expenses, and profitability over time')}
          </p>
        </div>

        {/* Date range + generate */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('From')}</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('To')}</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
              <Button
                onClick={() => fetchReport(startDate, endDate)}
                className="gap-1.5"
              >
                <BarChart3 className="h-4 w-4" />
                {t('Generate Report')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Invitation to generate */}
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <FileText className="mb-3 h-12 w-12" />
          <p className="text-lg font-medium">{t('Select a date range and generate a report')}</p>
          <p className="mt-1 text-sm">
            {t('The report will show sales, returns, profit trends, top products, and expense breakdown')}
          </p>
        </div>
      </div>
    );
  }

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading) {
    return <ProfitLossSkeleton />;
  }

  // ── Error state (failed to load) ────────────────────────────────────────
  if (error && !report) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Profit & Loss')}</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
          <p className="text-lg font-medium">{error}</p>
          <button
            onClick={() => fetchReport(startDate, endDate)}
            className="mt-4 text-sm text-primary underline hover:no-underline"
          >
            {t('Try again')}
          </button>
        </div>
      </div>
    );
  }

  // ── Guard: report loaded but no data ────────────────────────────────────
  const dailyData = Array.isArray(report?.dailyData) ? report!.dailyData : [];
  const topProducts = Array.isArray(report?.topProducts) ? report!.topProducts : [];
  const expensesByCategory = Array.isArray(report?.expensesByCategory) ? report!.expensesByCategory : [];

  const isEmpty = dailyData.length === 0 && topProducts.length === 0 && expensesByCategory.length === 0;

  return (
    <div className="space-y-6">
      {/* ── Header + Controls ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Profit & Loss')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Analyze revenue, expenses, and profitability over time')}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t('From')}</Label>
            <Input
              type="date"
              className="w-40"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t('To')}</Label>
            <Input
              type="date"
              className="w-40"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <Button
            onClick={() => fetchReport(startDate, endDate)}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <BarChart3 className="h-4 w-4" />
            )}
            {t('Generate Report')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrint}
            disabled={!report}
            className="gap-1.5"
          >
            <Printer className="h-4 w-4" />
            {t('Print Report')}
          </Button>
        </div>
      </div>

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BarChart3 className="mb-3 h-12 w-12" />
          <p className="text-lg font-medium">{t('No data for the selected period')}</p>
          <p className="mt-1 text-sm">
            {t('Try selecting a different date range')}
          </p>
        </div>
      )}

      {/* ── Report content (only if we have data) ──────────────────────────── */}
      {!isEmpty && (
        <>
          {/* ── Summary Cards ──────────────────────────────────────────────── */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-tour="pl-summary">
            <StatCard
              label={t('Total Sales')}
              value={formatCurrency(summary?.totalSales ?? 0)}
              icon={<DollarSign className="h-5 w-5" />}
            />
            <StatCard
              label={t('Total Returns')}
              value={formatCurrency(summary?.totalReturns ?? 0)}
              icon={<RotateCcw className="h-5 w-5" />}
              variant={summary && summary.totalReturns > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label={t('Total Profit')}
              value={formatCurrency(summary?.totalProfit ?? 0)}
              icon={summary && summary.totalProfit >= 0
                ? <TrendingUp className="h-5 w-5" />
                : <TrendingDown className="h-5 w-5" />
              }
              variant={summary && summary.totalProfit >= 0 ? 'success' : 'destructive'}
            />
            <StatCard
              label={t('Avg Daily Profit')}
              value={formatCurrency(summary?.avgDailyProfit ?? 0)}
              subtitle={`${summary?.dayCount ?? 0} ${t('days')}`}
              icon={<BarChart3 className="h-5 w-5" />}
              variant={summary && summary.avgDailyProfit >= 0 ? 'success' : 'destructive'}
            />
          </div>

          {/* ── Daily Trend Chart ──────────────────────────────────────────── */}
          {dailyData.length > 0 && (
            <Card data-tour="pl-chart">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-base">
                    {t('Daily Sales & Profit Trend')}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <DailyTrendChart data={dailyData} />
              </CardContent>
            </Card>
          )}

          {/* ── Visible Tables ─────────────────────────────────────────────── */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* ── Top Products Table ─────────────────────────────────────── */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-base">
                      {t('Top Selling Products')}
                    </CardTitle>
                  </div>
                  {topProducts.length > ROWS_PER_PAGE && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {productsPage * ROWS_PER_PAGE + 1}–{Math.min((productsPage + 1) * ROWS_PER_PAGE, topProducts.length)} / {topProducts.length}
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {topProducts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Package className="mb-2 h-10 w-10" />
                    <p className="text-sm font-medium">{t('No product data')}</p>
                  </div>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>{t('Product')}</TableHead>
                          <TableHead className="text-end">{t('Units Sold')}</TableHead>
                          <TableHead className="text-end">{t('Revenue')}</TableHead>
                          <TableHead className="text-end">{t('Profit')}</TableHead>
                          <TableHead className="text-end">{t('Margin %')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {topProducts.slice(productsPage * ROWS_PER_PAGE, (productsPage + 1) * ROWS_PER_PAGE).map((product, idx) => {
                          const index = productsPage * ROWS_PER_PAGE + idx;
                          const margin = product.revenue > 0
                            ? Math.round((product.profit / product.revenue) * 100)
                            : 0;
                          return (
                            <TableRow key={index}>
                              <TableCell className="text-muted-foreground">
                                {index + 1}
                              </TableCell>
                              <TableCell className="font-medium">
                                {product.name}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {product.total_sold}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatCurrency(product.revenue)}
                              </TableCell>
                              <TableCell className={cn(
                                'text-end tabular-nums font-medium',
                                product.profit >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-red-600 dark:text-red-400'
                              )}>
                                {formatCurrency(product.profit)}
                              </TableCell>
                              <TableCell className="text-end">
                                <span className={cn(
                                  'inline-block rounded-full px-2 py-0.5 text-xs font-semibold',
                                  marginBgClass(margin)
                                )}>
                                  {margin}%
                                </span>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    {topProducts.length > ROWS_PER_PAGE && (
                      <div className="flex items-center justify-end gap-1 pt-3">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          disabled={productsPage === 0}
                          onClick={() => setProductsPage(p => p - 1)}
                        >
                          {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                        </Button>
                        {Array.from({ length: Math.ceil(topProducts.length / ROWS_PER_PAGE) }).map((_, i) => (
                          <Button
                            key={i}
                            variant={i === productsPage ? 'default' : 'outline'}
                            size="icon"
                            className="h-7 w-7 text-xs"
                            onClick={() => setProductsPage(i)}
                          >
                            {i + 1}
                          </Button>
                        ))}
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          disabled={productsPage >= Math.ceil(topProducts.length / ROWS_PER_PAGE) - 1}
                          onClick={() => setProductsPage(p => p + 1)}
                        >
                          {isRtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* ── Expenses by Category Table ──────────────────────────────── */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-base">
                      {t('Expenses by Category')}
                    </CardTitle>
                  </div>
                  {expensesByCategory.length > ROWS_PER_PAGE && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {expensesPage * ROWS_PER_PAGE + 1}–{Math.min((expensesPage + 1) * ROWS_PER_PAGE, expensesByCategory.length)} / {expensesByCategory.length}
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {expensesByCategory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <DollarSign className="mb-2 h-10 w-10" />
                    <p className="text-sm font-medium">{t('No expenses recorded')}</p>
                  </div>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('Category')}</TableHead>
                          <TableHead className="text-end">{t('Amount')}</TableHead>
                          <TableHead className="text-end w-32">{t('% of Total')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {expensesByCategory.slice(expensesPage * ROWS_PER_PAGE, (expensesPage + 1) * ROWS_PER_PAGE).map((expense, index) => {
                          const pct = expenseTotal > 0
                            ? Math.round((expense.total / expenseTotal) * 100)
                            : 0;
                          const pctExact = expenseTotal > 0
                            ? (expense.total / expenseTotal) * 100
                            : 0;
                          return (
                            <TableRow key={index}>
                              <TableCell className="font-medium">
                                {expense.category}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatCurrency(expense.total)}
                              </TableCell>
                              <TableCell className="text-end">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className="h-full rounded-full bg-primary/70 transition-all"
                                      style={{ width: `${Math.max(pctExact, 2)}%` }}
                                    />
                                  </div>
                                  <span className="min-w-[2.5rem] tabular-nums text-sm text-muted-foreground">
                                    {pct}%
                                  </span>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell className="font-bold">{t('Total')}</TableCell>
                          <TableCell className="text-end tabular-nums font-bold">
                            {formatCurrency(expenseTotal)}
                          </TableCell>
                          <TableCell className="text-end">
                            <span className="tabular-nums text-sm font-medium">100%</span>
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                    {expensesByCategory.length > ROWS_PER_PAGE && (
                      <div className="flex items-center justify-end gap-1 pt-3">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          disabled={expensesPage === 0}
                          onClick={() => setExpensesPage(p => p - 1)}
                        >
                          {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                        </Button>
                        {Array.from({ length: Math.ceil(expensesByCategory.length / ROWS_PER_PAGE) }).map((_, i) => (
                          <Button
                            key={i}
                            variant={i === expensesPage ? 'default' : 'outline'}
                            size="icon"
                            className="h-7 w-7 text-xs"
                            onClick={() => setExpensesPage(i)}
                          >
                            {i + 1}
                          </Button>
                        ))}
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-7 w-7"
                          disabled={expensesPage >= Math.ceil(expensesByCategory.length / ROWS_PER_PAGE) - 1}
                          onClick={() => setExpensesPage(p => p + 1)}
                        >
                          {isRtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
