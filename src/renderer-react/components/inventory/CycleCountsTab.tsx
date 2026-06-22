import { useState, useEffect, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Plus, Play, Check, ArrowLeft, Search } from 'lucide-react';
import { api } from '@/api';
import type { CycleCount, CycleCountItem } from '@/api/types';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

export function CycleCountsTab() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<CycleCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCountId, setSelectedCountId] = useState<number | null>(null);
  const [selectedCount, setSelectedCount] = useState<CycleCount | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const [viewMode, setViewMode] = useState<'batch' | 'product'>('batch');

  const fetchCounts = async () => {
    try {
      setLoading(true);
      const res = await api.cycleCounts.getAll();
      setCounts(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedCountId) {
      fetchCounts();
    }
  }, [selectedCountId]);

  useEffect(() => {
    if (selectedCountId) {
      loadCountDetails(selectedCountId);
    }
  }, [selectedCountId]);

  const loadCountDetails = async (id: number) => {
    try {
      const res = await api.cycleCounts.getById(id);
      setSelectedCount(res);
    } catch (err) {
      console.error(err);
    }
  };

  // NOTE: window.prompt() is not supported in Electron (always returns null), so the
  // old prompt-based create silently did nothing. Use a proper dialog instead.
  const handleCreate = () => {
    setNewName('');
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.create({ name }));
      setCreateOpen(false);
      setNewName('');
      fetchCounts();
    } catch (err: any) {
      alert('Error creating cycle count: ' + (err.message || err));
    } finally {
      setCreating(false);
    }
  };

  const handleStart = async (id: number) => {
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.start(id));
      fetchCounts();
    } catch (err: any) {
      alert('Error starting cycle count: ' + (err.message || err));
    }
  };

  const handleComplete = async (id: number) => {
    if (!confirm(t('Complete cycle count and apply adjustments?'))) return;
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.complete(id, true));
      setSelectedCountId(null);
    } catch (err: any) {
      alert('Error completing cycle count: ' + (err.message || err));
    }
  };

  const handleRecord = async (itemId: number, value: string) => {
    const qty = parseInt(value, 10);
    if (isNaN(qty) || qty < 0) return;
    try {
      const { throwIfError } = await import('@/api');
      throwIfError(await api.cycleCounts.recordCount(itemId, qty));
      loadCountDetails(selectedCountId!);
    } catch (err: any) {
      alert('Error recording cycle count: ' + (err.message || err));
    }
  };

  if (selectedCountId && selectedCount) {
    const q = itemSearch.trim().toLowerCase();
    const allItems = selectedCount.items ?? [];
    const visibleItems = q
      ? allItems.filter(it =>
          (it.product_name?.toLowerCase().includes(q)) ||
          (it.batch_number?.toLowerCase().includes(q)))
      : allItems;

    // Group display only — counting stays per batch (preserves stock integrity).
    const groups: Array<{
      productId: number; productName: string; items: typeof visibleItems;
      sumExpected: number; sumCounted: number; sumVariance: number; anyCounted: boolean;
    }> = [];
    if (viewMode === 'product') {
      const byProduct = new Map<number, (typeof groups)[number]>();
      for (const it of visibleItems) {
        let g = byProduct.get(it.product_id);
        if (!g) {
          g = { productId: it.product_id, productName: it.product_name ?? '—', items: [],
                sumExpected: 0, sumCounted: 0, sumVariance: 0, anyCounted: false };
          byProduct.set(it.product_id, g);
          groups.push(g);
        }
        g.items.push(it);
        g.sumExpected += it.expected_quantity ?? 0;
        if (it.counted_quantity != null) { g.sumCounted += it.counted_quantity; g.anyCounted = true; }
        if (it.variance != null) g.sumVariance += it.variance;
      }
    }

    const varianceSpan = (v: number) => (
      <span className={v < 0 ? 'text-red-500' : v > 0 ? 'text-green-500' : ''}>
        {v > 0 ? '+' : ''}{v}
      </span>
    );

    const renderItemRow = (item: CycleCountItem, showProduct: boolean) => (
      <TableRow key={item.id}>
        <TableCell className={showProduct ? 'font-medium' : 'ps-8 text-muted-foreground'}>
          {showProduct ? item.product_name : ''}
        </TableCell>
        <TableCell>{item.batch_number || '---'}</TableCell>
        <TableCell className="text-end">{item.expected_quantity}</TableCell>
        <TableCell className="text-end">
          {selectedCount.status === 'in_progress' ? (
            <Input
              type="number"
              min={0}
              className="w-24 ms-auto text-end"
              defaultValue={item.counted_quantity ?? ''}
              onBlur={(e) => handleRecord(item.id, e.target.value)}
            />
          ) : (
            item.counted_quantity ?? '---'
          )}
        </TableCell>
        <TableCell className="text-end font-medium">
          {item.variance !== null ? varianceSpan(item.variance) : '---'}
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
            <p className="text-sm text-muted-foreground">{t(selectedCount.status)}</p>
          </div>
          <Select value={viewMode} onValueChange={(v) => setViewMode(v as 'batch' | 'product')}>
            <SelectTrigger className="w-40 ms-auto sm:ms-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="batch">{t('Per batch')}</SelectItem>
              <SelectItem value="product">{t('By product')}</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-64 order-last sm:order-none">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="ps-8"
              placeholder={t('Search product or batch...')}
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
            />
          </div>
          {selectedCount.status === 'in_progress' && (
            <Button onClick={() => handleComplete(selectedCount.id)}>
              <Check className="h-4 w-4 me-2" />
              {t('Complete & Adjust')}
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
                  <TableHead className="text-end">{t('System Qty')}</TableHead>
                  <TableHead className="text-end w-48">{t('Counted Qty')}</TableHead>
                  <TableHead className="text-end">{t('Variance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewMode === 'product'
                  ? groups.map(g => (
                      <Fragment key={g.productId}>
                        <TableRow className="bg-muted/50">
                          <TableCell className="font-semibold">{g.productName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {g.items.length} {t('batches')}
                          </TableCell>
                          <TableCell className="text-end font-medium">{g.sumExpected}</TableCell>
                          <TableCell className="text-end font-medium">{g.anyCounted ? g.sumCounted : '—'}</TableCell>
                          <TableCell className="text-end font-bold">{g.anyCounted ? varianceSpan(g.sumVariance) : '—'}</TableCell>
                        </TableRow>
                        {g.items.map(it => renderItemRow(it, false))}
                      </Fragment>
                    ))
                  : visibleItems.map(it => renderItemRow(it, true))}
                {!visibleItems.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      {allItems.length ? t('No products match your search') : t('No items to count')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('Cycle Counts')}</h2>
        <Button onClick={handleCreate} className="gap-2">
          <Plus className="h-4 w-4" />
          {t('New Cycle Count')}
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
                <TableHead className="text-right">{t('Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.map(cc => (
                <TableRow key={cc.id}>
                  <TableCell className="font-medium">
                    <button className="hover:underline text-left" onClick={() => setSelectedCountId(cc.id)}>
                      {cc.name}
                    </button>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                      cc.status === 'completed' ? 'bg-green-100 text-green-700' :
                      cc.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {t(cc.status)}
                    </span>
                  </TableCell>
                  <TableCell>{cc.created_by_username}</TableCell>
                  <TableCell>{new Date(cc.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-right space-x-2">
                    {cc.status === 'pending' && (
                      <Button size="sm" variant="outline" onClick={() => handleStart(cc.id)}>
                        <Play className="h-4 w-4 mr-1" /> {t('Start')}
                      </Button>
                    )}
                    {(cc.status === 'in_progress' || cc.status === 'completed') && (
                      <Button size="sm" variant="secondary" onClick={() => setSelectedCountId(cc.id)}>
                        {t('View')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {counts.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {t('No cycle counts found')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create dialog — replaces window.prompt(), which Electron does not support */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!creating) setCreateOpen(o); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('New Cycle Count')}</DialogTitle>
            <DialogDescription>
              {t('Give this stock count a name (e.g. a date or aisle).')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cycle-count-name">{t('Name')}</Label>
            <Input
              id="cycle-count-name"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }}
              placeholder={t('e.g. 2026-06-22 full count')}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t('Cancel')}
            </Button>
            <Button onClick={submitCreate} disabled={creating || !newName.trim()}>
              {t('Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
