import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Search, X, Loader2, TrendingUp, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Trash2 } from 'lucide-react';
import type { Product, Category, BulkPriceUpdateOptions, BulkPriceUpdatePreviewRow } from '@/api/types';
import { api } from '@/api';
import { formatCurrency } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings.store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DataPagination } from '@/components/ui/data-pagination';

const PAGE_SIZE = 25;

/** A selected product with its explicit new prices (manual mode). */
interface ManualRow {
  productId: number;
  name: string;
  parentUnit: string;
  childUnit: string;
  cf: number;
  currentSell: number;
  currentSellChild: number;
  newSell: number;
  newSellChild: number;
  childTouched: boolean;
}

export function BulkPriceUpdatePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isRtl = i18n.dir() === 'rtl';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  const [tab, setTab] = useState<'margin' | 'manual'>('margin');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [applying, setApplying] = useState(false);

  // ── Margin mode state ──────────────────────────────────────────────────────
  const [mode, setMode] = useState<'margin_over_cost' | 'increase_current'>('margin_over_cost');
  const [percent, setPercent] = useState<number>(defaultMarkup);
  const [rounding, setRounding] = useState<1 | 50 | 100>(100);
  const [excludedCats, setExcludedCats] = useState<Set<number>>(new Set());
  const [excludedProds, setExcludedProds] = useState<Set<number>>(new Set());
  const [exclQuery, setExclQuery] = useState('');
  const [exclSearchOpen, setExclSearchOpen] = useState(false);
  const [preview, setPreview] = useState<BulkPriceUpdatePreviewRow[] | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // ── Manual mode state ──────────────────────────────────────────────────────
  const [manualRows, setManualRows] = useState<ManualRow[]>([]);
  const [manQuery, setManQuery] = useState('');
  const [manSearchOpen, setManSearchOpen] = useState(false);

  useEffect(() => {
    api.categories.getAll().then(setCategories).catch(() => setCategories([]));
    api.products.getAll().then(setProducts).catch(() => setProducts([]));
  }, []);

  // Stale-preview reset when margin inputs change.
  useEffect(() => { setPreview(null); setPage(1); }, [mode, percent, rounding, excludedCats, excludedProds]);

  const searchProducts = (q: string, excludeIds: Set<number>) => {
    const query = q.trim().toLowerCase();
    if (query.length < 2) return [];
    return products
      .filter((p) => !excludeIds.has(p.id))
      .filter((p) => p.name.toLowerCase().includes(query)
        || (p.generic_name && p.generic_name.toLowerCase().includes(query))
        || (p.barcode && p.barcode.includes(q.trim())))
      .slice(0, 8);
  };

  // ── Margin mode helpers ────────────────────────────────────────────────────
  const buildOpts = (): BulkPriceUpdateOptions => ({
    mode, percent, rounding,
    exclude_product_ids: [...excludedProds],
    exclude_category_ids: [...excludedCats],
  });

  const exclResults = useMemo(() => searchProducts(exclQuery, excludedProds), [exclQuery, products, excludedProds]); // eslint-disable-line react-hooks/exhaustive-deps
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

  async function handleApplyMargin() {
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
      setPreview(null);
    } catch (err) {
      toast.error((err as Error).message || t('Failed to apply price update'));
    } finally {
      setApplying(false);
    }
  }

  // ── Manual mode helpers ────────────────────────────────────────────────────
  const manualIds = useMemo(() => new Set(manualRows.map((r) => r.productId)), [manualRows]);
  const manResults = useMemo(() => searchProducts(manQuery, manualIds), [manQuery, products, manualIds]); // eslint-disable-line react-hooks/exhaustive-deps

  function addManual(p: Product) {
    const cf = p.conversion_factor && p.conversion_factor > 1 ? p.conversion_factor : 1;
    const current = p.selling_price ?? 0;
    setManualRows((prev) => [...prev, {
      productId: p.id,
      name: p.name,
      parentUnit: p.parent_unit ?? 'Box',
      childUnit: p.child_unit ?? '',
      cf,
      currentSell: current,
      currentSellChild: p.selling_price_child ?? 0,
      newSell: current,
      newSellChild: cf > 1 ? (p.selling_price_child ?? (current > 0 ? Math.floor(current / cf) : 0)) : 0,
      childTouched: false,
    }]);
    setManQuery('');
    setManSearchOpen(false);
  }

  function updateManual(productId: number, patch: Partial<ManualRow>) {
    setManualRows((prev) => prev.map((r) => {
      if (r.productId !== productId) return r;
      const next = { ...r, ...patch };
      // Keep the small-unit price derived from the parent until manually edited.
      if (patch.newSell !== undefined && !next.childTouched && next.cf > 1) {
        next.newSellChild = next.newSell > 0 ? Math.floor(next.newSell / next.cf) : 0;
      }
      return next;
    }));
  }

  const manualValid = manualRows.length > 0 && manualRows.every((r) => r.newSell > 0);

  async function handleApplyManual() {
    if (!manualValid) return;
    const ok = await confirm({
      title: t('Apply price update'),
      description: t('Update selling prices for {{count}} product(s)? This cannot be undone automatically.', { count: manualRows.length }),
    });
    if (!ok) return;

    setApplying(true);
    try {
      const res = await api.batches.applyManualPriceUpdate(manualRows.map((r) => ({
        product_id: r.productId,
        selling_price_parent: r.newSell,
        selling_price_child: r.cf > 1 && r.newSellChild > 0 ? r.newSellChild : null,
      })));
      toast.success(t('Updated {{products}} product(s) across {{batches}} batch(es)', {
        products: res.updatedProducts, batches: res.updatedBatches,
      }));
      setManualRows([]);
    } catch (err) {
      toast.error((err as Error).message || t('Failed to apply price update'));
    } finally {
      setApplying(false);
    }
  }

  const totalPages = preview ? Math.max(1, Math.ceil(preview.length / PAGE_SIZE)) : 1;
  const pageRows = preview ? preview.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/inventory')} title={t('Back to Inventory')}>
          <BackIcon className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-48">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6" />
            {t('Bulk Price Update')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('Set selling prices from each product’s latest batch by margin, or pick specific products and set their prices directly.')}
          </p>
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1.5">
        <Button size="sm" variant={tab === 'margin' ? 'default' : 'outline'} onClick={() => setTab('margin')}>
          {t('By Margin')}
        </Button>
        <Button size="sm" variant={tab === 'manual' ? 'default' : 'outline'} onClick={() => setTab('manual')}>
          {t('Selected Products')}
        </Button>
      </div>

      {tab === 'margin' && (
        <Card>
          <CardContent className="p-4 space-y-4">
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
              <div className="ms-auto flex gap-2">
                <Button variant="outline" onClick={handlePreview} disabled={loading || applying}>
                  {loading && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
                  {t('Preview')}
                </Button>
                <Button onClick={handleApplyMargin} disabled={!preview || preview.length === 0 || applying}>
                  {applying && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
                  {t('Apply')}
                </Button>
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
            <div className="space-y-1.5 max-w-2xl">
              <Label className="text-xs text-muted-foreground">{t('Exclude specific products')}</Label>
              <div className="relative">
                <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={exclQuery} className="ps-9"
                  placeholder={t('Search products to exclude...')}
                  onChange={(e) => { setExclQuery(e.target.value); setExclSearchOpen(true); }}
                  onFocus={() => setExclSearchOpen(true)} />
                {exclSearchOpen && exclResults.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
                    <div className="max-h-48 overflow-y-auto p-1">
                      {exclResults.map((p) => (
                        <button key={p.id}
                          className="w-full text-start px-3 py-2 text-sm hover:bg-accent rounded-sm"
                          onClick={() => { setExcludedProds((prev) => new Set(prev).add(p.id)); setExclQuery(''); setExclSearchOpen(false); }}>
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
                      <button onClick={() => setExcludedProds((prev) => { const next = new Set(prev); next.delete(p.id); return next; })} className="ms-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Preview table */}
            {preview && preview.length > 0 && (
              <div className="rounded-md border overflow-x-auto">
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
            {preview && (
              <p className="text-sm text-muted-foreground">
                {t('{{count}} product(s) affected', { count: preview.length })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'manual' && (
        <Card>
          <CardContent className="p-4 space-y-4">
            {/* Product picker */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-64 max-w-2xl">
                <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={manQuery} className="ps-9"
                  placeholder={t('Search products to add...')}
                  onChange={(e) => { setManQuery(e.target.value); setManSearchOpen(true); }}
                  onFocus={() => setManSearchOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && manResults.length > 0) {
                      e.preventDefault();
                      addManual(manResults[0]);
                    }
                  }} />
                {manSearchOpen && manResults.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
                    <div className="max-h-48 overflow-y-auto p-1">
                      {manResults.map((p) => (
                        <button key={p.id}
                          className="w-full flex items-center justify-between text-start px-3 py-2 text-sm hover:bg-accent rounded-sm"
                          onClick={() => addManual(p)}>
                          <span>{p.name}
                            {p.generic_name && <span className="text-xs text-muted-foreground ms-2">({p.generic_name})</span>}
                          </span>
                          {(p.selling_price ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground">{formatCurrency(p.selling_price!)}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <Button onClick={handleApplyManual} disabled={!manualValid || applying}>
                {applying && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
                {t('Apply')}
              </Button>
            </div>

            {/* Manual rows table */}
            {manualRows.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                {t('No products selected — search above to add products.')}
              </div>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Product')}</TableHead>
                      <TableHead className="text-end">{t('Current')}</TableHead>
                      <TableHead className="text-end">{t('New sell')}/{t('base unit')}</TableHead>
                      <TableHead className="text-end">{t('New sell')}/{t('small unit')}</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {manualRows.map((r) => (
                      <TableRow key={r.productId}>
                        <TableCell>
                          <div className="font-medium">{r.name}</div>
                          {r.cf > 1 && (
                            <div className="text-xs text-muted-foreground">1 {r.parentUnit} = {r.cf} {r.childUnit}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-muted-foreground">
                          {formatCurrency(r.currentSell)}
                          {r.cf > 1 && r.currentSellChild > 0 && (
                            <div className="text-xs">{formatCurrency(r.currentSellChild)}/{r.childUnit}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          <Input type="number" min={0}
                            className={`h-8 w-28 text-end ms-auto ${r.newSell <= 0 ? 'ring-1 ring-destructive' : ''}`}
                            value={r.newSell || ''}
                            onChange={(e) => updateManual(r.productId, { newSell: Math.round(Number(e.target.value) || 0) })} />
                        </TableCell>
                        <TableCell className="text-end">
                          {r.cf > 1 ? (
                            <Input type="number" min={0}
                              className="h-8 w-28 text-end ms-auto"
                              value={r.newSellChild || ''}
                              placeholder={t('auto')}
                              onChange={(e) => updateManual(r.productId, { newSellChild: Math.round(Number(e.target.value) || 0), childTouched: true })} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" className="h-8 w-8"
                            onClick={() => setManualRows((prev) => prev.filter((x) => x.productId !== r.productId))}
                            title={t('Remove')}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {manualRows.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t('{{count}} product(s) affected', { count: manualRows.length })}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
