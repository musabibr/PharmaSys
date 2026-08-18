import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Package, Search, Printer, ShoppingCart, AlertCircle, TrendingUp, TrendingDown, Phone } from 'lucide-react';
import { api } from '@/api';
import { loadProducts } from '@/stores/products.store';
import type {
  Product,
  ProductSupplierRecord,
} from '@/api/types';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import { DataPagination } from '@/components/ui/data-pagination';
import { usePermission } from '@/hooks/usePermission';
import { formatCurrency, formatDate } from '@/lib/utils';
import { printHtml } from '@/lib/print';

const PAGE_SIZE = 20;

export function SupplierProductsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreatePurchase = usePermission('purchases.manage');

  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(true);

  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ProductSupplierRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reset page on product change
  useEffect(() => { setPage(1); }, [productId]);

  // Load products once
  useEffect(() => {
    setLoadingProducts(true);
    loadProducts()
      .then((p) => setProducts(p ?? []))
      .catch(() => toast.error(t('Failed to load products')))
      .finally(() => setLoadingProducts(false));
  }, [t]);

  const productOptions = useMemo(
    () => products
      .filter(p => p.is_active)
      .map(p => ({
        value: String(p.id),
        label: p.barcode ? `${p.name} (${p.barcode})` : p.name,
      })),
    [products],
  );

  const selectedProduct = useMemo(
    () => productId == null ? null : products.find(p => p.id === productId) ?? null,
    [productId, products],
  );

  // Fetch suppliers for selected product
  useEffect(() => {
    if (productId == null) {
      setRows([]); setTotal(0);
      return;
    }
    setLoading(true);
    api.purchases.getSuppliersByProduct(productId, page, PAGE_SIZE)
      .then(res => { setRows(res.data ?? []); setTotal(res.total ?? 0); })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : t('Failed to load suppliers'));
        setRows([]); setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [productId, page, t]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleReorder = useCallback((row: ProductSupplierRecord) => {
    if (!canCreatePurchase) {
      toast.error(t('You do not have permission to create purchases'));
      return;
    }
    if (productId == null) return;
    navigate('/purchases', {
      state: {
        tab: 'manual',
        initialSupplierId: row.supplier_id,
        initialProductId: productId,
      },
    });
  }, [canCreatePurchase, productId, navigate, t]);

  const handlePrint = () => {
    if (productId == null || !selectedProduct) {
      toast.error(t('Choose a product to see its suppliers'));
      return;
    }
    const tableRows = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.supplier_name)}</td>
        <td>${escapeHtml(r.supplier_phone ?? '')}</td>
        <td>${formatCurrency(r.last_cost)}</td>
        <td>${formatCurrency(r.avg_cost)}</td>
        <td>${formatDate(r.first_purchase_date)}</td>
        <td>${formatDate(r.last_purchase_date)}</td>
        <td>${r.total_qty_bought}</td>
        <td>${formatCurrency(r.total_spent)}</td>
        <td>${r.purchase_count}</td>
      </tr>`).join('');
    const html = `
      <h2>${t('Suppliers for: {{name}}', { name: escapeHtml(selectedProduct.name) })}</h2>
      <table>
        <thead><tr>
          <th>${t('Supplier Name')}</th><th>${t('Phone')}</th>
          <th>${t('Last cost')}</th><th>${t('Avg cost')}</th>
          <th>${t('First Purchased')}</th><th>${t('Last Purchased')}</th>
          <th>${t('Total qty')}</th><th>${t('Total spent')}</th>
          <th>${t('Purchase count')}</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;
    printHtml(html);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* Product picker */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[260px] space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                <Package className="me-1 inline h-3 w-3" />
                {t('Search for a product')}
              </Label>
              {loadingProducts ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Combobox
                  value={productId == null ? '' : String(productId)}
                  onValueChange={(v) => setProductId(v ? Number(v) : null)}
                  options={productOptions}
                  placeholder={t('Choose a product to see its suppliers')}
                  searchPlaceholder={t('Search product...')}
                  emptyText={t('No products')}
                />
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handlePrint} disabled={productId == null}>
              <Printer className="me-1.5 h-4 w-4" />
              {t('Print Report')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Selected product info */}
      {selectedProduct && (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div>
                <span className="font-semibold">{selectedProduct.name}</span>
                {selectedProduct.generic_name && (
                  <span className="ms-2 text-muted-foreground">({selectedProduct.generic_name})</span>
                )}
              </div>
              {selectedProduct.barcode && (
                <Badge variant="outline" className="tabular-nums">{selectedProduct.barcode}</Badge>
              )}
              <Badge variant="secondary">
                {selectedProduct.parent_unit}
                {selectedProduct.child_unit && ` / ${selectedProduct.child_unit}`}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {productId == null && (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            <Search className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p>{t('Choose a product to see its suppliers')}</p>
          </CardContent>
        </Card>
      )}

      {/* Results table */}
      {productId != null && (
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <AlertCircle className="mx-auto mb-2 h-8 w-8 opacity-50" />
                <p>{t('No suppliers found for this product')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Supplier Name')}</TableHead>
                    <TableHead>{t('Phone')}</TableHead>
                    <TableHead>{t('Last cost')}</TableHead>
                    <TableHead>{t('Avg cost')}</TableHead>
                    <TableHead>{t('Last Purchased')}</TableHead>
                    <TableHead>{t('Total qty')}</TableHead>
                    <TableHead>{t('Total spent')}</TableHead>
                    <TableHead>{t('Purchase count')}</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => {
                    const trend = priceTrend(r);
                    return (
                      <TableRow key={r.supplier_id}>
                        <TableCell>
                          <div className="font-medium">{r.supplier_name}</div>
                        </TableCell>
                        <TableCell>
                          {r.supplier_phone ? (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                              <Phone className="h-3 w-3" />
                              {r.supplier_phone}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <div className="flex items-center gap-1">
                            {formatCurrency(r.last_cost)}
                            {trend === 'up'   && <TrendingUp   className="h-3.5 w-3.5 text-destructive" />}
                            {trend === 'down' && <TrendingDown className="h-3.5 w-3.5 text-success" />}
                          </div>
                          {r.previous_cost != null && r.previous_cost !== r.last_cost && (
                            <div className="text-xs text-muted-foreground line-through">{formatCurrency(r.previous_cost)}</div>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">{formatCurrency(r.avg_cost)}</TableCell>
                        <TableCell>{formatDate(r.last_purchase_date)}</TableCell>
                        <TableCell className="tabular-nums">{r.total_qty_bought}</TableCell>
                        <TableCell className="tabular-nums">{formatCurrency(r.total_spent)}</TableCell>
                        <TableCell className="tabular-nums">{r.purchase_count}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleReorder(r)}
                            disabled={!canCreatePurchase}
                          >
                            <ShoppingCart className="me-1.5 h-3.5 w-3.5" />
                            {t('Re-order')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {productId != null && total > 0 && (
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function priceTrend(r: ProductSupplierRecord): 'up' | 'down' | 'flat' {
  if (r.previous_cost == null) return 'flat';
  if (r.last_cost > r.previous_cost) return 'up';
  if (r.last_cost < r.previous_cost) return 'down';
  return 'flat';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
