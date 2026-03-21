import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as XLSX from 'xlsx';
import { Download, Loader2, Search } from 'lucide-react';
import { api } from '@/api';
import type { Product } from '@/api/types';
import { formatQuantity } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

interface ExportColumn {
  key: keyof Product;
  label: string;
  required?: boolean;
}

const ALL_COLUMNS: ExportColumn[] = [
  { key: 'name',               label: 'Product Name',            required: true },
  { key: 'generic_name',       label: 'Generic Name' },
  { key: 'barcode',            label: 'Barcode' },
  { key: 'category_name',      label: 'Category' },
  { key: 'parent_unit',        label: 'Base Unit' },
  { key: 'child_unit',         label: 'Small Unit' },
  { key: 'conversion_factor',  label: 'Conv Factor' },
  { key: 'selling_price',      label: 'Sell Price (Base) SDG' },
  { key: 'selling_price_child', label: 'Sell Price (Small) SDG' },
  { key: 'min_stock_level',    label: 'Min Stock Level' },
  { key: 'usage_instructions', label: 'Usage Instructions' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ProductExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ExportMode = 'all' | 'select';

export function ProductExportDialog({ open, onOpenChange }: ProductExportDialogProps) {
  const { t } = useTranslation();
  const [selectedCols, setSelectedCols] = useState<Set<string>>(
    new Set(ALL_COLUMNS.map(c => c.key))
  );
  const [exporting, setExporting] = useState(false);

  // Product selection state
  const [mode, setMode]                     = useState<ExportMode>('all');
  const [allProducts, setAllProducts]       = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productSearch, setProductSearch]   = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set());

  // Load products when dialog opens or mode switches to 'select'
  useEffect(() => {
    if (!open) return;
    if (mode === 'select' && allProducts.length === 0) {
      setLoadingProducts(true);
      api.products.getAll().then(products => {
        setAllProducts(products);
      }).catch(() => {
        setAllProducts([]);
      }).finally(() => {
        setLoadingProducts(false);
      });
    }
  }, [open, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setMode('all');
      setProductSearch('');
      setSelectedProductIds(new Set());
    }
  }, [open]);

  const toggleCol = (key: string) => {
    setSelectedCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleProduct = (id: number) => {
    setSelectedProductIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedProductIds(new Set(filteredProducts.map(p => p.id)));
  };

  const deselectAll = () => {
    setSelectedProductIds(new Set());
  };

  const filteredProducts = allProducts.filter(p => {
    if (!productSearch.trim()) return true;
    const q = productSearch.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.generic_name ?? '').toLowerCase().includes(q) ||
      (p.category_name ?? '').toLowerCase().includes(q)
    );
  });

  const handleExport = async () => {
    setExporting(true);
    try {
      let products: Product[];
      if (mode === 'select') {
        if (selectedProductIds.size === 0) {
          setExporting(false);
          return;
        }
        products = allProducts.filter(p => selectedProductIds.has(p.id));
      } else {
        products = await api.products.getAll();
      }

      const activeCols = ALL_COLUMNS.filter(c => selectedCols.has(c.key));
      const headers = activeCols.map(c => c.label);
      const rows = products.map(p =>
        activeCols.map(c => {
          const v = p[c.key];
          return v != null ? v : '';
        })
      );

      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 14) }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Products');

      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `PharmaSys-Products-${date}.xlsx`);

      onOpenChange(false);
    } catch {
      // errors propagate to user via browser alert fallback
    } finally {
      setExporting(false);
    }
  };

  const canExport = mode === 'all'
    ? selectedCols.size > 0
    : selectedCols.size > 0 && selectedProductIds.size > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('Export Products')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-hidden flex-1 min-h-0">
          {/* ── Column selection ── */}
          <div className="space-y-2 shrink-0">
            <p className="text-sm font-medium">{t('Columns to export')}</p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {ALL_COLUMNS.map(col => (
                <label key={col.key} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedCols.has(col.key)}
                    disabled={col.required}
                    onChange={() => !col.required && toggleCol(col.key)}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{col.label}</span>
                  {col.required && (
                    <span className="text-xs text-muted-foreground">{t('(required)')}</span>
                  )}
                </label>
              ))}
            </div>
          </div>

          <hr />

          {/* ── Product selection mode ── */}
          <div className="flex flex-col gap-3 flex-1 min-h-0">
            <div className="flex items-center justify-between shrink-0">
              <p className="text-sm font-medium">{t('Products to export')}</p>
              <Tabs value={mode} onValueChange={v => setMode(v as ExportMode)}>
                <TabsList className="h-8">
                  <TabsTrigger value="all" className="text-xs h-7 px-3">{t('All Products')}</TabsTrigger>
                  <TabsTrigger value="select" className="text-xs h-7 px-3">{t('Select Products')}</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {mode === 'select' && (
              <div className="flex flex-col gap-2 flex-1 min-h-0">
                {/* Search + select all/deselect all */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="relative flex-1">
                    <Search className="absolute start-2.5 top-2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder={t('Search products...')}
                      value={productSearch}
                      onChange={e => setProductSearch(e.target.value)}
                      className="h-8 ps-8 text-sm"
                    />
                  </div>
                  <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={selectAll} disabled={loadingProducts}>
                    {t('Select All')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={deselectAll} disabled={loadingProducts}>
                    {t('Deselect All')}
                  </Button>
                </div>

                {/* Count badge */}
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="secondary" className="text-xs">
                    {t('{{n}} products selected', { n: selectedProductIds.size })}
                  </Badge>
                  {filteredProducts.length !== allProducts.length && (
                    <Badge variant="outline" className="text-xs">
                      {t('Showing {{n}} of {{total}}', { n: filteredProducts.length, total: allProducts.length })}
                    </Badge>
                  )}
                </div>

                {/* Product list */}
                <ScrollArea className="flex-1 min-h-0 rounded-md border">
                  {loadingProducts ? (
                    <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin me-2" />
                      {t('Loading products...')}
                    </div>
                  ) : filteredProducts.length === 0 ? (
                    <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
                      {t('No products found')}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                        <tr>
                          <th className="w-8 px-3 py-2 text-start"></th>
                          <th className="px-3 py-2 text-start font-medium">{t('Product Name')}</th>
                          <th className="px-3 py-2 text-start font-medium hidden sm:table-cell">{t('Generic Name')}</th>
                          <th className="px-3 py-2 text-start font-medium hidden md:table-cell">{t('Category')}</th>
                          <th className="px-3 py-2 text-end font-medium">{t('Stock')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {filteredProducts.map(p => (
                          <tr
                            key={p.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => toggleProduct(p.id)}
                          >
                            <td className="w-8 px-3 py-1.5">
                              <input
                                type="checkbox"
                                checked={selectedProductIds.has(p.id)}
                                onChange={() => toggleProduct(p.id)}
                                onClick={e => e.stopPropagation()}
                                className="h-3.5 w-3.5 accent-primary"
                              />
                            </td>
                            <td className="px-3 py-1.5 font-medium">{p.name}</td>
                            <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">
                              {p.generic_name ?? '—'}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground hidden md:table-cell">
                              {p.category_name ?? '—'}
                            </td>
                            <td className="px-3 py-1.5 text-end tabular-nums">
                              {p.total_stock_base != null
                                ? formatQuantity(p.total_stock_base, p.parent_unit ?? '', p.child_unit ?? '', p.conversion_factor ?? 1)
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </ScrollArea>
              </div>
            )}

            {mode === 'all' && (
              <p className="text-sm text-muted-foreground">
                {t('All active products will be exported.')}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={handleExport}
            disabled={exporting || !canExport}
            className="gap-1.5"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {mode === 'select' && selectedProductIds.size > 0
              ? t('Export {{n}} Products', { n: selectedProductIds.size })
              : t('Export Excel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
