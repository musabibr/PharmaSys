import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Search, AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '@/api';
import { useDebounce } from '@/hooks/useDebounce';
import type { ProductStockLedgerRow } from '@/api/types';
import { formatQuantity, unitLabel } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import { DataPagination } from '@/components/ui/data-pagination';

const PAGE_SIZE = 25;

/**
 * Per-product stock reconciliation ledger. Shows Purchased / Sold / Returned /
 * Adjusted / On-hand and a derived Expected + Variance so the owner can audit
 * every product. Variance ≠ 0 flags a discrepancy (e.g. stock corrupted by a
 * past conversion-factor rescale, or stock added outside a purchase invoice).
 *
 * Paginated and filtered server-side (search, only-variance, page) — the
 * reconciliation math runs several correlated subqueries per product, so
 * loading the whole catalogue on every visit doesn't scale past a few
 * hundred products.
 */
export function StockLedgerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const [onlyVariance, setOnlyVariance] = useState(false);
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<ProductStockLedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [varianceCount, setVarianceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLedger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.reports.productStockLedger({
        page, limit: PAGE_SIZE,
        search: debouncedQuery.trim() || undefined,
        onlyVariance: onlyVariance || undefined,
      });
      setRows(res.data ?? []);
      setTotal(res.total ?? 0);
      setTotalPages(res.totalPages ?? 1);
      setVarianceCount(res.varianceCount ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to load stock ledger'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedQuery, onlyVariance, t]);

  useEffect(() => { fetchLedger(); }, [fetchLedger]);
  useEffect(() => { setPage(1); }, [debouncedQuery, onlyVariance]);

  const qty = (base: number, r: ProductStockLedgerRow) =>
    formatQuantity(base, unitLabel(r.parent_unit, t), unitLabel(r.child_unit, t), r.conversion_factor);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>{t('Stock Ledger')}</span>
            <Button variant="outline" size="sm" onClick={fetchLedger} disabled={loading} className="gap-1.5">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {t('Refresh')}
            </Button>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('Purchased − Sold + Returned − Adjustments should equal on-hand. A non-zero variance means the stock does not reconcile with recorded movements.')}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('Search products...')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="ps-8"
              />
            </div>
            <Button
              variant={onlyVariance ? 'default' : 'outline'}
              size="sm"
              onClick={() => setOnlyVariance(v => !v)}
              className="gap-1.5"
            >
              <AlertTriangle className="h-4 w-4" />
              {t('Only variances')}
              {varianceCount > 0 && (
                <Badge variant="secondary" className="ms-1">{varianceCount}</Badge>
              )}
            </Button>
          </div>

          {error ? (
            <div className="py-8 text-center text-sm text-destructive">{error}</div>
          ) : loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t('Loading...')}</div>
          ) : (
            <>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Product')}</TableHead>
                      <TableHead className="text-end">{t('Purchased')}</TableHead>
                      <TableHead className="text-end">{t('Sold')}</TableHead>
                      <TableHead className="text-end">{t('Returned')}</TableHead>
                      <TableHead className="text-end">{t('Adjusted')}</TableHead>
                      <TableHead className="text-end">{t('On hand')}</TableHead>
                      <TableHead className="text-end">{t('Expected')}</TableHead>
                      <TableHead className="text-end">{t('Variance')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                          {t('No products found')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map(r => (
                        <TableRow
                          key={r.product_id}
                          onClick={() => navigate(`/inventory/product/${r.product_id}`)}
                          title={t('Open product profile')}
                          className={`cursor-pointer hover:bg-muted/50 ${r.variance_base !== 0 ? 'bg-destructive/5' : ''}`}
                        >
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="text-end tabular-nums">{qty(r.purchased_base, r)}</TableCell>
                          <TableCell className="text-end tabular-nums">{qty(r.sold_base, r)}</TableCell>
                          <TableCell className="text-end tabular-nums">{qty(r.returned_base, r)}</TableCell>
                          <TableCell className="text-end tabular-nums">{qty(r.adjusted_removed_base, r)}</TableCell>
                          <TableCell className="text-end tabular-nums font-medium">{qty(r.on_hand_base, r)}</TableCell>
                          <TableCell className="text-end tabular-nums text-muted-foreground">{qty(r.expected_base, r)}</TableCell>
                          <TableCell className={`text-end tabular-nums font-semibold ${r.variance_base !== 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                            {r.variance_base > 0 ? '+' : ''}{qty(r.variance_base, r)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {totalPages > 1 && (
                <DataPagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
