import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { DeadCapitalItem } from '@/api/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { printHtml } from '@/lib/print';
import { DataPagination } from '@/components/ui/data-pagination';
import { usePermission } from '@/hooks/usePermission';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  CheckCircle,
  Printer,
  Skull,
  Search,
  Wallet,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const THRESHOLD_OPTIONS = [30, 60, 90, 180, 365] as const;
const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Helper: format a date string concisely
// ---------------------------------------------------------------------------
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Helper: format days as human-readable duration
// ---------------------------------------------------------------------------
function formatDuration(days: number, t: (key: string) => string): string {
  if (days <= 0) return '\u2014';
  if (days < 30) return `${days} ${t('days')}`;
  const months = Math.floor(days / 30);
  const remainDays = days % 30;
  if (months < 12) {
    return remainDays > 0
      ? `${months} ${t('months')} ${remainDays} ${t('days')}`
      : `${months} ${t('months')}`;
  }
  const years = Math.floor(months / 12);
  const remainMonths = months % 12;
  return remainMonths > 0
    ? `${years} ${t('years')} ${remainMonths} ${t('months')}`
    : `${years} ${t('years')}`;
}

// ---------------------------------------------------------------------------
// Helper: risk level
// ---------------------------------------------------------------------------
function riskLevel(item: DeadCapitalItem): 'high' | 'medium' | 'low' {
  if (!item.last_sold || item.days_since_sale > 180) return 'high';
  if (item.days_since_sale > 90) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// StatCard (local, matches DashboardPage pattern)
// ---------------------------------------------------------------------------
interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'destructive';
}

function StatCard({ label, value, icon, variant = 'default' }: StatCardProps) {
  const valueColor: Record<string, string> = {
    default: 'text-foreground',
    success: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-amber-600 dark:text-amber-400',
    destructive: 'text-destructive',
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          {icon && <div className="text-muted-foreground/60">{icon}</div>}
        </div>
        <p className={`mt-2 text-2xl font-bold ${valueColor[variant]}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------
function DeadCapitalSkeleton() {
  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="h-8 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      {/* Controls */}
      <div className="flex gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-36" />
      </div>
      {/* Table rows */}
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeadCapitalTab
// ---------------------------------------------------------------------------
export function DeadCapitalTab() {
  const { t } = useTranslation();
  const canViewCosts = usePermission('inventory.view_costs');

  const [data, setData] = useState<DeadCapitalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [threshold, setThreshold] = useState(90);
  const [page, setPage] = useState(1);

  // --- Data fetching ---
  const fetchData = useCallback((days: number) => {
    setLoading(true);
    setError(null);
    api.reports
      .deadCapital(days)
      .then((res) => {
        setData(Array.isArray(res) ? res : []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('Failed to load data'));
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    fetchData(threshold);
  }, [threshold, fetchData]);

  // --- Filtered data ---
  const allItems = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return data;
    return data.filter((item) => item.name.toLowerCase().includes(query));
  }, [data, search]);

  // Reset page when search/threshold changes
  useEffect(() => { setPage(1); }, [search, threshold]);

  // --- Pagination ---
  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const items = allItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // --- Totals ---
  const totalValue = useMemo(
    () => data.reduce((sum, item) => sum + item.stock_value, 0),
    [data]
  );

  // --- Print handler ---
  const handlePrint = () => {
    if (allItems.length === 0) return;
    const riskBadge = (item: DeadCapitalItem) => {
      const r = riskLevel(item);
      const cls = r === 'high' ? 'badge badge-red' : r === 'medium' ? 'badge badge-yellow' : 'badge badge-green';
      const label = r === 'high' ? t('High') : r === 'medium' ? t('Medium') : t('Low');
      return `<span class="${cls}">${label}</span>`;
    };
    const valueHeader = canViewCosts ? `<th class="num">${t('Stock Value')}</th>` : '';
    const rows = allItems.map((item) => {
      const valueTd = canViewCosts ? `<td class="num">${formatCurrency(item.stock_value)}</td>` : '';
      return `<tr>
        <td>${item.name}</td>
        <td>${item.last_sold ? formatDate(item.last_sold) : t('Never')}</td>
        <td class="num">${item.last_sold ? item.days_since_sale : '\u2014'}</td>
        <td>${formatDuration(item.days_in_inventory, t)}</td>
        <td class="num">${formatQuantity(item.stock_quantity, item.parent_unit, item.child_unit, item.conversion_factor)}</td>
        ${valueTd}
        <td style="text-align:center">${riskBadge(item)}</td>
      </tr>`;
    }).join('');

    const summaryParts = [`<p><strong>${t('Dead Capital Items')}:</strong> ${data.length}</p>`];
    if (canViewCosts) {
      summaryParts.push(`<p><strong>${t('Total Value at Risk')}:</strong> ${formatCurrency(totalValue)}</p>`);
    }
    summaryParts.push(`<p><strong>${t('Threshold')}:</strong> ${threshold} ${t('days')}</p>`);

    const html = `
      <div class="header">
        <h2>${t('Dead Capital Report')}</h2>
        <p>${new Date().toLocaleDateString()}</p>
      </div>
      <div class="summary">${summaryParts.join('')}</div>
      <table>
        <thead><tr>
          <th>${t('Product Name')}</th>
          <th>${t('Last Sold')}</th>
          <th class="num">${t('Days Since Sale')}</th>
          <th>${t('In Stock Since')}</th>
          <th class="num">${t('Stock Quantity')}</th>
          ${valueHeader}
          <th style="text-align:center">${t('Risk Level')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    printHtml(html);
  };

  // --- Loading state ---
  if (loading) return <DeadCapitalSkeleton />;

  // --- Error state ---
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">{error}</p>
        <button
          onClick={() => fetchData(threshold)}
          className="mt-4 text-sm text-primary underline hover:no-underline"
        >
          {t('Try again')}
        </button>
      </div>
    );
  }

  // --- Empty state ---
  if (data.length === 0) {
    return (
      <div className="space-y-4 p-1">
        {/* Keep the threshold selector visible even when empty */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('Threshold')}:</span>
          <Select
            value={String(threshold)}
            onValueChange={(val) => setThreshold(Number(val))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THRESHOLD_OPTIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} {t('days')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <CheckCircle className="mb-2 h-10 w-10 text-emerald-500" />
          <p className="text-sm font-medium">
            {t('No dead capital items found')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-1">
      {/* ── Summary Cards ──────────────────────────────────────────────── */}
      <div className={`grid gap-4 ${canViewCosts ? 'sm:grid-cols-2' : 'sm:grid-cols-1'}`}>
        <StatCard
          label={t('Dead Capital Items')}
          value={data.length}
          icon={<Skull className="h-5 w-5" />}
        />
        {canViewCosts && (
          <StatCard
            label={t('Total Value at Risk')}
            value={formatCurrency(totalValue)}
            icon={<Wallet className="h-5 w-5" />}
            variant="destructive"
          />
        )}
      </div>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('Search products...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('Threshold')}:</span>
          <Select
            value={String(threshold)}
            onValueChange={(val) => setThreshold(Number(val))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THRESHOLD_OPTIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} {t('days')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={handlePrint} disabled={allItems.length === 0}>
          <Printer className="me-2 h-4 w-4" />
          {t('Print')}
        </Button>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>{t('Product Name')}</TableHead>
              <TableHead>{t('Last Sold')}</TableHead>
              <TableHead className="text-end">{t('Days Since Sale')}</TableHead>
              <TableHead>{t('In Stock Since')}</TableHead>
              <TableHead className="text-end">{t('Stock Quantity')}</TableHead>
              {canViewCosts && (
                <TableHead className="text-end">{t('Stock Value')}</TableHead>
              )}
              <TableHead className="text-center">{t('Risk Level')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canViewCosts ? 8 : 7} className="h-24 text-center text-muted-foreground">
                  {t('No products match your search')}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item, idx) => {
                const risk = riskLevel(item);

                const badgeVariant: Record<string, 'destructive' | 'warning' | 'default'> = {
                  high: 'destructive',
                  medium: 'warning',
                  low: 'default',
                };

                const badgeLabel: Record<string, string> = {
                  high: t('High'),
                  medium: t('Medium'),
                  low: t('Low'),
                };

                return (
                  <TableRow key={item.id}>
                    <TableCell className="text-center text-muted-foreground">{(safePage - 1) * PAGE_SIZE + idx + 1}</TableCell>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.last_sold ? formatDate(item.last_sold) : t('Never')}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {item.last_sold ? item.days_since_sale : '\u2014'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDuration(item.days_in_inventory, t)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatQuantity(
                        item.stock_quantity,
                        item.parent_unit,
                        item.child_unit,
                        item.conversion_factor
                      )}
                    </TableCell>
                    {canViewCosts && (
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(item.stock_value)}
                      </TableCell>
                    )}
                    <TableCell className="text-center">
                      <Badge variant={badgeVariant[risk]}>
                        {badgeLabel[risk]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Pagination ─────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <DataPagination
          page={safePage}
          totalPages={totalPages}
          total={allItems.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
