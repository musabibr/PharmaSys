import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { InventoryValuationItem, InventoryValuationResult } from '@/api/types';
import { Card, CardContent } from '@/components/ui/card';
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
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { printHtml } from '@/lib/print';
import { usePermission } from '@/hooks/usePermission';
import { DataPagination } from '@/components/ui/data-pagination';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  ArrowUpDown,
  Package,
  Printer,
  Search,
  TrendingUp,
  Wallet,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------
type SortKey = 'name' | 'total_stock_base' | 'cost_value' | 'retail_value';
type SortDir = 'asc' | 'desc';

function compareItems(a: InventoryValuationItem, b: InventoryValuationItem, key: SortKey, dir: SortDir): number {
  let cmp: number;
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name);
      break;
    case 'total_stock_base':
      cmp = a.total_stock_base - b.total_stock_base;
      break;
    case 'cost_value':
      cmp = a.cost_value - b.cost_value;
      break;
    case 'retail_value':
      cmp = a.retail_value - b.retail_value;
      break;
    default:
      cmp = 0;
  }
  return dir === 'asc' ? cmp : -cmp;
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
function ValuationSkeleton() {
  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="h-8 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
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
// Sortable column header
// ---------------------------------------------------------------------------
function SortableHead({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = currentKey === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(sortKey)}
      >
        {label}
        <ArrowUpDown
          className={`h-3.5 w-3.5 ${isActive ? 'text-foreground' : 'text-muted-foreground/40'}`}
        />
        {isActive && (
          <span className="sr-only">
            {currentDir === 'asc' ? 'ascending' : 'descending'}
          </span>
        )}
      </button>
    </TableHead>
  );
}

// ---------------------------------------------------------------------------
// ValuationTab
// ---------------------------------------------------------------------------
const PAGE_SIZE = 10;

export function ValuationTab() {
  const { t } = useTranslation();
  const canViewCosts = usePermission('inventory.view_costs');

  const [result, setResult] = useState<InventoryValuationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(1);

  // --- Data fetching ---
  const fetchData = () => {
    setLoading(true);
    setError(null);
    api.reports
      .inventoryValuation()
      .then((res) => {
        setResult(res);
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

  // --- Sort toggle ---
  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // --- Print handler ---
  const handlePrint = () => {
    if (allItems.length === 0) return;
    const costHeaders = canViewCosts
      ? `<th class="num">${t('Cost Value')}</th><th class="num">${t('Retail Value')}</th><th class="num">${t('Potential Profit')}</th>`
      : '';
    const rows = allItems.map((item) => {
      const profit = item.retail_value - item.cost_value;
      const costCols = canViewCosts
        ? `<td class="num">${formatCurrency(item.cost_value)}</td><td class="num">${formatCurrency(item.retail_value)}</td><td class="num">${formatCurrency(profit)}</td>`
        : '';
      return `<tr>
        <td>${item.name}</td>
        <td>${item.category_name ?? '\u2014'}</td>
        <td class="num">${formatQuantity(item.total_stock_base, item.parent_unit, item.child_unit, item.conversion_factor)}</td>
        <td class="num">${item.batch_count}</td>
        ${costCols}
      </tr>`;
    }).join('');

    const summaryParts = [`<p><strong>${t('Total Products')}:</strong> ${totalProducts}</p>`];
    if (canViewCosts) {
      summaryParts.push(`<p><strong>${t('Total Cost Value')}:</strong> ${formatCurrency(result!.total_cost)}</p>`);
      summaryParts.push(`<p><strong>${t('Total Retail Value')}:</strong> ${formatCurrency(result!.total_retail)}</p>`);
    }

    const html = `
      <div class="header">
        <h2>${t('Inventory Valuation Report')}</h2>
        <p>${new Date().toLocaleDateString()}</p>
      </div>
      <div class="summary">${summaryParts.join('')}</div>
      <table>
        <thead><tr>
          <th>${t('Product Name')}</th>
          <th>${t('Category')}</th>
          <th class="num">${t('Stock')}</th>
          <th class="num">${t('Batches')}</th>
          ${costHeaders}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    printHtml(html);
  };

  // --- Derived data ---
  const allItems = useMemo(() => {
    if (!result) return [];
    const raw = Array.isArray(result.data) ? result.data : [];
    const query = search.toLowerCase().trim();
    const filtered = query
      ? raw.filter((item) => item.name.toLowerCase().includes(query))
      : raw;
    return [...filtered].sort((a, b) => compareItems(a, b, sortKey, sortDir));
  }, [result, search, sortKey, sortDir]);

  // Reset page when search or sort changes
  useEffect(() => { setPage(1); }, [search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const items = allItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // --- Loading state ---
  if (loading) return <ValuationSkeleton />;

  // --- Error state ---
  if (error || !result) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">{error ?? t('Failed to load data')}</p>
        <button
          onClick={fetchData}
          className="mt-4 text-sm text-primary underline hover:no-underline"
        >
          {t('Try again')}
        </button>
      </div>
    );
  }

  const totalProducts = Array.isArray(result.data) ? result.data.length : 0;

  return (
    <div className="space-y-4 p-1">
      {/* ── Summary Cards ──────────────────────────────────────────────── */}
      <div className={`grid gap-4 ${canViewCosts ? 'sm:grid-cols-3' : 'sm:grid-cols-1'}`}>
        <StatCard
          label={t('Total Products')}
          value={totalProducts}
          icon={<Package className="h-5 w-5" />}
        />
        {canViewCosts && (
          <StatCard
            label={t('Total Cost Value')}
            value={formatCurrency(result.total_cost)}
            icon={<Wallet className="h-5 w-5" />}
          />
        )}
        {canViewCosts && (
          <StatCard
            label={t('Total Retail Value')}
            value={formatCurrency(result.total_retail)}
            icon={<TrendingUp className="h-5 w-5" />}
            variant="success"
          />
        )}
      </div>

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
              <SortableHead
                label={t('Product Name')}
                sortKey="name"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
              />
              <TableHead className="hidden lg:table-cell">{t('Category')}</TableHead>
              <SortableHead
                label={t('Stock')}
                sortKey="total_stock_base"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-end"
              />
              <TableHead className="text-end">{t('Batches')}</TableHead>
              {canViewCosts && (
                <>
                  <SortableHead
                    label={t('Cost Value')}
                    sortKey="cost_value"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-end"
                  />
                  <SortableHead
                    label={t('Retail Value')}
                    sortKey="retail_value"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-end"
                  />
                  <TableHead className="text-end">{t('Potential Profit')}</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canViewCosts ? 8 : 5} className="h-24 text-center text-muted-foreground">
                  {search ? t('No products match your search') : t('No inventory data')}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item, idx) => {
                const profit = item.retail_value - item.cost_value;
                return (
                  <TableRow key={item.product_id}>
                    <TableCell className="text-center text-muted-foreground">{(safePage - 1) * PAGE_SIZE + idx + 1}</TableCell>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="hidden lg:table-cell text-muted-foreground">
                      {item.category_name ?? '\u2014'}
                    </TableCell>
                    <TableCell className="text-end whitespace-nowrap tabular-nums">
                      {formatQuantity(
                        item.total_stock_base,
                        item.parent_unit,
                        item.child_unit,
                        item.conversion_factor
                      )}
                    </TableCell>
                    <TableCell className="text-end whitespace-nowrap tabular-nums">
                      {item.batch_count}
                    </TableCell>
                    {canViewCosts && (
                      <>
                        <TableCell className="text-end whitespace-nowrap tabular-nums">
                          {formatCurrency(item.cost_value)}
                        </TableCell>
                        <TableCell className="text-end whitespace-nowrap tabular-nums">
                          {formatCurrency(item.retail_value)}
                        </TableCell>
                        <TableCell
                          className={`text-end whitespace-nowrap tabular-nums font-medium ${
                            profit >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-destructive'
                          }`}
                        >
                          {formatCurrency(profit)}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <DataPagination
        page={safePage}
        totalPages={totalPages}
        total={allItems.length}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}
