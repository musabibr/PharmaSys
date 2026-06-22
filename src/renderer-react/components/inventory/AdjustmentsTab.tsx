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
import { Undo2, Plus, Pencil, Search, RotateCcw } from 'lucide-react';
import { usePermission } from '@/hooks/usePermission';

const TYPES: AdjustmentType[] = ['damage', 'expiry', 'correction'];

export function AdjustmentsTab() {
  const { t } = useTranslation();
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [reversing, setReversing] = useState<number | null>(null);

  // ─── Filters ──────────────────────────────────────────────────────────────
  const [typeFilter, setTypeFilter] = useState<AdjustmentType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // ─── Create / Edit dialog ───────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('');
  const [adjType, setAdjType] = useState<AdjustmentType>('damage');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canManage = usePermission('inventory.batches.damage');

  const fetchAdjustments = useCallback(async () => {
    setLoading(true);
    try {
      const filters: Record<string, unknown> = {};
      if (typeFilter !== 'all') filters.type = typeFilter;
      if (startDate) filters.start_date = startDate;
      if (endDate) filters.end_date = endDate;
      const data = await api.inventory.getAdjustments(filters) as InventoryAdjustment[];
      setAdjustments(data);
    } catch {
      toast.error(t('Failed to load adjustments'));
    } finally {
      setLoading(false);
    }
  }, [typeFilter, startDate, endDate, t]);

  useEffect(() => { fetchAdjustments(); }, [fetchAdjustments]);

  // Client-side text search across product / batch / reason
  const q = search.trim().toLowerCase();
  const visible = q
    ? adjustments.filter(a =>
        a.product_name?.toLowerCase().includes(q) ||
        a.batch_number?.toLowerCase().includes(q) ||
        a.reason?.toLowerCase().includes(q))
    : adjustments;

  const resetFilters = () => {
    setTypeFilter('all');
    setSearch('');
    setStartDate('');
    setEndDate('');
  };

  const handleReverse = async (id: number) => {
    if (!window.confirm(t('Are you sure you want to reverse this adjustment? This will restore the inventory quantity.'))) return;
    setReversing(id);
    try {
      await api.inventory.reverseAdjustment(id);
      toast.success(t('Adjustment reversed successfully'));
      await fetchAdjustments();
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
    setDialogOpen(true);
    if (products.length === 0) {
      try { setProducts(await api.products.getAll()); } catch { /* ignore */ }
    }
  };

  const openEdit = async (adj: InventoryAdjustment) => {
    setEditingId(adj.id);
    setProductId(adj.product_id);
    setQuantity(String(adj.quantity_base));
    setAdjType(adj.type);
    setReason(adj.reason ?? '');
    setDialogOpen(true);
    try {
      if (products.length === 0) setProducts(await api.products.getAll());
      const bs = await api.batches.getByProduct(adj.product_id);
      setBatches(bs);
      setBatchId(adj.batch_id);
    } catch { /* ignore */ }
  };

  const onProductChange = async (idStr: string) => {
    const id = Number(idStr);
    setProductId(id);
    setBatchId(null);
    try { setBatches(await api.batches.getByProduct(id)); } catch { setBatches([]); }
  };

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
      await fetchAdjustments();
    } catch (err: any) {
      toast.error(err.message || t('Failed to save adjustment'));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedBatch = batches.find(b => b.id === batchId);

  return (
    <div className="flex h-full flex-col p-4 bg-background gap-4">
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
        <div className="flex-1 overflow-auto rounded-md border">
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
                    {adjustments.length ? t('No adjustments match your filters') : t('No adjustments found')}
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
              <Select value={productId ? String(productId) : ''} onValueChange={onProductChange} disabled={editingId !== null}>
                <SelectTrigger><SelectValue placeholder={t('Select product')} /></SelectTrigger>
                <SelectContent>
                  {products.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
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
