import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { Batch } from '@/api/types';
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  AlertTriangle,
  Calendar,
  Clock,
  Info,
  Package,
  Printer,
  Search,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePermission } from '@/hooks/usePermission';
import { printHtml } from '@/lib/print';
import { DataPagination } from '@/components/ui/data-pagination';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 10;

type UrgencyBucket = 'expired' | '1-30' | '31-60' | '61-90';

/** Calculate days until expiry (negative = expired). */
function daysUntilExpiry(expiryDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate + 'T00:00:00');
  return Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/** Classify a batch into an urgency bucket (or null if > 90 days). */
function getUrgencyBucket(daysLeft: number): UrgencyBucket | null {
  if (daysLeft <= 0) return 'expired';
  if (daysLeft <= 30) return '1-30';
  if (daysLeft <= 60) return '31-60';
  if (daysLeft <= 90) return '61-90';
  return null;
}

/** Format the expiry date for display. */
function formatExpiry(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ExpiryTabSkeleton() {
  return (
    <div className="space-y-6 p-4">
      {/* Summary cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={`card-skel-${i}`}>
            <CardContent className="p-6">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="mb-2 h-8 w-16" />
              <Skeleton className="h-3 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter bar skeleton */}
      <div className="flex gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-40" />
      </div>

      {/* Table skeleton */}
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={`row-skel-${i}`} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Package className="mb-3 h-12 w-12 text-muted-foreground/40" />
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExpiryTab
// ---------------------------------------------------------------------------

export function ExpiryTab() {
  const { t } = useTranslation();
  const canViewCosts = usePermission('inventory.view_costs');

  // ── State ──────────────────────────────────────────────────────────────

  const [allBatches, setAllBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<string>('all');
  const [page, setPage] = useState(1);

  // ── Data fetching ──────────────────────────────────────────────────────

  function fetchData() {
    setLoading(true);
    setError(null);

    Promise.all([
      api.batches.getExpired(),
      api.batches.getExpiring(90),
    ])
      .then(([expiredData, expiringData]) => {
        const expired = Array.isArray(expiredData) ? expiredData : [];
        const expiring = Array.isArray(expiringData) ? expiringData : [];

        // Combine and deduplicate by batch id (expired may overlap with expiring)
        const batchMap = new Map<number, Batch>();
        for (const b of expired) {
          batchMap.set(b.id, b);
        }
        for (const b of expiring) {
          if (!batchMap.has(b.id)) {
            batchMap.set(b.id, b);
          }
        }

        // Sort by expiry_date ASC
        const combined = Array.from(batchMap.values()).sort(
          (a, b) => new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime()
        );

        setAllBatches(combined);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('Failed to load expiry data'));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived: buckets for summary cards ─────────────────────────────────

  const bucketCounts = useMemo(() => {
    const counts = { expired: 0, '1-30': 0, '31-60': 0, '61-90': 0 };
    for (const batch of allBatches) {
      const days = daysUntilExpiry(batch.expiry_date);
      const bucket = getUrgencyBucket(days);
      if (bucket) {
        counts[bucket]++;
      }
    }
    return counts;
  }, [allBatches]);

  // ── Derived: filtered list ─────────────────────────────────────────────

  const filteredBatches = useMemo(() => {
    let result = allBatches;

    // Urgency filter
    if (urgencyFilter !== 'all') {
      result = result.filter((batch) => {
        const days = daysUntilExpiry(batch.expiry_date);
        const bucket = getUrgencyBucket(days);
        return bucket === urgencyFilter;
      });
    }

    // Search filter (product name, client-side)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((batch) => {
        const name = (batch.product_name ?? '').toLowerCase();
        return name.includes(q);
      });
    }

    return result;
  }, [allBatches, urgencyFilter, searchQuery]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [searchQuery, urgencyFilter]);

  // ── Pagination ──────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(filteredBatches.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedBatches = filteredBatches.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ── Print handler ──────────────────────────────────────────────────────

  function handlePrint() {
    if (filteredBatches.length === 0) return;

    const today = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    const rows = filteredBatches
      .map((batch) => {
        const days = daysUntilExpiry(batch.expiry_date);
        const bucket = getUrgencyBucket(days);

        let statusLabel = '';
        let badgeClass = '';
        if (days <= 0) {
          statusLabel =
            days === 0
              ? t('Expired') + ' \u2014 ' + t('Expires today')
              : t('Expired') + ` (${Math.abs(days)}d)`;
          badgeClass = 'badge badge-red';
        } else if (bucket === '1-30') {
          statusLabel = t('Expiring Soon') + ` (${days}d)`;
          badgeClass = 'badge badge-red';
        } else if (bucket === '31-60') {
          statusLabel = t('Expiring Soon') + ` (${days}d)`;
          badgeClass = 'badge badge-yellow';
        } else {
          statusLabel = t('OK') + ` (${days}d)`;
          badgeClass = 'badge badge-green';
        }

        const cf = batch.conversion_factor ?? 1;
        const costPerBase = cf > 1
          ? (batch.cost_per_child_override || batch.cost_per_child || Math.ceil(batch.cost_per_parent / cf))
          : batch.cost_per_parent;
        const costValue = batch.quantity_base * costPerBase;

        const stock = formatQuantity(
          batch.quantity_base,
          batch.parent_unit ?? 'unit',
          batch.child_unit ?? 'pc',
          batch.conversion_factor ?? 1
        );

        return `<tr>
          <td>${batch.product_name ?? '#' + batch.product_id}</td>
          <td>${batch.batch_number ?? '\u2014'}</td>
          <td class="num">${formatExpiry(batch.expiry_date)}</td>
          <td><span class="${badgeClass}">${statusLabel}</span></td>
          <td class="num">${stock}</td>
          ${canViewCosts ? `<td class="num">${formatCurrency(costValue)}</td>` : ''}
        </tr>`;
      })
      .join('');

    const totalCostValue = filteredBatches.reduce((sum, batch) => {
      const costPerChild =
        batch.cost_per_child_override || batch.cost_per_child || 0;
      return sum + batch.quantity_base * costPerChild;
    }, 0);

    const html = `
      <div class="header">
        <div>
          <h2>${t('Expiry Report')}</h2>
          <p>${today}</p>
        </div>
        <div style="text-align: end;">
          <p><strong>${filteredBatches.length}</strong> ${t('batches')}</p>
        </div>
      </div>
      <div class="summary">
        <p><strong>${t('Expired')}:</strong> ${bucketCounts.expired} | <strong>${t('1-30 Days')}:</strong> ${bucketCounts['1-30']} | <strong>${t('31-60 Days')}:</strong> ${bucketCounts['31-60']} | <strong>${t('61-90 Days')}:</strong> ${bucketCounts['61-90']}</p>
        ${canViewCosts ? `<p><strong>${t('Total Cost Value')}:</strong> ${formatCurrency(totalCostValue)}</p>` : ''}
      </div>
      <table>
        <thead>
          <tr>
            <th>${t('Product Name')}</th>
            <th>${t('Batch #')}</th>
            <th>${t('Expiry Date')}</th>
            <th>${t('Status')}</th>
            <th>${t('Stock')}</th>
            ${canViewCosts ? `<th>${t('Cost Value')}</th>` : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    printHtml(html);
  }

  // ── Loading state ──────────────────────────────────────────────────────

  if (loading) {
    return <ExpiryTabSkeleton />;
  }

  // ── Error state ────────────────────────────────────────────────────────

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

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-4">
      {/* ── Page Header with Print Button ─────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div />
        <Button
          variant="outline"
          size="sm"
          onClick={handlePrint}
          disabled={filteredBatches.length === 0}
          className="gap-1.5"
        >
          <Printer className="h-4 w-4" />
          {t('Print Report')}
        </Button>
      </div>

      {/* ── Summary Cards ────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('Expired')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              <span className="text-2xl font-bold text-destructive">
                {bucketCounts.expired}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('batches')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('1-30 Days')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <span className="text-2xl font-bold text-destructive">
                {bucketCounts['1-30']}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('batches')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('31-60 Days')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-500" />
              <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                {bucketCounts['31-60']}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('batches')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('61-90 Days')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Info className="h-5 w-5 text-blue-500" />
              <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                {bucketCounts['61-90']}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('batches')}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Filter Bar ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('Search by product name...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9"
          />
        </div>

        <Select value={urgencyFilter} onValueChange={setUrgencyFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={t('Urgency')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All')}</SelectItem>
            <SelectItem value="expired">{t('Expired')}</SelectItem>
            <SelectItem value="1-30">{t('1-30 Days')}</SelectItem>
            <SelectItem value="31-60">{t('31-60 Days')}</SelectItem>
            <SelectItem value="61-90">{t('61-90 Days')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Table ────────────────────────────────────────────────────── */}
      {filteredBatches.length === 0 ? (
        <EmptyState message={t('No expiring or expired items found')} />
      ) : (
        <div className="rounded-md border">
          <Table className="sticky-col">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>{t('Product Name')}</TableHead>
                <TableHead>{t('Batch #')}</TableHead>
                <TableHead>{t('Expiry Date')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead className="text-end">{t('Stock')}</TableHead>
                {canViewCosts && (
                  <TableHead className="text-end">{t('Cost Value')}</TableHead>
                )}
                <TableHead className="hidden lg:table-cell">{t('Created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedBatches.map((batch, idx) => {
                const days = daysUntilExpiry(batch.expiry_date);
                const bucket = getUrgencyBucket(days);

                // Status badge: show expiry status label based on days until expiry
                let badgeVariant: 'destructive' | 'warning' | 'secondary' = 'secondary';
                let statusLabel = '';

                if (days <= 0) {
                  badgeVariant = 'destructive';
                  statusLabel = days === 0
                    ? t('Expired') + ' \u2014 ' + t('Expires today')
                    : t('Expired') + ` (${Math.abs(days)}d)`;
                } else if (bucket === '1-30') {
                  badgeVariant = 'destructive';
                  statusLabel = t('Expiring Soon') + ` (${days}d)`;
                } else if (bucket === '31-60') {
                  badgeVariant = 'warning';
                  statusLabel = t('Expiring Soon') + ` (${days}d)`;
                } else {
                  // 61-90
                  badgeVariant = 'secondary';
                  statusLabel = t('OK') + ` (${days}d)`;
                }

                // Cost value = quantity_base * cost per base unit
                const cf = batch.conversion_factor ?? 1;
                const costPerBase = cf > 1
                  ? (batch.cost_per_child_override || batch.cost_per_child || Math.ceil(batch.cost_per_parent / cf))
                  : batch.cost_per_parent;
                const costValue = batch.quantity_base * costPerBase;

                return (
                  <TableRow key={batch.id}>
                    <TableCell className="text-center text-muted-foreground">{(safePage - 1) * PAGE_SIZE + idx + 1}</TableCell>
                    <TableCell className="font-medium">
                      {batch.product_name ?? `#${batch.product_id}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {batch.batch_number ?? '\u2014'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="tabular-nums text-sm">
                          {formatExpiry(batch.expiry_date)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={badgeVariant}>
                        {statusLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatQuantity(
                        batch.quantity_base,
                        batch.parent_unit ?? 'unit',
                        batch.child_unit ?? 'pc',
                        batch.conversion_factor ?? 1
                      )}
                    </TableCell>
                    {canViewCosts && (
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(costValue)}
                      </TableCell>
                    )}
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground whitespace-nowrap">
                      {batch.created_at
                        ? new Date(batch.created_at).toLocaleDateString()
                        : '\u2014'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ── Pagination ────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <DataPagination
          page={safePage}
          totalPages={totalPages}
          total={filteredBatches.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
