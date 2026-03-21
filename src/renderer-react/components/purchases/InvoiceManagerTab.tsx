import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import {
  Search, ChevronLeft, ChevronRight, GitMerge,
  Pencil, CheckCircle2, Download, Trash2, Loader2,
  Package, RefreshCw, Bookmark,
} from 'lucide-react';
import { api, throwIfError } from '@/api';
import type { Purchase, EnrichedPendingItem, CreatePurchaseItemInput } from '@/api/types';
import { formatCurrency, formatDate, displayInvoiceId, cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/useDebounce';
import { useApiCall } from '@/api/hooks';
import { usePermission } from '@/hooks/usePermission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { MergeInvoiceDialog } from './MergeInvoiceDialog';
import {
  PendingItemEditDialog, parseDraft, draftToRaw, type PendingItemDraft,
} from './PendingItemEditDialog';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function draftToCreateInput(d: PendingItemDraft): CreatePurchaseItemInput {
  return {
    new_product: {
      name:              d.name,
      generic_name:      d.genericName   || undefined,
      category_name:     d.categoryName  || undefined,
      barcode:           d.barcode       || undefined,
      parent_unit:       d.parentUnit    || undefined,
      child_unit:        d.childUnit     || undefined,
      conversion_factor: d.convFactor > 1 ? d.convFactor : undefined,
    },
    quantity:             d.quantity,
    cost_per_parent:      d.costPerParent,
    selling_price_parent: d.sellPrice,
    selling_price_child:  d.childUnit && d.sellPriceChild > 0 ? d.sellPriceChild : undefined,
    expiry_date:          d.expiryDate,
    batch_number:         d.batchNumber || undefined,
  };
}

function exportXlsx(items: EnrichedPendingItem[], filename: string) {
  const headers = [
    'Name', 'Generic Name', 'Qty', 'Cost/Unit', 'Sell Price', 'Sell Price (Small)',
    'Expiry', 'Batch #', 'Base Unit', 'Small Unit', 'Conv Factor',
    'Category', 'Barcode', 'Notes', 'Invoice #', 'Supplier',
  ];
  const rows = items.map(pi => {
    const d = parseDraft(pi.raw_data, pi.notes);
    return [
      d.name, d.genericName, d.quantity, d.costPerParent, d.sellPrice, d.sellPriceChild,
      d.expiryDate, d.batchNumber, d.parentUnit, d.childUnit, d.convFactor,
      d.categoryName, d.barcode, d.notes, pi.purchase_number, pi.supplier_name ?? '',
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 12) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Parked Items');
  XLSX.writeFile(wb, filename);
}

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default', partial: 'secondary', unpaid: 'destructive',
};

const INV_PAGE_SIZE  = 10;
const PARK_PAGE_SIZE = 10;

// ─── Props ────────────────────────────────────────────────────────────────────

interface InvoiceManagerTabProps {
  onRefreshList?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InvoiceManagerTab({ onRefreshList }: InvoiceManagerTabProps) {
  const { t } = useTranslation();
  const canManage = usePermission('purchases.manage');
  const { data: suppliers } = useApiCall(() => api.suppliers.getAll(), []);

  // ── Invoices tab ─────────────────────────────────────────────────────────────
  const [purchases, setPurchases]         = useState<Purchase[]>([]);
  const [invPage, setInvPage]             = useState(1);
  const [invTotalPages, setInvTotalPages] = useState(1);
  const [invLoading, setInvLoading]       = useState(true);
  const [invRefreshKey, setInvRefreshKey] = useState(0);
  const [invSearch, setInvSearch]         = useState('');
  const [invStatus, setInvStatus]         = useState('all');
  const [invSupplier, setInvSupplier]     = useState('all');
  const debouncedInvSearch = useDebounce(invSearch, 300);

  // Merge dialog
  const [mergeTarget, setMergeTarget] = useState<Purchase | null>(null);
  const [mergeOpen, setMergeOpen]     = useState(false);

  // ── Parked Items tab ──────────────────────────────────────────────────────────
  const [parkedItems, setParkedItems]       = useState<EnrichedPendingItem[]>([]);
  const [parkPage, setParkPage]             = useState(1);
  const [parkTotalPages, setParkTotalPages] = useState(1);
  const [parkLoading, setParkLoading]       = useState(true);
  const [parkRefreshKey, setParkRefreshKey] = useState(0);
  const [parkSearch, setParkSearch]         = useState('');
  const [parkSupplier, setParkSupplier]     = useState('all');
  const debouncedParkSearch = useDebounce(parkSearch, 300);

  // Edit dialog
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingPi, setEditingPi]           = useState<EnrichedPendingItem | null>(null);
  const [editingDraft, setEditingDraft]     = useState<PendingItemDraft | null>(null);
  const [savingId, setSavingId]             = useState<number | null>(null);
  const [completingId, setCompletingId]     = useState<number | null>(null);
  const [deletingId, setDeletingId]         = useState<number | null>(null);

  // Bulk selection & processing
  const [selectedIds, setSelectedIds]       = useState<Set<number>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkProgress, setBulkProgress]     = useState({ done: 0, total: 0, errors: 0 });

  // ── Fetch invoices ────────────────────────────────────────────────────────────
  const fetchInvoices = useCallback(async () => {
    setInvLoading(true);
    try {
      const filters: Record<string, unknown> = {
        page: invPage, limit: INV_PAGE_SIZE,
        start_date: '2000-01-01',
        end_date: new Date().toISOString().slice(0, 10),
      };
      if (debouncedInvSearch)     filters.search = debouncedInvSearch;
      if (invStatus === 'parked') filters.has_pending = true;
      else if (invStatus !== 'all') filters.payment_status = invStatus;
      if (invSupplier !== 'all')  filters.supplier_id = parseInt(invSupplier, 10);
      const result = await api.purchases.getAll(filters);
      setPurchases(Array.isArray(result.data) ? result.data : []);
      setInvTotalPages(result.totalPages ?? 1);
    } catch { setPurchases([]); }
    finally  { setInvLoading(false); }
  }, [invPage, debouncedInvSearch, invStatus, invSupplier, invRefreshKey]); // eslint-disable-line

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);
  useEffect(() => { setInvPage(1); }, [debouncedInvSearch, invStatus, invSupplier]);

  // ── Fetch parked items ────────────────────────────────────────────────────────
  const fetchParked = useCallback(async () => {
    setParkLoading(true);
    try {
      const filters: Record<string, unknown> = { page: parkPage, limit: PARK_PAGE_SIZE };
      if (debouncedParkSearch) filters.search = debouncedParkSearch;
      if (parkSupplier !== 'all') filters.supplier_id = parseInt(parkSupplier, 10);
      const result = await api.purchases.getAllPendingItems(
        filters as { search?: string; supplier_id?: number; page?: number; limit?: number }
      );
      setParkedItems(Array.isArray(result.data) ? result.data : []);
      setParkTotalPages(result.totalPages ?? 1);
      setSelectedIds(new Set());
    } catch { setParkedItems([]); }
    finally  { setParkLoading(false); }
  }, [parkPage, debouncedParkSearch, parkSupplier, parkRefreshKey]); // eslint-disable-line

  useEffect(() => { fetchParked(); }, [fetchParked]);
  useEffect(() => { setParkPage(1); }, [debouncedParkSearch, parkSupplier]);

  // ── Edit dialog helpers ───────────────────────────────────────────────────────
  const openEditDialog = (pi: EnrichedPendingItem) => {
    setEditingPi(pi);
    setEditingDraft(parseDraft(pi.raw_data, pi.notes));
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async (draft: PendingItemDraft) => {
    if (!editingPi) return;
    setSavingId(editingPi.id);
    try {
      throwIfError(await api.purchases.updatePendingItem(editingPi.id, draftToRaw(draft), draft.notes || null));
      setEditDialogOpen(false);
      toast.success(t('Parked item updated'));
      setParkRefreshKey(k => k + 1);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to update item'));
    } finally {
      setSavingId(null);
    }
  };

  const completeItem = async (pi: EnrichedPendingItem) => {
    const draft = parseDraft(pi.raw_data, pi.notes);
    if (!draft.name.trim())  { toast.error(t('Item name is required')); return; }
    if (!draft.expiryDate)   { toast.error(t('Expiry date is required to add item to inventory')); return; }
    setCompletingId(pi.id);
    try {
      throwIfError(await api.purchases.completePendingItem(pi.id, draftToCreateInput(draft)));
      toast.success(t('Item added to inventory'));
      setParkRefreshKey(k => k + 1);
      setInvRefreshKey(k => k + 1);
      onRefreshList?.();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to complete item'));
    } finally {
      setCompletingId(null);
    }
  };

  const deleteItem = async (pi: EnrichedPendingItem) => {
    if (!window.confirm(t('Remove this parked item permanently?'))) return;
    setDeletingId(pi.id);
    try {
      throwIfError(await api.purchases.deletePendingItem(pi.id));
      toast.success(t('Parked item removed'));
      setParkRefreshKey(k => k + 1);
      setInvRefreshKey(k => k + 1);
    } catch {
      toast.error(t('Failed to remove parked item'));
    } finally {
      setDeletingId(null);
    }
  };

  // ── Bulk operations ──────────────────────────────────────────────────────────
  const doBulkComplete = async (items: EnrichedPendingItem[]) => {
    const valid: EnrichedPendingItem[] = [];
    const skipped: string[] = [];
    for (const pi of items) {
      const draft = parseDraft(pi.raw_data, pi.notes);
      if (!draft.name.trim() || !draft.expiryDate) {
        skipped.push(draft.name || `Item #${pi.id}`);
      } else {
        valid.push(pi);
      }
    }

    if (skipped.length > 0) {
      toast.warning(t('Skipping {{count}} items with missing name or expiry: {{names}}', {
        count: skipped.length,
        names: skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? '...' : ''),
      }));
    }
    if (valid.length === 0) return;

    setBulkProcessing(true);
    setBulkProgress({ done: 0, total: valid.length, errors: 0 });
    let errors = 0;

    for (let i = 0; i < valid.length; i++) {
      const pi = valid[i];
      const draft = parseDraft(pi.raw_data, pi.notes);
      try {
        await api.purchases.completePendingItem(pi.id, draftToCreateInput(draft));
      } catch { errors++; }
      setBulkProgress({ done: i + 1, total: valid.length, errors });
    }

    setBulkProcessing(false);
    setSelectedIds(new Set());
    setParkRefreshKey(k => k + 1);
    setInvRefreshKey(k => k + 1);
    onRefreshList?.();

    if (errors === 0) {
      toast.success(t('All {{count}} items completed successfully', { count: valid.length }));
    } else {
      toast.warning(t('Completed {{success}} of {{total}} items ({{errors}} failed)', {
        success: valid.length - errors, total: valid.length, errors,
      }));
    }
  };

  const handleBulkComplete = () => {
    const items = parkedItems.filter(pi => selectedIds.has(pi.id));
    doBulkComplete(items);
  };

  const handleCompleteAll = () => {
    if (!window.confirm(t('Complete all {{count}} parked items?', { count: parkedItems.length }))) return;
    doBulkComplete(parkedItems);
  };

  const handleBulkDelete = async () => {
    const count = selectedIds.size;
    if (!window.confirm(t('Delete {{count}} parked items permanently?', { count }))) return;

    setBulkProcessing(true);
    setBulkProgress({ done: 0, total: count, errors: 0 });
    let errors = 0;
    const ids = Array.from(selectedIds);

    for (let i = 0; i < ids.length; i++) {
      try {
        await api.purchases.deletePendingItem(ids[i]);
      } catch { errors++; }
      setBulkProgress({ done: i + 1, total: count, errors });
    }

    setBulkProcessing(false);
    setSelectedIds(new Set());
    setParkRefreshKey(k => k + 1);
    setInvRefreshKey(k => k + 1);

    if (errors === 0) {
      toast.success(t('All {{count}} items deleted', { count }));
    } else {
      toast.warning(t('Deleted {{success}} of {{total}} items ({{errors}} failed)', {
        success: count - errors, total: count, errors,
      }));
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-3 p-4">
      <Tabs defaultValue="invoices" className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <TabsList className="w-full shrink-0">
          <TabsTrigger value="invoices" className="flex-1">{t('All Invoices')}</TabsTrigger>
          <TabsTrigger value="parked"   className="flex-1">{t('Parked Items')}</TabsTrigger>
        </TabsList>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 1 — All Invoices
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="invoices" className="data-[state=active]:flex flex-col flex-1 gap-3 min-h-0 mt-0 overflow-hidden">

          {/* Filter bar */}
          <Card className="shrink-0">
            <CardContent className="flex flex-wrap items-end gap-3 p-3">
              <div className="relative flex-1 min-w-[160px]">
                <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('Search invoice, supplier...')}
                  value={invSearch}
                  onChange={e => setInvSearch(e.target.value)}
                  className="h-9 ps-9"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('Supplier')}</span>
                <Select value={invSupplier} onValueChange={setInvSupplier}>
                  <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('All Suppliers')}</SelectItem>
                    {suppliers?.map(s => (
                      <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('Status')}</span>
                <Select value={invStatus} onValueChange={setInvStatus}>
                  <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('All')}</SelectItem>
                    <SelectItem value="unpaid">{t('Unpaid')}</SelectItem>
                    <SelectItem value="partial">{t('Partial')}</SelectItem>
                    <SelectItem value="paid">{t('Paid')}</SelectItem>
                    <SelectItem value="parked">{t('Has Parked Items')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => {
                  setInvSearch(''); setInvStatus('all'); setInvSupplier('all');
                }}>{t('Reset')}</Button>
                <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setInvRefreshKey(k => k + 1)}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Invoice table — fills remaining height */}
          <div className="flex-1 min-h-0 overflow-auto rounded-md border">
            {invLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 10 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded" />
                ))}
              </div>
            ) : purchases.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground">
                <Package className="mb-3 h-12 w-12 opacity-30" />
                <p className="text-base font-medium">{t('No invoices found')}</p>
                <p className="text-sm mt-1 opacity-70">{t('Try adjusting your filters')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>{t('Invoice')}</TableHead>
                    <TableHead>{t('Date')}</TableHead>
                    <TableHead>{t('Supplier')}</TableHead>
                    <TableHead className="text-end">{t('Total')}</TableHead>
                    <TableHead className="text-end">{t('Paid')}</TableHead>
                    <TableHead className="text-end">{t('Due')}</TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Parked')}</TableHead>
                    <TableHead className="w-10">{t('Merge')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchases.map((p, idx) => {
                    const pendingCount = p.pending_items_count ?? 0;
                    const remaining    = p.total_amount - p.total_paid;
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {(invPage - 1) * INV_PAGE_SIZE + idx + 1}
                        </TableCell>
                        <TableCell>
                          <span className="font-semibold text-sm">{displayInvoiceId(p)}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(p.purchase_date)}
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {p.supplier_name ?? (
                            <span className="text-muted-foreground italic">{t('No supplier')}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-sm">
                          {formatCurrency(p.total_amount)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-sm text-emerald-600 dark:text-emerald-400">
                          {p.total_paid > 0 ? formatCurrency(p.total_paid) : '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-sm text-destructive">
                          {remaining > 0 ? formatCurrency(remaining) : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={STATUS_BADGE[p.payment_status] ?? 'secondary'}
                            className="text-[10px]"
                          >
                            {t(p.payment_status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {pendingCount > 0 ? (
                            <Badge
                              variant="outline"
                              className="gap-1 text-[10px] text-amber-600 border-amber-400 bg-amber-50 dark:bg-amber-950/30"
                            >
                              <Bookmark className="h-2.5 w-2.5 fill-current" />
                              {pendingCount}
                            </Badge>
                          ) : '—'}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7"
                            title={t('Merge with another invoice')}
                            onClick={() => { setMergeTarget(p); setMergeOpen(true); }}
                          >
                            <GitMerge className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Pagination */}
          {invTotalPages > 1 && (
            <div className="flex items-center justify-between px-1 shrink-0">
              <span className="text-sm text-muted-foreground">
                {t('Page {{page}} of {{total}}', { page: invPage, total: invTotalPages })}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={invPage <= 1} onClick={() => setInvPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4 me-1" />{t('Previous')}
                </Button>
                <Button variant="outline" size="sm" disabled={invPage >= invTotalPages} onClick={() => setInvPage(p => p + 1)}>
                  {t('Next')}<ChevronRight className="h-4 w-4 ms-1" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ══════════════════════════════════════════════════════════════════
            TAB 2 — Parked Items
        ══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="parked" className="data-[state=active]:flex flex-col flex-1 gap-3 min-h-0 mt-0 overflow-hidden">

          {/* Filter bar */}
          <Card className="shrink-0">
            <CardContent className="flex flex-wrap items-end gap-3 p-3">
              <div className="relative flex-1 min-w-[160px]">
                <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('Search item, invoice, supplier...')}
                  value={parkSearch}
                  onChange={e => setParkSearch(e.target.value)}
                  className="h-9 ps-9"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('Supplier')}</span>
                <Select value={parkSupplier} onValueChange={setParkSupplier}>
                  <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('All Suppliers')}</SelectItem>
                    {suppliers?.map(s => (
                      <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => {
                  setParkSearch(''); setParkSupplier('all');
                }}>{t('Reset')}</Button>
                {canManage && (
                  <Button
                    variant="default" size="sm" className="gap-1.5"
                    onClick={handleCompleteAll}
                    disabled={parkedItems.length === 0 || bulkProcessing}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {t('Complete All')}
                  </Button>
                )}
                <Button
                  variant="ghost" size="sm" className="gap-1.5"
                  onClick={() => exportXlsx(parkedItems, `Parked-items-${new Date().toISOString().slice(0,10)}.xlsx`)}
                  disabled={parkedItems.length === 0}
                >
                  <Download className="h-4 w-4" />
                  {t('Export All')}
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setParkRefreshKey(k => k + 1)}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Bulk action bar / progress */}
          {bulkProcessing && (
            <div className="flex items-center gap-3 rounded-lg border bg-primary/5 px-4 py-3 shrink-0">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {t('Processing {{done}} of {{total}}...', { done: bulkProgress.done, total: bulkProgress.total })}
                </p>
                <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${bulkProgress.total > 0 ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
              {bulkProgress.errors > 0 && (
                <span className="text-sm text-destructive shrink-0">{bulkProgress.errors} {t('failed')}</span>
              )}
            </div>
          )}

          {!bulkProcessing && selectedIds.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2 shrink-0">
              <span className="text-sm font-medium">
                {t('{{count}} item(s) selected', { count: selectedIds.size })}
              </span>
              {canManage && (
                <Button size="sm" className="gap-1.5" onClick={handleBulkComplete}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t('Complete Selected')}
                </Button>
              )}
              {canManage && (
                <Button size="sm" variant="destructive" className="gap-1.5" onClick={handleBulkDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('Delete Selected')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                {t('Clear Selection')}
              </Button>
            </div>
          )}

          {/* Parked items table — fills remaining height */}
          <div className="flex-1 min-h-0 overflow-auto rounded-md border">
            {parkLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded" />
                ))}
              </div>
            ) : parkedItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground">
                <Bookmark className="mb-3 h-12 w-12 opacity-30" />
                <p className="text-base font-medium">{t('No parked items found')}</p>
                <p className="text-sm mt-1 opacity-70">{t('Try adjusting your filters')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 accent-primary cursor-pointer"
                        checked={parkedItems.length > 0 && selectedIds.size === parkedItems.length}
                        ref={(el) => {
                          if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < parkedItems.length;
                        }}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedIds(new Set(parkedItems.map(pi => pi.id)));
                          else setSelectedIds(new Set());
                        }}
                        disabled={bulkProcessing}
                      />
                    </TableHead>
                    <TableHead>{t('Item Name')}</TableHead>
                    <TableHead>{t('Invoice')}</TableHead>
                    <TableHead>{t('Supplier')}</TableHead>
                    <TableHead className="text-end">{t('Qty')}</TableHead>
                    <TableHead className="text-end">{t('Cost/Unit')}</TableHead>
                    <TableHead className="text-end">{t('Line Total')}</TableHead>
                    <TableHead>{t('Expiry')}</TableHead>
                    <TableHead>{t('Notes')}</TableHead>
                    <TableHead className="w-28 text-center">{t('Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parkedItems.map(pi => {
                    const d             = parseDraft(pi.raw_data, pi.notes);
                    const isCompleting  = completingId === pi.id;
                    const isDeleting    = deletingId   === pi.id;
                    const isSaving      = savingId     === pi.id;
                    const isBusy        = isCompleting || isDeleting || isSaving;

                    return (
                      <TableRow key={pi.id} className={cn(isBusy && 'opacity-60')}>
                        <TableCell>
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300 accent-primary cursor-pointer"
                            checked={selectedIds.has(pi.id)}
                            onChange={(e) => {
                              setSelectedIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(pi.id); else next.delete(pi.id);
                                return next;
                              });
                            }}
                            disabled={isBusy || bulkProcessing}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium">
                              {d.name || <span className="text-muted-foreground italic">{t('Unnamed')}</span>}
                            </span>
                            {d.genericName && (
                              <span className="text-xs text-muted-foreground">{d.genericName}</span>
                            )}
                            {d.categoryName && (
                              <Badge variant="outline" className="text-[10px] w-fit">{d.categoryName}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] font-mono">
                            {pi.purchase_number}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {pi.supplier_name ?? (
                            <span className="text-muted-foreground italic text-xs">{t('None')}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-sm">
                          {d.quantity}
                          <span className="text-xs text-muted-foreground ms-1">{d.parentUnit}</span>
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-sm">
                          {d.costPerParent > 0 ? formatCurrency(d.costPerParent) : '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-sm font-medium">
                          {d.costPerParent > 0 ? formatCurrency(d.quantity * d.costPerParent) : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {d.expiryDate || '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                          {d.notes || '—'}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-1">
                            {canManage && (
                              <Button
                                variant="ghost" size="icon" className="h-7 w-7"
                                title={t('Edit item')} disabled={isBusy}
                                onClick={() => openEditDialog(pi)}
                              >
                                {isSaving
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Pencil className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                            {canManage && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                                title={t('Complete — add to inventory')} disabled={isBusy}
                                onClick={() => completeItem(pi)}
                              >
                                {isCompleting
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <CheckCircle2 className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                            <Button
                              variant="ghost" size="icon" className="h-7 w-7"
                              title={t('Export to Excel')} disabled={isBusy}
                              onClick={() => exportXlsx([pi], `Parked-item-${pi.id}.xlsx`)}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </Button>
                            {canManage && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-destructive/70 hover:text-destructive"
                                title={t('Delete')} disabled={isBusy}
                                onClick={() => deleteItem(pi)}
                              >
                                {isDeleting
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Trash2 className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Pagination */}
          {parkTotalPages > 1 && (
            <div className="flex items-center justify-between px-1 shrink-0">
              <span className="text-sm text-muted-foreground">
                {t('Page {{page}} of {{total}}', { page: parkPage, total: parkTotalPages })}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={parkPage <= 1} onClick={() => setParkPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4 me-1" />{t('Previous')}
                </Button>
                <Button variant="outline" size="sm" disabled={parkPage >= parkTotalPages} onClick={() => setParkPage(p => p + 1)}>
                  {t('Next')}<ChevronRight className="h-4 w-4 ms-1" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Edit dialog ──────────────────────────────────────────────────────────── */}
      <PendingItemEditDialog
        item={editingDraft}
        open={editDialogOpen}
        onOpenChange={open => {
          setEditDialogOpen(open);
          if (!open) { setEditingPi(null); setEditingDraft(null); }
        }}
        onSave={handleSaveEdit}
      />

      {/* ── Merge dialog ──────────────────────────────────────────────────────────── */}
      <MergeInvoiceDialog
        purchase={mergeTarget}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        onMerged={() => {
          setInvRefreshKey(k => k + 1);
          onRefreshList?.();
        }}
      />
    </div>
  );
}
