import { useState, useEffect } from 'react';
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
          <div className="relative ms-auto w-full sm:w-64 order-last sm:order-none">
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
                  <TableHead className="text-right">{t('System Qty')}</TableHead>
                  <TableHead className="text-right w-48">{t('Counted Qty')}</TableHead>
                  <TableHead className="text-right">{t('Variance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.map(item => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.product_name}</TableCell>
                    <TableCell>{item.batch_number || '---'}</TableCell>
                    <TableCell className="text-right">{item.expected_quantity}</TableCell>
                    <TableCell className="text-right">
                      {selectedCount.status === 'in_progress' ? (
                        <Input 
                          type="number" 
                          min={0}
                          className="w-24 ml-auto text-right"
                          defaultValue={item.counted_quantity ?? ''}
                          onBlur={(e) => handleRecord(item.id, e.target.value)}
                        />
                      ) : (
                        item.counted_quantity ?? '---'
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {item.variance !== null ? (
                        <span className={item.variance < 0 ? 'text-red-500' : item.variance > 0 ? 'text-green-500' : ''}>
                          {item.variance > 0 ? '+' : ''}{item.variance}
                        </span>
                      ) : '---'}
                    </TableCell>
                  </TableRow>
                ))}
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
