import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BarChart3,
  CreditCard,
  DollarSign,
  Loader2,
  Printer,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { api } from '@/api';
import { printHtml } from '@/lib/print';
import type { CashFlowReport } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WaterfallChart, type WaterfallItem } from './WaterfallChart';

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

/** Format a YYYY-MM-DD string for display */
function formatDateRange(from: string, to: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  const fromStr = new Date(from + 'T00:00:00').toLocaleDateString('en-US', opts);
  const toStr = new Date(to + 'T00:00:00').toLocaleDateString('en-US', opts);
  return `${fromStr} - ${toStr}`;
}

// ---------------------------------------------------------------------------
// Margin helper
// ---------------------------------------------------------------------------

function formatMargin(margin: number): string {
  return `${margin.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// StatCard for the income statement row
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  subtitleColor?: 'default' | 'success' | 'destructive';
}

function StatCard({ label, value, subtitle, icon, subtitleColor = 'default' }: StatCardProps) {
  const subtitleColors: Record<string, string> = {
    default: 'text-muted-foreground',
    success: 'text-emerald-600 dark:text-emerald-400',
    destructive: 'text-destructive',
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div className="text-muted-foreground/60">{icon}</div>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
        {subtitle && (
          <p className={`mt-1 text-xs font-medium ${subtitleColors[subtitleColor]}`}>
            {subtitle}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function CashFlowSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header + filter bar */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-3">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-24" />
          </div>
        </CardContent>
      </Card>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="mb-2 h-8 w-32" />
              <Skeleton className="h-3 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Chart placeholder */}
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-[360px] w-full" />
        </CardContent>
      </Card>

      {/* Breakdown */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <Skeleton className="mb-4 h-5 w-40" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="mb-2 h-6 w-full" />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <Skeleton className="mb-4 h-5 w-40" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="mb-2 h-6 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print helper — builds HTML content and delegates to shared printHtml
// ---------------------------------------------------------------------------

function printCashFlowReport(
  report: CashFlowReport,
  dateFrom: string,
  dateTo: string,
  t: (key: string) => string
) {
  const paymentRows = Array.isArray(report.sales_by_payment)
    ? report.sales_by_payment
        .map((p) => {
          const pct = report.net_sales > 0
            ? ((p.total / report.net_sales) * 100).toFixed(1)
            : '0.0';
          const methodLabel = p.payment_method === 'cash'
            ? t('Cash')
            : p.payment_method === 'bank_transfer'
              ? t('Bank Transfer')
              : p.payment_method;
          return `<tr>
            <td>${methodLabel}</td>
            <td class="num">${p.count}</td>
            <td class="num">${formatCurrency(p.total)}</td>
            <td class="num">${pct}%</td>
          </tr>`;
        })
        .join('')
    : '';

  const html = `
    <div class="header">
      <div>
        <h2>${t('Cash Flow Report')}</h2>
        <p>${formatDateRange(dateFrom, dateTo)}</p>
      </div>
    </div>
    <div class="summary">
      <p><strong>${t('Net Sales')}:</strong> ${formatCurrency(report.net_sales)} (${t('Gross Margin')}: ${formatMargin(report.gross_margin)})</p>
      <p><strong>${t('Cost of Goods')}:</strong> ${formatCurrency(report.cost_of_goods_sold)}</p>
      <p><strong>${t('Gross Profit')}:</strong> ${formatCurrency(report.gross_profit)} (${formatMargin(report.gross_margin)})</p>
      <p><strong>${t('Net Profit')}:</strong> ${formatCurrency(report.net_profit)} (${formatMargin(report.net_margin)})</p>
    </div>
    <h3>${t('Revenue Breakdown')}</h3>
    <div class="summary">
      <p>${t('Cash Sales')}: ${formatCurrency(report.cash_sales)}</p>
      <p>${t('Bank Transfer Sales')}: ${formatCurrency(report.bank_sales)}</p>
      <p><strong>${t('Total Sales')}: ${formatCurrency(report.total_sales)}</strong></p>
      <p>${t('Returns')}: -${formatCurrency(report.total_returns)}</p>
      <p><strong>${t('Net Sales')}: ${formatCurrency(report.net_sales)}</strong></p>
    </div>
    <h3>${t('Expense Breakdown')}</h3>
    <div class="summary">
      <p>${t('Cost of Goods Sold')}: ${formatCurrency(report.cost_of_goods_sold)}</p>
      <p>${t('Operational Expenses')}: ${formatCurrency(report.operational_expenses)}</p>
      <p><strong>${t('Total Expenses')}: ${formatCurrency(report.cost_of_goods_sold + report.operational_expenses)}</strong></p>
    </div>
    <h3>${t('Payment Method Summary')}</h3>
    <table>
      <thead>
        <tr>
          <th>${t('Payment Method')}</th>
          <th>${t('Transactions')}</th>
          <th>${t('Total Amount')}</th>
          <th>${t('% of Sales')}</th>
        </tr>
      </thead>
      <tbody>${paymentRows}</tbody>
    </table>
  `;

  printHtml(html);
}

// ---------------------------------------------------------------------------
// Breakdown row component
// ---------------------------------------------------------------------------

interface BreakdownRowProps {
  label: string;
  value: number;
  bold?: boolean;
  highlight?: boolean;
  negative?: boolean;
}

function BreakdownRow({ label, value, bold, highlight, negative }: BreakdownRowProps) {
  return (
    <div
      className={`flex items-center justify-between py-2 ${
        bold ? 'font-semibold' : ''
      } ${
        highlight
          ? 'rounded-md bg-muted/50 px-3 -mx-3'
          : ''
      }`}
    >
      <span className="text-sm">{label}</span>
      <span
        className={`text-sm tabular-nums ${
          negative ? 'text-destructive' : ''
        } ${bold ? 'font-semibold' : ''}`}
      >
        {negative && value > 0 ? '- ' : ''}
        {formatCurrency(negative ? Math.abs(value) : value)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CashFlowPage
// ---------------------------------------------------------------------------

export function CashFlowPage() {
  const { t } = useTranslation();

  // ── Filter state ─────────────────────────────────────────────────────────
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);

  // ── Data state ──────────────────────────────────────────────────────────
  const [report, setReport] = useState<CashFlowReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);

  // ── Ref for tracking cancelled requests ──────────────────────────────────
  const requestIdRef = useRef(0);

  // ── Fetch report ─────────────────────────────────────────────────────────
  const fetchReport = useCallback(async (from: string, to: string) => {
    if (!from || !to) {
      toast.error(t('Please select a valid date range'));
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const data = await api.reports.cashFlow(from, to);

      // Check for stale response
      if (requestId !== requestIdRef.current) return;

      setReport(data);
      setHasGenerated(true);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const msg = err instanceof Error ? err.message : t('Failed to load report');
      setError(msg);
      toast.error(msg);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [t]);

  // ── Auto-generate on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetchReport(firstOfMonth(), todayStr());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Generate handler ────────────────────────────────────────────────────
  function handleGenerate() {
    fetchReport(dateFrom, dateTo);
  }

  // ── Print handler ───────────────────────────────────────────────────────
  function handlePrint() {
    if (!report) return;
    printCashFlowReport(report, dateFrom, dateTo, t);
  }

  // ── Build waterfall data ─────────────────────────────────────────────────
  function buildWaterfallData(r: CashFlowReport): WaterfallItem[] {
    return [
      { name: t('Total Sales'), value: r.total_sales, type: 'total' },
      { name: t('Returns'), value: -r.total_returns, type: 'negative' },
      { name: t('Net Sales'), value: r.net_sales, type: 'total' },
      { name: t('COGS'), value: -r.cost_of_goods_sold, type: 'negative' },
      { name: t('Gross Profit'), value: r.gross_profit, type: 'total' },
      { name: t('Expenses'), value: -r.operational_expenses, type: 'negative' },
      { name: t('Net Profit'), value: r.net_profit, type: 'total' },
    ];
  }

  // ── Payment method rows ──────────────────────────────────────────────────
  function getPaymentRows(r: CashFlowReport) {
    if (!Array.isArray(r.sales_by_payment)) return [];
    return r.sales_by_payment;
  }

  function formatPaymentMethod(method: string): string {
    if (method === 'cash') return t('Cash');
    if (method === 'bank_transfer') return t('Bank Transfer');
    if (method === 'mixed') return t('Mixed');
    return method;
  }

  // ── Initial / not-yet-generated state ────────────────────────────────────
  if (!hasGenerated && !loading) {
    return (
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Cash Flow Report')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Income statement and cash flow analysis')}
          </p>
        </div>

        {/* Date Filter Card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('From')}</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('To')}</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
              <Button onClick={handleGenerate} className="gap-1.5">
                <BarChart3 className="h-4 w-4" />
                {t('Generate Report')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Empty state */}
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BarChart3 className="mb-3 h-12 w-12" />
          <p className="text-lg font-medium">{t('Select a date range and generate the report')}</p>
          <p className="mt-1 text-sm">
            {t('The default range is the current month')}
          </p>
        </div>
      </div>
    );
  }

  // ── Loading state ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Cash Flow Report')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Income statement and cash flow analysis')}
          </p>
        </div>
        <CashFlowSkeleton />
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────
  if (error || !report) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Cash Flow Report')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Income statement and cash flow analysis')}
          </p>
        </div>

        {/* Date Filter Card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('From')}</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('To')}</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
              <Button onClick={handleGenerate} className="gap-1.5">
                <BarChart3 className="h-4 w-4" />
                {t('Generate Report')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
          <p className="text-lg font-medium">{error ?? t('Failed to load report')}</p>
          <button
            onClick={handleGenerate}
            className="mt-4 text-sm text-primary underline hover:no-underline"
          >
            {t('Try again')}
          </button>
        </div>
      </div>
    );
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const totalExpenses = report.cost_of_goods_sold + report.operational_expenses;
  const waterfallData = buildWaterfallData(report);
  const paymentRows = getPaymentRows(report);
  const grossMarginColor = report.gross_margin >= 0 ? 'success' : 'destructive';
  const netMarginColor = report.net_margin >= 0 ? 'success' : 'destructive';

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Page Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Cash Flow Report')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateRange(dateFrom, dateTo)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5">
          <Printer className="h-4 w-4" />
          {t('Print Report')}
        </Button>
      </div>

      {/* ── Date Filter Card ─────────────────────────────────────────────── */}
      <Card data-tour="report-daterange">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('From')}</Label>
              <Input
                type="date"
                className="w-40"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('To')}</Label>
              <Input
                type="date"
                className="w-40"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
            <Button onClick={handleGenerate} disabled={loading} className="gap-1.5">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <BarChart3 className="h-4 w-4" />
              )}
              {t('Generate Report')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Income Statement Cards (4-up) ─────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-tour="report-summary">
        <StatCard
          label={t('Net Sales')}
          value={formatCurrency(report.net_sales)}
          subtitle={`${t('Gross Margin')}: ${formatMargin(report.gross_margin)}`}
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard
          label={t('Cost of Goods')}
          value={formatCurrency(report.cost_of_goods_sold)}
          icon={<TrendingDown className="h-5 w-5" />}
        />
        <StatCard
          label={t('Gross Profit')}
          value={formatCurrency(report.gross_profit)}
          subtitle={formatMargin(report.gross_margin)}
          subtitleColor={grossMarginColor}
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label={t('Net Profit')}
          value={formatCurrency(report.net_profit)}
          subtitle={formatMargin(report.net_margin)}
          subtitleColor={netMarginColor}
          icon={<CreditCard className="h-5 w-5" />}
        />
      </div>

      {/* ── Waterfall Chart ──────────────────────────────────────────────── */}
      <Card data-tour="report-chart">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">{t('Income Waterfall')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <WaterfallChart data={waterfallData} />
        </CardContent>
      </Card>

      {/* ── Cash Flow Breakdown (two-column grid) ─────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Revenue Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Revenue Breakdown')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <BreakdownRow label={t('Cash Sales')} value={report.cash_sales} />
              <BreakdownRow label={t('Bank Transfer Sales')} value={report.bank_sales} />
              <Separator className="my-2" />
              <BreakdownRow label={t('Total Sales')} value={report.total_sales} bold />
              <BreakdownRow
                label={t('Returns')}
                value={report.total_returns}
                negative
              />
              <Separator className="my-2" />
              <BreakdownRow
                label={t('Net Sales')}
                value={report.net_sales}
                bold
                highlight
              />
            </div>
          </CardContent>
        </Card>

        {/* Expense Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Expense Breakdown')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <BreakdownRow label={t('Cost of Goods Sold')} value={report.cost_of_goods_sold} />
              <BreakdownRow label={t('Operational Expenses')} value={report.operational_expenses} />
              <Separator className="my-2" />
              <BreakdownRow
                label={t('Total Expenses')}
                value={totalExpenses}
                bold
                highlight
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Payment Method Summary Table ───────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">{t('Payment Method Summary')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {paymentRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <CreditCard className="mb-2 h-10 w-10" />
              <p className="text-sm font-medium">{t('No payment data for this period')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Payment Method')}</TableHead>
                  <TableHead className="text-end">{t('Transactions')}</TableHead>
                  <TableHead className="text-end">{t('Total Amount')}</TableHead>
                  <TableHead className="text-end">{t('% of Sales')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentRows.map((row) => {
                  const pct =
                    report.net_sales > 0
                      ? ((row.total / report.net_sales) * 100).toFixed(1)
                      : '0.0';
                  return (
                    <TableRow key={row.payment_method}>
                      <TableCell className="font-medium">
                        {formatPaymentMethod(row.payment_method)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {row.count}
                      </TableCell>
                      <TableCell className="text-end tabular-nums font-medium">
                        {formatCurrency(row.total)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums text-muted-foreground">
                        {pct}%
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
