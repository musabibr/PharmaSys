import { useState, useEffect, Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Plus, Play, Check, ArrowLeft, Search } from 'lucide-react';
import { api } from '@/api';
import type { CycleCount, CycleCountItem, Product } from '@/api/types';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DataPagination } from '@/components/ui/data-pagination';

const BUILDER_PAGE_SIZE = 12;
const DETAIL_PAGE_SIZE = 25;

export function CycleCountsTab() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<CycleCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCountId, setSelectedCountId] = useState<number | null>(null);
  const [selectedCount, setSelectedCount] = useState<CycleCount | null>(null);

  // ── New-count builder ───────────────────────────────────────────────────────
  const [builderOpen, setBuilderOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [prodSearch, setProdSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [builderPage, setBuilderPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ── Detail view ──────────────────────────────────────────────────────────────
  const [itemSearch, setItemSearch] = useState('');
  const [viewMode, setViewMode] = useState<'batch' | 'product'>('batch');
  const [unitMode, setUnitMode] = useState<'small' | 'large'>('small');
  const [detailPage, setDetailPage] = useState(1);

  const fetchCounts = async () => {
    try {
      setLoading(true);
      setCounts(await api.cycleCounts.getAll());
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  useEffect(() => { if (!selectedCountId) fetchCounts(); }, [selectedCountId]);
  useEffect(() => { if (selectedCountId) loadCountDetails(selectedCountId); }, [selectedCountId]);
  useEffect(() => { setDetailPage(1); }, [itemSearch, viewMode, selectedCountId]);

  const loadCountDetails = async (id: number) => {
    try { setSelectedCount(await api.cycleCounts.getById(id)); } catch (err) { console.error(err); }
  };

  // ── Builder ───────────────────────────────────────────────────────────────────
  const openBuilder = async () => {
    setNewName(''); setProdSearch(''); setCatFilter('all'); setBuilderPage(1);
    setSelectedIds(new Set());
    setBuilderOpen(true);
    if (allProducts.length === 0) {
      try { setAllProducts(await api.products.getAll()); } catch { /* ignore */ }
    }
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProducts) if (p.category_name) set.add(p.category_name);
    return Array.from(set).sort();
  }, [allProducts]);

  const filteredProducts = useMemo(() => {
    const q = prodSearch.trim().toLowerCase();
    return allProducts.filter(p => {
      if (catFilter !== 'all' && p.category_name !== catFilter) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) ||
        (p.generic_name ?? '').toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q);
    });
  }, [allProducts, prodSearch, catFilter]);

  const builderTotalPages = Math.max(1, Math.ceil(filteredProducts.length / BUILDER_PAGE_SIZE));
  const builderPageItems = filteredProducts.slice((builderPage - 1) * BUILDER_PAGE_SIZE, builderPage * BUILDER_PAGE_SIZE);

  const toggleProduct = (id: number) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const selectAllFiltered = () => setSelectedIds(prev => { const n = new Set(prev); filteredProducts.forEach(p => n.add(p.id)); return n; });
  const clearSelection = () => setSelectedIds(new Set());

  const submitBuilder = async () => {
    const name = newName.trim();
    if (!name) { toast.error(t('Enter a name')); return; }
    if (selectedIds.size === 0) { toast.error(t('Select at least one product')); return; }
    setCreating(true);
    try {
      const { throwIfError } = await import('@/api');
      const created = await api.cycleCounts.create({ name });
      throwIfError(created as any);
      await api.cycleCounts.start(created.id, Array.from(selectedIds));
      setBuilderOpen(false);
      setSelectedCountId(created.id);
    } catch (err: any) {
      toast.error(err.message || t('Failed to create stock count'));
    } finally { setCreating(false); }
  };

  // Legacy "Start" for any pending count created without a scope → all active stock.
  const handleStart = async (id: number) => {
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.start(id) as any);
      fetchCounts();
    } catch (err: any) { toast.error(err.message || t('Failed to start')); }
  };

  const handleComplete = async (id: number) => {
    if (!confirm(t('Complete cycle count and apply adjustments?'))) return;
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.complete(id, true) as any);
      setSelectedCountId(null);
    } catch (err: any) { toast.error(err.message || t('Failed to complete')); }
  };

  const handleRecord = async (itemId: number, value: string) => {
    const qty = parseInt(value, 10);
    if (isNaN(qty) || qty < 0) return;
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.recordCount(itemId, qty) as any);
      loadCountDetails(selectedCountId!);
    } catch (err: any) { toast.error(err.message || t('Failed to record count')); }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // Detail view
  // ════════════════════════════════════════════════════════════════════════════
  if (selectedCountId && selectedCount) {
    const q = itemSearch.trim().toLowerCase();
    const allItems = selectedCount.items ?? [];
    const visibleItems = q
      ? allItems.filter(it => it.product_name?.toLowerCase().includes(q) || it.batch_number?.toLowerCase().includes(q))
      : allItems;

    // Unit display: base quantities stored in child units; "large" converts to parent.
    const unitLabel = (it: CycleCountItem) =>
      (unitMode === 'large' && (it.conversion_factor ?? 1) > 1 ? it.parent_unit : it.child_unit) || '—';
    const fmtQty = (base: number, it: CycleCountItem) => {
      const cf = it.conversion_factor ?? 1;
      if (unitMode === 'large' && cf > 1) { const v = base / cf; return Number.isInteger(v) ? String(v) : v.toFixed(2); }
      return String(base);
    };
    const varianceSpan = (v: number, it: CycleCountItem) => (
      <span className={v < 0 ? 'text-red-500' : v > 0 ? 'text-green-500' : ''}>
        {v > 0 ? '+' : ''}{fmtQty(Math.abs(v), it) === String(Math.abs(v)) ? v : (v < 0 ? '-' : '') + fmtQty(Math.abs(v), it)}
      </span>
    );

    // Group for "By product" display (counting stays per batch → integrity preserved).
    const groups: Array<{ productId: number; productName: string; items: CycleCountItem[];
      sumExpected: number; sumCounted: number; sumVariance: number; anyCounted: boolean; unit: string }> = [];
    {
      const byProduct = new Map<number, (typeof groups)[number]>();
      for (const it of visibleItems) {
        let g = byProduct.get(it.product_id);
        if (!g) {
          g = { productId: it.product_id, productName: it.product_name ?? '—', items: [],
                sumExpected: 0, sumCounted: 0, sumVariance: 0, anyCounted: false, unit: unitLabel(it) };
          byProduct.set(it.product_id, g); groups.push(g);
        }
        g.items.push(it);
        g.sumExpected += it.expected_quantity ?? 0;
        if (it.counted_quantity != null) { g.sumCounted += it.counted_quantity; g.anyCounted = true; }
        if (it.variance != null) g.sumVariance += it.variance;
      }
    }

    // Pagination over the top-level entity (items in batch mode, products in product mode)
    const totalEntities = viewMode === 'product' ? groups.length : visibleItems.length;
    const totalPages = Math.max(1, Math.ceil(totalEntities / DETAIL_PAGE_SIZE));
    const pageStart = (detailPage - 1) * DETAIL_PAGE_SIZE;
    const pageGroups = viewMode === 'product' ? groups.slice(pageStart, pageStart + DETAIL_PAGE_SIZE) : [];
    const pageItems = viewMode === 'batch' ? visibleItems.slice(pageStart, pageStart + DETAIL_PAGE_SIZE) : [];

    const renderItemRow = (item: CycleCountItem, showProduct: boolean) => (
      <TableRow key={item.id}>
        <TableCell className={showProduct ? 'font-medium' : 'ps-8 text-muted-foreground'}>
          {showProduct ? item.product_name : ''}
        </TableCell>
        <TableCell>{item.batch_number || '---'}</TableCell>
        <TableCell className="text-muted-foreground text-xs">{unitLabel(item)}</TableCell>
        <TableCell className="text-end">{fmtQty(item.expected_quantity, item)}</TableCell>
        <TableCell className="text-end">
          {selectedCount.status === 'in_progress' ? (
            <Input
              type="number" min={0}
              className="w-24 ms-auto text-end"
              defaultValue={item.counted_quantity ?? ''}
              onBlur={(e) => handleRecord(item.id, e.target.value)}
            />
          ) : (item.counted_quantity ?? '---')}
        </TableCell>
        <TableCell className="text-end font-medium">
          {item.variance !== null ? varianceSpan(item.variance, item) : '---'}
        </TableCell>
      </TableRow>
    );

    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setSelectedCountId(null)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{selectedCount.name}</h2>
            <p className="text-sm text-muted-foreground">{t(selectedCount.status)} · {allItems.length} {t('items')}</p>
          </div>
          <div className="relative w-full sm:w-56 ms-auto sm:ms-0 order-last sm:order-none">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8" placeholder={t('Search product or batch...')} value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />
          </div>
          <Select value={viewMode} onValueChange={(v) => setViewMode(v as 'batch' | 'product')}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="batch">{t('Per batch')}</SelectItem>
              <SelectItem value="product">{t('By product')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={unitMode} onValueChange={(v) => setUnitMode(v as 'small' | 'large')}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{t('Small unit')}</SelectItem>
              <SelectItem value="large">{t('Large unit')}</SelectItem>
            </SelectContent>
          </Select>
          {selectedCount.status === 'in_progress' && (
            <Button onClick={() => handleComplete(selectedCount.id)}>
              <Check className="h-4 w-4 me-2" />{t('Complete & Adjust')}
            </Button>
          )}
        </div>

        <Card className="flex-1 flex flex-col overflow-hidden">
          <CardContent className="flex-1 p-0 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Product')}</TableHead>
                  <TableHead>{t('Batch')}</TableHead>
                  <TableHead>{t('Unit')}</TableHead>
                  <TableHead className="text-end">{t('System Qty')}</TableHead>
                  <TableHead className="text-end w-44">{t('Counted Qty')}</TableHead>
                  <TableHead className="text-end">{t('Variance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewMode === 'product'
                  ? pageGroups.map(g => (
                      <Fragment key={g.productId}>
                        <TableRow className="bg-muted/50">
                          <TableCell className="font-semibold">{g.productName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{g.items.length} {t('batches')}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{g.unit}</TableCell>
                          <TableCell className="text-end font-medium">{fmtQty(g.sumExpected, g.items[0])}</TableCell>
                          <TableCell className="text-end font-medium">{g.anyCounted ? fmtQty(g.sumCounted, g.items[0]) : '—'}</TableCell>
                          <TableCell className="text-end font-bold">{g.anyCounted ? varianceSpan(g.sumVariance, g.items[0]) : '—'}</TableCell>
                        </TableRow>
                        {g.items.map(it => renderItemRow(it, false))}
                      </Fragment>
                    ))
                  : pageItems.map(it => renderItemRow(it, true))}
                {!visibleItems.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      {allItems.length ? t('No products match your search') : t('No items to count')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {totalPages > 1 && (
          <DataPagination page={detailPage} totalPages={totalPages} total={totalEntities} pageSize={DETAIL_PAGE_SIZE} onPageChange={setDetailPage} />
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // List view
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('Stock Count')}</h2>
        <Button onClick={openBuilder} className="gap-2">
          <Plus className="h-4 w-4" />{t('New Stock Count')}
        </Button>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardContent className="flex-1 p-0 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Name')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead>{t('Created By')}</TableHead>
                <TableHead>{t('Created At')}</TableHead>
                <TableHead className="text-end">{t('Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.map(cc => (
                <TableRow key={cc.id}>
                  <TableCell className="font-medium">
                    <button className="hover:underline text-start" onClick={() => setSelectedCountId(cc.id)}>{cc.name}</button>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                      cc.status === 'completed' ? 'bg-green-100 text-green-700' :
                      cc.status === 'in_progress' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'
                    }`}>{t(cc.status)}</span>
                  </TableCell>
                  <TableCell>{cc.created_by_username}</TableCell>
                  <TableCell>{new Date(cc.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-end space-x-2">
                    {cc.status === 'pending' && (
                      <Button size="sm" variant="outline" onClick={() => handleStart(cc.id)}>
                        <Play className="h-4 w-4 me-1" /> {t('Start')}
                      </Button>
                    )}
                    {(cc.status === 'in_progress' || cc.status === 'completed') && (
                      <Button size="sm" variant="secondary" onClick={() => setSelectedCountId(cc.id)}>{t('View')}</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {counts.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">{t('No cycle counts found')}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* New Stock Count builder — pick which products to count */}
      <Dialog open={builderOpen} onOpenChange={(o) => { if (!creating) setBuilderOpen(o); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('New Stock Count')}</DialogTitle>
            <DialogDescription>{t('Name the count and pick the products to verify (search, filter, then select).')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sc-name">{t('Name')}</Label>
              <Input id="sc-name" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('e.g. 2026-06-22 full count')} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[160px] flex-1">
                <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="ps-8" placeholder={t('Search product...')} value={prodSearch}
                  onChange={(e) => { setProdSearch(e.target.value); setBuilderPage(1); }} />
              </div>
              <Select value={catFilter} onValueChange={(v) => { setCatFilter(v); setBuilderPage(1); }}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t('Category')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All categories')}</SelectItem>
                  {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{selectedIds.size} {t('selected')}</span>
              <div className="flex gap-2">
                <button type="button" className="hover:underline" onClick={selectAllFiltered}>{t('Select all (filtered)')}</button>
                <button type="button" className="hover:underline" onClick={clearSelection}>{t('Clear')}</button>
              </div>
            </div>

            <div className="rounded-md border max-h-72 overflow-auto">
              <Table>
                <TableBody>
                  {builderPageItems.map(p => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => toggleProduct(p.id)}>
                      <TableCell className="w-10">
                        <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleProduct(p.id)} onClick={(e) => e.stopPropagation()} />
                      </TableCell>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{p.category_name || '—'}</TableCell>
                      <TableCell className="text-end text-muted-foreground text-xs">{t('stock')}: {p.total_stock_base ?? 0}</TableCell>
                    </TableRow>
                  ))}
                  {filteredProducts.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">{t('No products')}</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {builderTotalPages > 1 && (
              <DataPagination page={builderPage} totalPages={builderTotalPages} total={filteredProducts.length} pageSize={BUILDER_PAGE_SIZE} onPageChange={setBuilderPage} />
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setBuilderOpen(false)} disabled={creating}>{t('Cancel')}</Button>
            <Button onClick={submitBuilder} disabled={creating || !newName.trim() || selectedIds.size === 0}>
              {t('Start count')} ({selectedIds.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
