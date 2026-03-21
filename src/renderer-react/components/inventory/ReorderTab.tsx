import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { ReorderRecommendation } from '@/api/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatQuantity } from '@/lib/utils';
import { printHtml } from '@/lib/print';
import { DataPagination } from '@/components/ui/data-pagination';
import { Button } from '@/components/ui/button';

const PAGE_SIZE = 10;
import {
  AlertTriangle,
  CheckCircle,
  Package,
  Printer,
  Search,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helper: compute days of stock remaining
// ---------------------------------------------------------------------------
function daysLeft(item: ReorderRecommendation): number | null {
  if (item.daily_velocity_base <= 0) return null; // infinite
  return item.current_stock_base / item.daily_velocity_base;
}

// ---------------------------------------------------------------------------
// Helper: urgency level
// ---------------------------------------------------------------------------
function urgencyLevel(item: ReorderRecommendation): 'critical' | 'low' | 'monitor' {
  const days = daysLeft(item);
  if (days === null) {
    // No recent sales — urgency depends on stock vs min_stock_level
    const stockParent = item.conversion_factor > 0
      ? item.current_stock_base / item.conversion_factor
      : item.current_stock_base;
    return stockParent < item.min_stock_level ? 'low' : 'monitor';
  }
  if (days < 3) return 'critical';
  if (days < 7) return 'low';
  return 'monitor';
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------
function ReorderSkeleton() {
  return (
    <div className="space-y-4">
      {/* Summary card */}
      <Card>
        <CardContent className="p-6">
          <Skeleton className="mb-3 h-4 w-32" />
          <Skeleton className="h-8 w-16" />
        </CardContent>
      </Card>
      {/* Search */}
      <Skeleton className="h-9 w-64" />
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
// ReorderTab
// ---------------------------------------------------------------------------
export function ReorderTab() {
  const { t } = useTranslation();

  const [data, setData] = useState<ReorderRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // --- Data fetching ---
  const fetchData = () => {
    setLoading(true);
    setError(null);
    api.reports
      .reorderRecommendations()
      .then((res) => {
        setData(Array.isArray(res) ? res : []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('Failed to load data'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Filtered data ---
  const allItems = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return data;
    return data.filter((item) => item.name.toLowerCase().includes(query));
  }, [data, search]);

  // Reset page when search changes
  useEffect(() => { setPage(1); }, [search]);

  // --- Pagination ---
  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const items = allItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // --- Print handler ---
  const handlePrint = () => {
    if (allItems.length === 0) return;
    const urgencyBadge = (item: ReorderRecommendation) => {
      const days = daysLeft(item);
      const u = urgencyLevel(item);
      const cls = u === 'critical' ? 'badge badge-red' : u === 'low' ? 'badge badge-yellow' : 'badge badge-green';
      const label = u === 'critical' ? t('Critical') : u === 'low' ? t('Low') : t('Monitor');
      return `<span class="${cls}">${label}</span>`;
    };
    const rows = allItems.map((item) => {
      const days = daysLeft(item);
      return `<tr>
        <td>${item.name}</td>
        <td class="num">${formatQuantity(item.current_stock_base, item.parent_unit, item.child_unit, item.conversion_factor)}</td>
        <td class="num">${item.min_stock_level} ${item.parent_unit}</td>
        <td class="num">${item.daily_velocity_base.toFixed(1)} ${item.child_unit}/${t('day')}</td>
        <td class="num">${days === null ? t('No sales') : days.toFixed(1)}</td>
        <td class="num">${item.recommended_order} ${item.parent_unit}</td>
        <td style="text-align:center">${urgencyBadge(item)}</td>
      </tr>`;
    }).join('');

    const html = `
      <div class="header">
        <h2>${t('Reorder Report')}</h2>
        <p>${new Date().toLocaleDateString()}</p>
      </div>
      <div class="summary">
        <p><strong>${t('Items Needing Reorder')}:</strong> ${data.length}</p>
      </div>
      <table>
        <thead><tr>
          <th>${t('Product Name')}</th>
          <th class="num">${t('Current Stock')}</th>
          <th class="num">${t('Min Stock Level')}</th>
          <th class="num">${t('Daily Velocity')}</th>
          <th class="num">${t('Days Left')}</th>
          <th class="num">${t('Recommended Order')}</th>
          <th style="text-align:center">${t('Urgency')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    printHtml(html);
  };

  // --- Loading state ---
  if (loading) return <ReorderSkeleton />;

  // --- Error state ---
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">{error}</p>
        <button
          onClick={fetchData}
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
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <CheckCircle className="mb-2 h-10 w-10 text-emerald-500" />
        <p className="text-sm font-medium">{t('All items are well-stocked')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-1">
      {/* ── Summary Card ───────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">
              {t('Items Needing Reorder')}
            </p>
            <div className="text-muted-foreground/60">
              <Package className="h-5 w-5" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-bold text-destructive">
            {data.length}
          </p>
        </CardContent>
      </Card>

      {/* ── Search + Print ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('Search products...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={handlePrint} disabled={allItems.length === 0}>
          <Printer className="me-2 h-4 w-4" />
          {t('Print')}
        </Button>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <div className="rounded-md border">
        <Table className="sticky-col">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>{t('Product Name')}</TableHead>
              <TableHead className="text-end">{t('Current Stock')}</TableHead>
              <TableHead className="hidden lg:table-cell text-end">{t('Min Stock Level')}</TableHead>
              <TableHead className="text-end">{t('Daily Velocity')}</TableHead>
              <TableHead className="text-end">{t('Days Left')}</TableHead>
              <TableHead className="text-end">{t('Recommended Order')}</TableHead>
              <TableHead className="text-center">{t('Urgency')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  {t('No products match your search')}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item, idx) => {
                const days = daysLeft(item);
                const urgency = urgencyLevel(item);

                const badgeVariant: Record<string, 'destructive' | 'warning' | 'default'> = {
                  critical: 'destructive',
                  low: 'warning',
                  monitor: 'default',
                };

                const badgeLabel: Record<string, string> = {
                  critical: t('Critical'),
                  low: t('Low'),
                  monitor: t('Monitor'),
                };

                return (
                  <TableRow key={item.id}>
                    <TableCell className="text-center text-muted-foreground">{(safePage - 1) * PAGE_SIZE + idx + 1}</TableCell>
                    <TableCell className="font-medium truncate max-w-[180px]">{item.name}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatQuantity(
                        item.current_stock_base,
                        item.parent_unit,
                        item.child_unit,
                        item.conversion_factor
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-end tabular-nums">
                      {item.min_stock_level} {item.parent_unit}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {item.daily_velocity_base.toFixed(1)} {item.child_unit}/{t('day')}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {days === null ? t('No sales') : days.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {item.recommended_order} {item.parent_unit}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant={badgeVariant[urgency]}>
                        {badgeLabel[urgency]}
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
