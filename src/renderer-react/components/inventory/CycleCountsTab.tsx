import { useState, useEffect, useMemo } from 'react';
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DataPagination } from '@/components/ui/data-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';

const BUILDER_PAGE_SIZE = 12;
const DETAIL_PAGE_SIZE = 25;

// Format a base (smallest-unit) quantity as "3 box + 2 strip".
function fmtUnits(base: number, cf?: number, parent?: string, child?: string): string {
  const c = cf ?? 1;
  const childU = child || 'unit';
  if (c > 1) {
    const b = Math.floor(base / c);
    const s = base % c;
    const parts: string[] = [];
    if (b) parts.push(`${b} ${parent || 'box'}`);
    if (s || !b) parts.push(`${s} ${childU}`);
    return parts.join(' + ');
  }
  return `${base} ${childU}`;
}

export function CycleCountsTab() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [innerTab, setInnerTab] = useState<'counts' | 'variance'>('counts');
  const [counts, setCounts] = useState<CycleCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCountId, setSelectedCountId] = useState<number | null>(null);
  const [selectedCount, setSelectedCount] = useState<CycleCount | null>(null);

  // Builder
  const [builderOpen, setBuilderOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [prodSearch, setProdSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [builderPage, setBuilderPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Detail
  const [itemSearch, setItemSearch] = useState('');
  const [detailPage, setDetailPage] = useState(1);
  const [draft, setDraft] = useState<Record<number, { boxes: string; strips: string }>>({});

  // Variance tab
  const [varCountId, setVarCountId] = useState<number | null>(null);
  const [varCount, setVarCount] = useState<CycleCount | null>(null);
  const [varType, setVarType] = useState<'all' | 'shortage' | 'overage'>('all');
  const [varSearch, setVarSearch] = useState('');

  const fetchCounts = async () => {
    try { setLoading(true); setCounts(await api.cycleCounts.getAll()); }
    catch (err) { console.error(err); } finally { setLoading(false); }
  };

  useEffect(() => { if (!selectedCountId) fetchCounts(); }, [selectedCountId]);
  useEffect(() => { if (selectedCountId) loadCountDetails(selectedCountId); }, [selectedCountId]);
  useEffect(() => { setDetailPage(1); }, [itemSearch, selectedCountId]);

  // Seed the counted draft (boxes/strips) from the loaded items.
  useEffect(() => {
    if (!selectedCount?.items) return;
    const d: Record<number, { boxes: string; strips: string }> = {};
    for (const it of selectedCount.items) {
      const cf = it.conversion_factor ?? 1;
      if (it.counted_quantity == null) { d[it.id] = { boxes: '', strips: '' }; continue; }
      d[it.id] = cf > 1
        ? { boxes: String(Math.floor(it.counted_quantity / cf)), strips: String(it.counted_quantity % cf) }
        : { boxes: '', strips: String(it.counted_quantity) };
    }
    setDraft(d);
  }, [selectedCount?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCountDetails = async (id: number) => {
    try { setSelectedCount(await api.cycleCounts.getById(id)); } catch (err) { console.error(err); }
  };

  // ── Builder ─────────────────────────────────────────────────────────────────
  const openBuilder = async () => {
    setNewName(''); setProdSearch(''); setCatFilter('all'); setBuilderPage(1); setSelectedIds(new Set());
    setBuilderOpen(true);
    if (allProducts.length === 0) { try { setAllProducts(await api.products.getAll()); } catch { /* ignore */ } }
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
      return p.name.toLowerCase().includes(q) || (p.generic_name ?? '').toLowerCase().includes(q) || (p.barcode ?? '').toLowerCase().includes(q);
    });
  }, [allProducts, prodSearch, catFilter]);
  const builderTotalPages = Math.max(1, Math.ceil(filteredProducts.length / BUILDER_PAGE_SIZE));
  const builderPageItems = filteredProducts.slice((builderPage - 1) * BUILDER_PAGE_SIZE, builderPage * BUILDER_PAGE_SIZE);
  const toggleProduct = (id: number) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAllFiltered = () => setSelectedIds(prev => { const n = new Set(prev); filteredProducts.forEach(p => n.add(p.id)); return n; });

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
    } catch (err: any) { toast.error(err.message || t('Failed to create stock count')); }
    finally { setCreating(false); }
  };

  const handleStart = async (id: number) => {
    try { const { throwIfError } = await import('@/api'); throwIfError(await api.cycleCounts.start(id) as any); fetchCounts(); }
    catch (err: any) { toast.error(err.message || t('Failed to start')); }
  };
  const handleComplete = async (id: number) => {
    if (!(await confirm({ description: t('Complete cycle count and apply adjustments?') }))) return;
    try { const { throwIfError } = await import('@/api'); throwIfError(await api.cycleCounts.complete(id, true) as any); setSelectedCountId(null); }
    catch (err: any) { toast.error(err.message || t('Failed to complete')); }
  };
  const recordItem = async (itemId: number, base: number) => {
    if (isNaN(base) || base < 0) return;
    try { const { throwIfError } = await import('@/api'); throwIfError(await api.cycleCounts.recordCount(itemId, base) as any); loadCountDetails(selectedCountId!); }
    catch (err: any) { toast.error(err.message || t('Failed to record count')); }
  };
  const commitDraft = (item: CycleCountItem) => {
    const cf = item.conversion_factor ?? 1;
    const d = draft[item.id] ?? { boxes: '', strips: '' };
    const boxes = parseInt(d.boxes || '0', 10) || 0;
    const strips = parseInt(d.strips || '0', 10) || 0;
    if (d.boxes === '' && d.strips === '') return; // nothing entered
    recordItem(item.id, boxes * cf + strips);
  };

  // ── Variance tab data (hooks must stay ABOVE the detail-view early return —
  //    a hook after a conditional return crashes React with "Rendered fewer hooks
  //    than expected" when navigating between list and detail) ─────────────────
  const loadVariance = async (id: number) => {
    setVarCountId(id);
    try { setVarCount(await api.cycleCounts.getById(id)); } catch (err) { console.error(err); }
  };
  const completedCounts = counts.filter(c => c.status === 'completed' || c.status === 'in_progress');
  // Default the variance view to the most recent completed/in-progress count.
  useEffect(() => {
    if (innerTab === 'variance' && varCountId == null && completedCounts.length > 0) loadVariance(completedCounts[0].id);
  }, [innerTab, counts]); // eslint-disable-line react-hooks/exhaustive-deps

  // ════════════════════════════════════════════════════════════════════════════
  // Count detail (product-level: count totals as boxes + strips)
  // ════════════════════════════════════════════════════════════════════════════
  if (selectedCountId && selectedCount) {
    const q = itemSearch.trim().toLowerCase();
    const allItems = selectedCount.items ?? [];
    const visible = q ? allItems.filter(it => it.product_name?.toLowerCase().includes(q)) : allItems;
    const totalPages = Math.max(1, Math.ceil(visible.length / DETAIL_PAGE_SIZE));
    const pageItems = visible.slice((detailPage - 1) * DETAIL_PAGE_SIZE, detailPage * DETAIL_PAGE_SIZE);
    const editable = selectedCount.status === 'in_progress';

    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setSelectedCountId(null)}><ArrowLeft className="h-5 w-5" /></Button>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{selectedCount.name}</h2>
            <p className="text-sm text-muted-foreground">{t(selectedCount.status)} · {allItems.length} {t('products')}</p>
          </div>
          <div className="relative w-full sm:w-64 ms-auto sm:ms-0 order-last sm:order-none">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8" placeholder={t('Search product...')} value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />
          </div>
          {editable && (
            <Button onClick={() => handleComplete(selectedCount.id)}><Check className="h-4 w-4 me-2" />{t('Complete & Adjust')}</Button>
          )}
        </div>

        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CardContent className="flex-1 min-h-0 p-0 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Product')}</TableHead>
                  <TableHead className="text-end">{t('System Qty')}</TableHead>
                  <TableHead className="w-72">{t('Counted Qty')}</TableHead>
                  <TableHead className="text-end">{t('Variance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map(item => {
                  const cf = item.conversion_factor ?? 1;
                  const d = draft[item.id] ?? { boxes: '', strips: '' };
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.product_name}</TableCell>
                      <TableCell className="text-end whitespace-nowrap">{fmtUnits(item.expected_quantity, cf, item.parent_unit, item.child_unit)}</TableCell>
                      <TableCell>
                        {editable ? (
                          <div className="flex items-center gap-1.5 justify-start">
                            {cf > 1 && (
                              <>
                                <Input type="number" min={0} className="w-16 text-end" placeholder="0"
                                  value={d.boxes}
                                  onChange={(e) => setDraft(p => ({ ...p, [item.id]: { ...d, boxes: e.target.value } }))}
                                  onBlur={() => commitDraft(item)} />
                                <span className="text-xs text-muted-foreground">{item.parent_unit || 'box'}</span>
                                <span className="text-muted-foreground">+</span>
                              </>
                            )}
                            <Input type="number" min={0} className="w-16 text-end" placeholder="0"
                              value={d.strips}
                              onChange={(e) => setDraft(p => ({ ...p, [item.id]: { ...d, strips: e.target.value } }))}
                              onBlur={() => commitDraft(item)} />
                            <span className="text-xs text-muted-foreground">{item.child_unit || 'unit'}</span>
                          </div>
                        ) : (
                          item.counted_quantity != null ? fmtUnits(item.counted_quantity, cf, item.parent_unit, item.child_unit) : '---'
                        )}
                      </TableCell>
                      <TableCell className="text-end whitespace-nowrap font-medium">
                        {item.variance != null && item.variance !== 0 ? (
                          <span className={item.variance < 0 ? 'text-red-500' : 'text-green-500'}>
                            {item.variance < 0 ? '-' : '+'}{fmtUnits(Math.abs(item.variance), cf, item.parent_unit, item.child_unit)}
                          </span>
                        ) : item.variance === 0 ? <span className="text-muted-foreground">0</span> : '---'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!visible.length && (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    {allItems.length ? t('No products match your search') : t('No items to count')}
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        {totalPages > 1 && <DataPagination page={detailPage} totalPages={totalPages} total={visible.length} pageSize={DETAIL_PAGE_SIZE} onPageChange={setDetailPage} />}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Main view — internal tabs: Counts | Variance
  // (loadVariance / completedCounts / variance-default effect are declared above
  //  the detail-view early return so hook order stays stable.)
  // ════════════════════════════════════════════════════════════════════════════

  const varItems = (varCount?.items ?? []).filter(it => {
    if (it.variance == null || it.variance === 0) return false;
    if (varType === 'shortage' && !(it.variance < 0)) return false;
    if (varType === 'overage' && !(it.variance > 0)) return false;
    const q = varSearch.trim().toLowerCase();
    if (q && !it.product_name?.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <Tabs value={innerTab} onValueChange={(v) => setInnerTab(v as 'counts' | 'variance')} className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList>
            <TabsTrigger value="counts">{t('Counts')}</TabsTrigger>
            <TabsTrigger value="variance">{t('Variance')}</TabsTrigger>
          </TabsList>
          {innerTab === 'counts' && (
            <Button onClick={openBuilder} className="gap-2"><Plus className="h-4 w-4" />{t('New Stock Count')}</Button>
          )}
        </div>

        {/*
          ── Counts ──
          data-[state=active]:flex, not `flex`: Radix hides an inactive
          TabsContent via the `hidden` attribute (browser default
          display:none). A plain `flex` utility has equal specificity and
          wins the cascade, keeping the "inactive" panel laid out and
          stealing height from whichever tab is actually active.
        */}
        <TabsContent value="counts" className="flex-1 min-h-0 overflow-hidden data-[state=active]:flex flex-col mt-3">
          <Card className="h-full min-h-0 flex flex-col overflow-hidden">
            <CardContent className="flex-1 min-h-0 p-0 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Name')}</TableHead><TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Created By')}</TableHead><TableHead>{t('Created At')}</TableHead>
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
                          cc.status === 'in_progress' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'}`}>{t(cc.status)}</span>
                      </TableCell>
                      <TableCell>{cc.created_by_username}</TableCell>
                      <TableCell>{new Date(cc.created_at).toLocaleString()}</TableCell>
                      <TableCell className="text-end space-x-2">
                        {cc.status === 'pending' && <Button size="sm" variant="outline" onClick={() => handleStart(cc.id)}><Play className="h-4 w-4 me-1" />{t('Start')}</Button>}
                        {(cc.status === 'in_progress' || cc.status === 'completed') && <Button size="sm" variant="secondary" onClick={() => setSelectedCountId(cc.id)}>{t('View')}</Button>}
                      </TableCell>
                    </TableRow>
                  ))}
                  {counts.length === 0 && !loading && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">{t('No cycle counts found')}</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Variance ── */}
        {/* data-[state=active]:flex — see comment on the "counts" TabsContent above. */}
        <TabsContent value="variance" className="flex-1 min-h-0 overflow-hidden data-[state=active]:flex flex-col mt-3">
          <div className="flex h-full flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={varCountId ? String(varCountId) : ''} onValueChange={(v) => loadVariance(Number(v))}>
                <SelectTrigger className="w-56"><SelectValue placeholder={t('Select a count')} /></SelectTrigger>
                <SelectContent>
                  {completedCounts.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={varType} onValueChange={(v) => setVarType(v as any)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  <SelectItem value="shortage">{t('Shortage')}</SelectItem>
                  <SelectItem value="overage">{t('Overage')}</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative min-w-[160px] flex-1">
                <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="ps-8" placeholder={t('Search product...')} value={varSearch} onChange={(e) => setVarSearch(e.target.value)} />
              </div>
            </div>
            <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <CardContent className="flex-1 min-h-0 p-0 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Product')}</TableHead>
                      <TableHead className="text-end">{t('System Qty')}</TableHead>
                      <TableHead className="text-end">{t('Counted Qty')}</TableHead>
                      <TableHead className="text-end">{t('Variance')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {varItems.map(it => {
                      const cf = it.conversion_factor ?? 1;
                      return (
                        <TableRow key={it.id}>
                          <TableCell className="font-medium">{it.product_name}</TableCell>
                          <TableCell className="text-end whitespace-nowrap">{fmtUnits(it.expected_quantity, cf, it.parent_unit, it.child_unit)}</TableCell>
                          <TableCell className="text-end whitespace-nowrap">{it.counted_quantity != null ? fmtUnits(it.counted_quantity, cf, it.parent_unit, it.child_unit) : '---'}</TableCell>
                          <TableCell className="text-end whitespace-nowrap font-bold">
                            <span className={it.variance! < 0 ? 'text-red-500' : 'text-green-500'}>
                              {it.variance! < 0 ? '-' : '+'}{fmtUnits(Math.abs(it.variance!), cf, it.parent_unit, it.child_unit)}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {varItems.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        {completedCounts.length === 0 ? t('No counts yet') : t('No variances found')}
                      </TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* New Stock Count builder */}
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
                <Input className="ps-8" placeholder={t('Search product...')} value={prodSearch} onChange={(e) => { setProdSearch(e.target.value); setBuilderPage(1); }} />
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
                <button type="button" className="hover:underline" onClick={() => setSelectedIds(new Set())}>{t('Clear')}</button>
              </div>
            </div>
            <div className="rounded-md border max-h-72 overflow-auto">
              <Table>
                <TableBody>
                  {builderPageItems.map(p => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => toggleProduct(p.id)}>
                      <TableCell className="w-10"><input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleProduct(p.id)} onClick={(e) => e.stopPropagation()} /></TableCell>
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
            {builderTotalPages > 1 && <DataPagination page={builderPage} totalPages={builderTotalPages} total={filteredProducts.length} pageSize={BUILDER_PAGE_SIZE} onPageChange={setBuilderPage} />}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setBuilderOpen(false)} disabled={creating}>{t('Cancel')}</Button>
            <Button onClick={submitBuilder} disabled={creating || !newName.trim() || selectedIds.size === 0}>{t('Start count')} ({selectedIds.size})</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
