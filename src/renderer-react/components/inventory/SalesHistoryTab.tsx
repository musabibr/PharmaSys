import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { Product, User, ProductSaleFilters, ProductSaleRecord } from '@/api/types';
import { useDebounce } from '@/hooks/useDebounce';
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { DataPagination } from '@/components/ui/data-pagination';
import {
  History,
  Package,
  Search,
  X,
  TrendingUp,
  Users,
} from 'lucide-react';

const PAGE_SIZE = 25;

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// SalesHistoryTab
// ---------------------------------------------------------------------------

export function SalesHistoryTab() {
  const { t } = useTranslation();

  // ---- Product multi-select ----
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const debouncedSearch = useDebounce(productSearch, 200);
  const [showResults, setShowResults] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<Product[]>([]);

  // ---- User filter ----
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('all');

  // ---- Other filters ----
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [txnType, setTxnType] = useState<'all' | 'sale' | 'return'>('all');
  const [page, setPage] = useState(1);

  // ---- Data ----
  const [rows, setRows] = useState<ProductSaleRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ---- Load products + users once ----
  useEffect(() => {
    api.products.getAll()
      .then((prods) => setAllProducts(Array.isArray(prods) ? prods : []))
      .catch(() => {});
    api.users.getAll()
      .then((users) => setAllUsers(Array.isArray(users) ? users : []))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Product search results (excludes already-selected) ----
  const searchResults = debouncedSearch.trim()
    ? allProducts
        .filter(
          (p) =>
            !selectedProducts.some((s) => s.id === p.id) &&
            (p.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
              (p.generic_name ?? '').toLowerCase().includes(debouncedSearch.toLowerCase()) ||
              (p.barcode ?? '').toLowerCase().includes(debouncedSearch.toLowerCase()))
        )
        .slice(0, 20)
    : [];

  function addProduct(p: Product) {
    setSelectedProducts((prev) => (prev.some((s) => s.id === p.id) ? prev : [...prev, p]));
    setProductSearch('');
    setShowResults(false);
  }

  function removeProduct(id: number) {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== id));
  }

  // ---- Fetch ----
  const fetchData = useCallback(async (currentPage: number) => {
    setLoading(true);
    setError('');
    try {
      const filters: ProductSaleFilters = {
        product_ids:      selectedProducts.length > 0 ? selectedProducts.map((p) => p.id) : undefined,
        user_id:          selectedUserId !== 'all' ? Number(selectedUserId) : undefined,
        start_date:       startDate || undefined,
        end_date:         endDate || undefined,
        transaction_type: txnType === 'all' ? undefined : txnType,
        page:             currentPage,
        limit:            PAGE_SIZE,
      };
      const result = await api.transactions.getSalesByProduct(filters);
      setRows(result.data);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch {
      setError(t('Failed to load sales history'));
    } finally {
      setLoading(false);
    }
  }, [selectedProducts, selectedUserId, startDate, endDate, txnType, t]);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1);
    fetchData(1);
  }, [selectedProducts, selectedUserId, startDate, endDate, txnType]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchData(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Summary (current page sales only) ----
  const totalRevenue = rows
    .filter((r) => r.transaction_type === 'sale')
    .reduce((s, r) => s + r.line_total, 0);

  const hasFilters = selectedProducts.length > 0 || selectedUserId !== 'all' || startDate || endDate || txnType !== 'all';

  function clearAllFilters() {
    setSelectedProducts([]);
    setSelectedUserId('all');
    setStartDate('');
    setEndDate('');
    setTxnType('all');
  }

  // Only show the product column when not filtered to exactly one product
  const showProductCol = selectedProducts.length !== 1;

  return (
    <div className="flex h-full flex-col gap-4 p-4 overflow-hidden">

      {/* ---- Header ---- */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary shrink-0" />
          <h2 className="text-base font-semibold">{t('Sales History')}</h2>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearAllFilters} className="gap-1.5 text-muted-foreground">
            <X className="h-3.5 w-3.5" />
            {t('Clear all filters')}
          </Button>
        )}
      </div>

      {/* ---- Filters ---- */}
      <Card>
        <CardContent className="pt-4 pb-3 space-y-3">

          {/* Row 1: Product multi-select */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('Products')} ({t('select multiple')})</Label>

            {/* Selected product chips */}
            {selectedProducts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1">
                {selectedProducts.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs font-medium"
                  >
                    <Package className="h-3 w-3 text-primary" />
                    {p.name}
                    <button
                      type="button"
                      onClick={() => removeProduct(p.id)}
                      className="rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Search input */}
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={productSearch}
                onChange={(e) => { setProductSearch(e.target.value); setShowResults(true); }}
                onFocus={() => { if (productSearch.trim()) setShowResults(true); }}
                onBlur={() => setTimeout(() => setShowResults(false), 150)}
                placeholder={selectedProducts.length > 0 ? t('Add another product...') : t('Search product...')}
                className="ps-8 h-9 text-sm"
              />
              {showResults && searchResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
                  <div className="max-h-48 overflow-y-auto">
                    {searchResults.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onMouseDown={() => addProduct(p)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-start"
                      >
                        <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="flex-1 truncate">{p.name}</span>
                        {p.generic_name && (
                          <span className="text-xs text-muted-foreground truncate">{p.generic_name}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Row 2: user + dates + type */}
          <div className="flex flex-wrap items-end gap-3">

            {/* User / Cashier */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Cashier')}</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="h-9 text-sm w-44">
                  <SelectValue placeholder={t('All users')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All users')}</SelectItem>
                  {allUsers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.full_name || u.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date from */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('From')}</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 text-sm w-36"
              />
            </div>

            {/* Date to */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('To')}</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 text-sm w-36"
              />
            </div>

            {/* Type */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Type')}</Label>
              <Select value={txnType} onValueChange={(v) => setTxnType(v as typeof txnType)}>
                <SelectTrigger className="h-9 text-sm w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  <SelectItem value="sale">{t('Sales')}</SelectItem>
                  <SelectItem value="return">{t('Returns')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Summary ---- */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="flex items-center gap-3 p-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                <History className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Total Records')}</p>
                <p className="text-lg font-bold tabular-nums">{total}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 shrink-0">
                <TrendingUp className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Sales on page')}</p>
                <p className="text-lg font-bold tabular-nums">
                  {rows.filter((r) => r.transaction_type === 'sale').length}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 shrink-0">
                <Users className="h-4 w-4 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Revenue on page')}</p>
                <p className="text-lg font-bold tabular-nums text-green-600">{formatCurrency(totalRevenue)}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---- Table ---- */}
      <ScrollArea className="flex-1 rounded-md border">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <History className="h-10 w-10 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">{t('No sales history found')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {hasFilters
                ? t('Try adjusting the filters')
                : t('Select a product or date range to get started')}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">{t('Date & Time')}</TableHead>
                <TableHead>{t('Txn #')}</TableHead>
                {showProductCol && <TableHead>{t('Product')}</TableHead>}
                <TableHead>{t('Batch #')}</TableHead>
                <TableHead>{t('Cashier')}</TableHead>
                <TableHead>{t('Customer')}</TableHead>
                <TableHead className="text-end">{t('Qty')}</TableHead>
                <TableHead className="text-end">{t('Unit Price')}</TableHead>
                <TableHead className="text-center">{t('Type')}</TableHead>
                <TableHead className="text-end">{t('Total')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const cf = row.conversion_factor_snapshot || 1;
                const qtyLabel = formatQuantity(row.quantity_base, row.parent_unit, row.child_unit, cf);
                const isSale = row.transaction_type === 'sale';

                return (
                  <TableRow key={row.item_id}>
                    <TableCell className="tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(row.created_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.transaction_number}
                    </TableCell>
                    {showProductCol && (
                      <TableCell className="max-w-[160px] truncate text-sm font-medium">
                        {row.product_name}
                      </TableCell>
                    )}
                    <TableCell className="text-sm text-muted-foreground">
                      {row.batch_number || '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.username}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.customer_name || '—'}
                    </TableCell>
                    <TableCell className="text-end tabular-nums font-medium">
                      {qtyLabel}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatCurrency(row.unit_price)}
                    </TableCell>
                    <TableCell className="text-center">
                      {isSale ? (
                        <Badge variant="success" className="text-xs">{t('Sale')}</Badge>
                      ) : (
                        <Badge variant="warning" className="text-xs">{t('Return')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className={`text-end tabular-nums font-semibold ${isSale ? '' : 'text-destructive'}`}>
                      {isSale ? '' : '−'}{formatCurrency(row.line_total)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ScrollArea>

      {/* ---- Pagination ---- */}
      {totalPages > 1 && (
        <DataPagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
