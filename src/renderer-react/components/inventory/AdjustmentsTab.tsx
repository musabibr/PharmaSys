import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { InventoryAdjustment, AdjustmentType, Product, Batch } from '@/api/types';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Undo2, Plus, Pencil, Search, RotateCcw } from 'lucide-react';
import { usePermission } from '@/hooks/usePermission';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useDebounce } from '@/hooks/useDebounce';
import { DataPagination } from '@/components/ui/data-pagination';
import { BatchHistoryTab } from './BatchHistoryTab';

const TYPES: AdjustmentType[] = ['damage', 'expiry', 'correction'];
const PAGE_SIZE = 25;

export function AdjustmentsTab() {
  const { t } = useTranslation();
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [reversing, setReversing] = useState<number | null>(null);

  // ─── Pagination (G7 — server-side, was an unbounded array before) ─────────
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // ─── Filters ──────────────────────────────────────────────────────────────
  const [typeFilter, setTypeFilter] = useState<AdjustmentType | 'all'>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // ─── Create / Edit dialog ───────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const debouncedProductSearch = useDebounce(productSearch, 250);
  const [showProductResults, setShowProductResults] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('');
  const [adjType, setAdjType] = useState<AdjustmentType>('damage');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canManage = usePermission('inventory.batches.damage');
  const confirm = useConfirm();

  const fetchAdjustments = useCallback(async () => {
    setLoading(true);
    try {
      const filters: Record<string, unknown> = { page, limit: PAGE_SIZE };
      if (typeFilter !== 'all') filters.type = typeFilter;
      if (startDate) filters.start_date = startDate;
      if (endDate) filters.end_date = endDate;
      if (debouncedSearch.trim()) filters.search = debouncedSearch.trim();
      const result = await api.inventory.getAdjustments(filters);
      setAdjustments(result.data ?? []);
      setTotal(result.total ?? 0);
      setTotalPages(result.totalPages ?? 1);
    } catch {
      toast.error(t('Failed to load adjustments'));
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, startDate, endDate, debouncedSearch, t]);

  useEffect(() => { fetchAdjustments(); }, [fetchAdjustments]);
  // Any filter change re-queries from page 1 — a stale page number past the
  // new result set would otherwise show an empty page with no explanation.
  useEffect(() => { setPage(1); }, [typeFilter, startDate, endDate, debouncedSearch]);

  const visible = adjustments;

  const resetFilters = () => {
    setTypeFilter('all');
    setSearch('');
    setStartDate('');
    setEndDate('');
  };

  const handleReverse = async (id: number) => {
    if (!(await confirm({ description: t('Are you sure you want to reverse this adjustment? This will restore the inventory quantity.'), destructive: true }))) return;
    setReversing(id);
    try {
      await api.inventory.reverseAdjustment(id);
      toast.success(t('Adjustment reversed successfully'));
      // The reversal itself is a new row, sorted newest-first — same
      // jump-to-page-1 reasoning as submitAdjustment above.
      if (page === 1) await fetchAdjustments(); else setPage(1);
    } catch (err: any) {
      toast.error(err.message || t('Failed to reverse adjustment'));
    } finally {
      setReversing(null);
    }
  };

  // ─── Create / Edit ──────────────────────────────────────────────────────────
  const openCreate = async () => {
    setEditingId(null);
    setProductId(null); setBatchId(null); setBatches([]);
    setQuantity(''); setAdjType('damage'); setReason('');
    setProductSearch(''); setShowProductResults(false);
    setDialogOpen(true);
  };

  const openEdit = async (adj: InventoryAdjustment) => {
    setEditingId(adj.id);
    setProductId(adj.product_id);
    setProductSearch(adj.product_name ?? '');
    setShowProductResults(false);
    setQuantity(String(adj.quantity_base));
    setAdjType(adj.type);
    setReason(adj.reason ?? '');
    setDialogOpen(true);
    try {
      const bs = await api.batches.getByProduct(adj.product_id);
      setBatches(bs);
      setBatchId(adj.batch_id);
    } catch { /* ignore */ }
  };

  const selectProduct = async (p: Product) => {
    setProductId(p.id);
    setProductSearch(p.name);
    setShowProductResults(false);
    setBatchId(null);
    try { setBatches(await api.batches.getByProduct(p.id)); } catch { setBatches([]); }
  };

  // G5: the picker used to hold the entire catalogue and filter it in JS.
  // getList() does the same name/generic/barcode match in SQL and paginates,
  // so it serves both the browse case (no query) and the typeahead from one
  // bounded call — this component no longer depends on the full catalogue.
  useEffect(() => {
    if (!dialogOpen) return;
    let cancelled = false;
    api.products.getList({
      search: debouncedProductSearch.trim() || undefined,
      limit: 50,
    })
      .then((res) => {
        // Guard against a slower earlier query landing after a later one.
        if (!cancelled) setProducts(Array.isArray(res?.data) ? res.data : []);
      })
      .catch(() => { if (!cancelled) setProducts([]); });
    return () => { cancelled = true; };
  }, [dialogOpen, debouncedProductSearch]);

  const productResults = products;

  const submitAdjustment = async () => {
    const qty = parseInt(quantity, 10);
    if (!batchId) { toast.error(t('Select a batch')); return; }
    if (isNaN(qty) || qty <= 0) { toast.error(t('Enter a valid quantity')); return; }
    setSubmitting(true);
    try {
      // "Update" of a posted adjustment = reverse the original, then post the corrected one
      // (an adjustment is a ledger entry; this keeps stock and the audit trail consistent).
      if (editingId !== null) {
        await api.inventory.reverseAdjustment(editingId);
      }
      await api.inventory.reportDamage(batchId, qty, reason.trim(), adjType);
      toast.success(editingId !== null ? t('Adjustment updated') : t('Adjustment created'));
      setDialogOpen(false);
      // New/edited adjustments sort newest-first — jump to page 1 so the
      // result is actually visible instead of landing on whatever page the
      // user happened to be viewing.
      if (page === 1) await fetchAdjustments(); else setPage(1);
    } catch (err: any) {
      toast.error(err.message || t('Failed to save adjustment'));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedBatch = batches.find(b => b.id === batchId);

  return (
    <div className="flex h-full flex-col p-4 bg-background gap-4">
      <Tabs defaultValue="adjustments" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="self-start shrink-0">
          <TabsTrigger value="adjustments">{t('Adjustments')}</TabsTrigger>
          <TabsTrigger value="history">{t('History')}</TabsTrigger>
        </TabsList>
        {/*
          data-[state=active]:flex, not a plain `flex` class: Radix hides an
          inactive TabsContent via the `hidden` attribute, which the browser
          defaults to `display:none`. An unconditional `flex` utility has the
          same specificity and wins the cascade, silently re-showing the
          "inactive" panel and making it keep competing for flex height in
          the parent Tabs — every sibling tab then gets squeezed to a
          fraction of its rightful height. Only force `flex` while active.
        */}
        <TabsContent value="adjustments" className="flex-1 min-h-0 overflow-hidden data-[state=active]:flex flex-col gap-4 mt-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{t('Inventory Adjustments')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('History of damages, expiries, and manual corrections.')}
          </p>
        </div>
        {canManage && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            {t('New Adjustment')}
          </Button>
        )}
      </div>

      {/* Filter bar — wraps on small screens */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="ps-8"
            placeholder={t('Search product, batch or reason...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as AdjustmentType | 'all')}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder={t('Type')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All types')}</SelectItem>
            {TYPES.map(ty => <SelectItem key={ty} value={ty}>{t(ty)}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">{t('From')}</Label>
          <Input type="date" className="w-[150px]" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">{t('To')}</Label>
          <Input type="date" className="w-[150px]" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <Button variant="outline" onClick={resetFilters} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          {t('Reset')}
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <Skeleton className="h-[400px] w-full" />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t('Date')}</TableHead>
                <TableHead>{t('Product')}</TableHead>
                <TableHead>{t('Batch')}</TableHead>
                <TableHead>{t('Type')}</TableHead>
                <TableHead className="text-end">{t('Quantity')}</TableHead>
                <TableHead>{t('Reason')}</TableHead>
                <TableHead>{t('User')}</TableHead>
                {canManage && <TableHead className="w-[100px]"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 8 : 7} className="h-24 text-center text-muted-foreground">
                    {(typeFilter !== 'all' || startDate || endDate || search.trim())
                      ? t('No adjustments match your filters')
                      : t('No adjustments found')}
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((adj) => {
                  const isReversal = adj.quantity_base < 0 || adj.reason?.startsWith('Reversal of');
                  return (
                    <TableRow key={adj.id}>
                      <TableCell className="whitespace-nowrap">{new Date(adj.created_at).toLocaleString()}</TableCell>
                      <TableCell className="font-medium">{adj.product_name}</TableCell>
                      <TableCell>{adj.batch_number || '-'}</TableCell>
                      <TableCell>
                        <Badge variant={adj.type === 'damage' ? 'destructive' : adj.type === 'expiry' ? 'warning' : 'secondary'}>
                          {t(adj.type)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end font-mono">
                        {adj.quantity_base > 0 ? `-${adj.quantity_base}` : `+${Math.abs(adj.quantity_base)}`}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate" title={adj.reason || ''}>{adj.reason || '-'}</TableCell>
                      <TableCell>{adj.username}</TableCell>
                      {canManage && (
                        <TableCell className="text-end">
                          {!isReversal && (
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title={t('Edit')}
                                disabled={reversing === adj.id} onClick={() => openEdit(adj)}>
                                <Pencil className="h-4 w-4" />
                                <span className="sr-only">{t('Edit')}</span>
                              </Button>
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title={t('Reverse')}
                                disabled={reversing === adj.id} onClick={() => handleReverse(adj.id)}>
                                <Undo2 className="h-4 w-4" />
                                <span className="sr-only">{t('Reverse')}</span>
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {!loading && totalPages > 1 && (
        <DataPagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      )}
        </TabsContent>

        {/* data-[state=active]:flex — see comment on the "adjustments" TabsContent above. */}
        <TabsContent value="history" className="flex-1 min-h-0 overflow-hidden data-[state=active]:flex flex-col mt-3">
          <BatchHistoryTab />
        </TabsContent>
      </Tabs>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!submitting) setDialogOpen(o); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId !== null ? t('Edit Adjustment') : t('New Adjustment')}</DialogTitle>
            <DialogDescription>
              {t('Record a stock reduction (damage, expiry, or correction) against a batch.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('Product')}</Label>
              {editingId !== null ? (
                <Input value={productSearch} disabled />
              ) : (
                <div className="relative">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="ps-8"
                    placeholder={t('Search product...')}
                    value={productSearch}
                    onChange={(e) => { setProductSearch(e.target.value); setProductId(null); setBatchId(null); setShowProductResults(true); }}
                    onFocus={() => setShowProductResults(true)}
                    onBlur={() => setTimeout(() => setShowProductResults(false), 150)}
                  />
                  {showProductResults && (
                    <div className="absolute z-50 mt-1 max-h-52 w-full overflow-auto rounded-md border bg-popover shadow-md">
                      {productResults.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('No products')}</div>
                      ) : productResults.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onMouseDown={() => selectProduct(p)}
                          className="flex w-full items-center px-3 py-2 text-sm hover:bg-accent text-start"
                        >
                          {p.name}
                          {p.generic_name && <span className="ms-2 text-xs text-muted-foreground truncate">{p.generic_name}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('Batch')}</Label>
              <Select value={batchId ? String(batchId) : ''} onValueChange={(v) => setBatchId(Number(v))} disabled={!productId}>
                <SelectTrigger><SelectValue placeholder={t('Select batch')} /></SelectTrigger>
                <SelectContent>
                  {batches.map(b => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {(b.batch_number || `#${b.id}`)} — {t('{{n}} in stock', { n: b.quantity_base })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('Quantity')}</Label>
                <Input type="number" min={1} value={quantity}
                  max={selectedBatch?.quantity_base}
                  onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label>{t('Type')}</Label>
                <Select value={adjType} onValueChange={(v) => setAdjType(v as AdjustmentType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPES.map(ty => <SelectItem key={ty} value={ty}>{t(ty)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('Reason')}</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('Optional note')} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>{t('Cancel')}</Button>
            <Button onClick={submitAdjustment} disabled={submitting || !batchId || !quantity}>
              {editingId !== null ? t('Save changes') : t('Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
