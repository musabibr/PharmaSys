import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Search, X, Loader2, TrendingUp, ArrowUp, ArrowDown } from 'lucide-react';
import type { Product, Category, BulkPriceUpdateOptions, BulkPriceUpdatePreviewRow } from '@/api/types';
import { api } from '@/api';
import { formatCurrency } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings.store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DataPagination } from '@/components/ui/data-pagination';

interface BulkPriceUpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void;
}

const PAGE_SIZE = 25;

export function BulkPriceUpdateDialog({ open, onOpenChange, onApplied }: BulkPriceUpdateDialogProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  const [mode, setMode] = useState<'margin_over_cost' | 'increase_current'>('margin_over_cost');
  const [percent, setPercent] = useState<number>(defaultMarkup);
  const [rounding, setRounding] = useState<1 | 50 | 100>(100);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [excludedCats, setExcludedCats] = useState<Set<number>>(new Set());
  const [excludedProds, setExcludedProds] = useState<Set<number>>(new Set());
  const [prodQuery, setProdQuery] = useState('');
  const [prodSearchOpen, setProdSearchOpen] = useState(false);

  const [preview, setPreview] = useState<BulkPriceUpdatePreviewRow[] | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('margin_over_cost');
    setPercent(defaultMarkup);
    setRounding(100);
    setExcludedCats(new Set());
    setExcludedProds(new Set());
    setProdQuery('');
    setPreview(null);
    setPage(1);
    api.categories.getAll().then(setCategories).catch(() => setCategories([]));
    api.products.getAll().then(setProducts).catch(() => setProducts([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the preview whenever the inputs change (it would be stale).
  useEffect(() => { setPreview(null); setPage(1); }, [mode, percent, rounding, excludedCats, excludedProds]);

  const buildOpts = (): BulkPriceUpdateOptions => ({
    mode, percent, rounding,
    exclude_product_ids: [...excludedProds],
    exclude_category_ids: [...excludedCats],
  });

  const prodResults = useMemo(() => {
    const q = prodQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return products
      .filter((p) => !excludedProds.has(p.id))
      .filter((p) => p.name.toLowerCase().includes(q)
        || (p.generic_name && p.generic_name.toLowerCase().includes(q))
        || (p.barcode && p.barcode.includes(prodQuery.trim())))
      .slice(0, 8);
  }, [prodQuery, products, excludedProds]);

  const excludedProdList = useMemo(
    () => products.filter((p) => excludedProds.has(p.id)),
    [products, excludedProds],
  );

  function toggleCat(id: number) {
    setExcludedCats((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function addExcludedProd(p: Product) {
    setExcludedProds((prev) => new Set(prev).add(p.id));
    setProdQuery('');
    setProdSearchOpen(false);
  }

  function removeExcludedProd(id: number) {
    setExcludedProds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  async function handlePreview() {
    setLoading(true);
    try {
      const rows = await api.batches.previewBulkPriceUpdate(buildOpts());
      setPreview(rows);
      setPage(1);
      if (rows.length === 0) toast.info(t('No products match the current filters'));
    } catch (err) {
      toast.error((err as Error).message || t('Failed to build preview'));
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!preview || preview.length === 0) return;
    const ok = await confirm({
      title: t('Apply price update'),
      description: t('Update selling prices for {{count}} product(s)? This cannot be undone automatically.', { count: preview.length }),
    });
    if (!ok) return;

    setApplying(true);
    try {
      const res = await api.batches.applyBulkPriceUpdate(buildOpts());
      toast.success(t('Updated {{products}} product(s) across {{batches}} batch(es)', {
        products: res.updatedProducts, batches: res.updatedBatches,
      }));
      onApplied();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || t('Failed to apply price update'));
    } finally {
      setApplying(false);
    }
  }

  const totalPages = preview ? Math.max(1, Math.ceil(preview.length / PAGE_SIZE)) : 1;
  const pageRows = preview ? preview.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!applying) onOpenChange(o); }}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {t('Bulk Price Update')}
          </DialogTitle>
          <DialogDescription>
            {t('Set selling prices from each product’s latest batch by margin, with optional exclusions.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto pe-1">
          {/* Mode + percent + rounding */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Basis')}</Label>
              <div className="flex gap-1.5">
                <Button size="sm" variant={mode === 'margin_over_cost' ? 'default' : 'outline'}
                  onClick={() => setMode('margin_over_cost')}>
                  {t('Margin over cost')}
                </Button>
                <Button size="sm" variant={mode === 'increase_current' ? 'default' : 'outline'}
                  onClick={() => setMode('increase_current')}>
                  {t('Increase current price')}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Percent')} %</Label>
              <Input type="number" value={percent}
                onChange={(e) => setPercent(Number(e.target.value) || 0)}
                className="w-24" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Round to nearest')}</Label>
              <Select value={String(rounding)} onValueChange={(v) => setRounding(Number(v) as 1 | 50 | 100)}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 SDG</SelectItem>
                  <SelectItem value="50">50 SDG</SelectItem>
                  <SelectItem value="100">100 SDG</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Exclusions: categories */}
          {categories.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Exclude categories')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => {
                  const on = excludedCats.has(c.id);
                  return (
                    <Badge key={c.id} variant={on ? 'destructive' : 'outline'}
                      className="cursor-pointer select-none"
                      onClick={() => toggleCat(c.id)}>
                      {on && <X className="me-1 h-3 w-3" />}{c.name}
                    </Badge>
                  );
                })}
              </div>
            </div>
          )}

          {/* Exclusions: products */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t('Exclude specific products')}</Label>
            <div className="relative">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={prodQuery} className="ps-9"
                placeholder={t('Search products to exclude...')}
                onChange={(e) => { setProdQuery(e.target.value); setProdSearchOpen(true); }}
                onFocus={() => setProdSearchOpen(true)} />
              {prodSearchOpen && prodResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
                  <div className="max-h-48 overflow-y-auto p-1">
                    {prodResults.map((p) => (
                      <button key={p.id}
                        className="w-full text-start px-3 py-2 text-sm hover:bg-accent rounded-sm"
                        onClick={() => addExcludedProd(p)}>
                        {p.name}
                        {p.generic_name && <span className="text-xs text-muted-foreground ms-2">({p.generic_name})</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {excludedProdList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {excludedProdList.map((p) => (
                  <Badge key={p.id} variant="secondary" className="gap-1">
                    {p.name}
                    <button onClick={() => removeExcludedProd(p.id)} className="ms-0.5">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Preview table */}
          {preview && preview.length > 0 && (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Product')}</TableHead>
                    <TableHead className="text-end">{t('Basis')}</TableHead>
                    <TableHead className="text-end">{t('Current')}</TableHead>
                    <TableHead className="text-end">{t('New')}</TableHead>
                    <TableHead className="text-end">{t('Change')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((r) => (
                    <TableRow key={r.product_id}>
                      <TableCell>
                        <div className="font-medium">{r.product_name}</div>
                        {r.category_name && <div className="text-xs text-muted-foreground">{r.category_name}</div>}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(r.basis_cost)}</TableCell>
                      <TableCell className="text-end tabular-nums text-muted-foreground">
                        {formatCurrency(r.current_sell)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums font-medium">
                        {formatCurrency(r.new_sell_parent)}
                        {r.conversion_factor > 1 && (
                          <div className="text-xs text-muted-foreground">
                            {formatCurrency(r.new_sell_child)}/{t('unit')}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        <span className={r.change_pct > 0 ? 'text-green-600' : r.change_pct < 0 ? 'text-destructive' : 'text-muted-foreground'}>
                          {r.change_pct > 0 ? <ArrowUp className="inline h-3 w-3" /> : r.change_pct < 0 ? <ArrowDown className="inline h-3 w-3" /> : null}
                          {Math.abs(r.change_pct)}%
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="p-3">
                <DataPagination page={page} totalPages={totalPages} total={preview.length}
                  pageSize={PAGE_SIZE} onPageChange={setPage} />
              </div>
            </div>
          )}

          {preview && preview.length === 0 && (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              {t('No products match the current filters')}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-2">
          {preview && (
            <span className="me-auto self-center text-sm text-muted-foreground">
              {t('{{count}} product(s) affected', { count: preview.length })}
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            {t('Cancel')}
          </Button>
          <Button variant="outline" onClick={handlePreview} disabled={loading || applying}>
            {loading && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Preview')}
          </Button>
          <Button onClick={handleApply} disabled={!preview || preview.length === 0 || applying}>
            {applying && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
