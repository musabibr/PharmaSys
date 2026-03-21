import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { GitMerge, AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '@/api';
import type { Purchase } from '@/api/types';
import { formatCurrency, formatDate, displayInvoiceId } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MergeInvoiceDialogProps {
  purchase: Purchase | null;  // the invoice to merge INTO (target)
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default', partial: 'secondary', unpaid: 'destructive',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function MergeInvoiceDialog({ purchase, open, onOpenChange, onMerged }: MergeInvoiceDialogProps) {
  const { t } = useTranslation();

  const [eligible, setEligible]       = useState<Purchase[]>([]);
  const [loading, setLoading]         = useState(false);
  const [merging, setMerging]         = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Reset state and load eligible invoices when dialog opens
  useEffect(() => {
    if (!open || !purchase) {
      setEligible([]);
      setSelectedIds(new Set());
      return;
    }

    // If purchase has no supplier, we cannot merge
    if (purchase.supplier_id == null) {
      setEligible([]);
      setSelectedIds(new Set());
      return;
    }

    setLoading(true);
    api.purchases.getAll({
      supplier_id: purchase.supplier_id,
      limit: 100,
    } as Record<string, unknown>).then(result => {
      // Filter out: the target itself, and any paid invoices
      const candidates = (result.data ?? []).filter(
        p => p.id !== purchase.id && p.payment_status !== 'paid'
      );
      setEligible(candidates);
    }).catch(() => {
      setEligible([]);
    }).finally(() => {
      setLoading(false);
    });
  }, [open, purchase]);

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleMerge = async () => {
    if (!purchase || selectedIds.size === 0) return;
    setMerging(true);
    try {
      await api.purchases.merge(purchase.id, [...selectedIds]);
      toast.success(t('Invoices merged successfully'));
      onOpenChange(false);
      onMerged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to merge invoices'));
    } finally {
      setMerging(false);
    }
  };

  if (!purchase) return null;

  const noSupplier = purchase.supplier_id == null;

  // Compute preview total
  const selectedPurchases = eligible.filter(p => selectedIds.has(p.id));
  const previewTotal = purchase.total_amount + selectedPurchases.reduce((acc, p) => acc + p.total_amount, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            {t('Merge invoices into {{id}}', { id: displayInvoiceId(purchase) })}
          </DialogTitle>
          <DialogDescription>
            {t('Select invoices to absorb into this one. This cannot be undone.')}
          </DialogDescription>
        </DialogHeader>

        {/* Target info */}
        <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{displayInvoiceId(purchase)}</span>
            <Badge variant={STATUS_BADGE[purchase.payment_status] ?? 'secondary'} className="text-[10px]">
              {t(purchase.payment_status)}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
            <span>{formatDate(purchase.purchase_date)}</span>
            {purchase.supplier_name && <span>{purchase.supplier_name}</span>}
            <span className="font-medium text-foreground">{formatCurrency(purchase.total_amount)}</span>
          </div>
        </div>

        {/* No supplier warning */}
        {noSupplier ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p>{t('This invoice has no supplier assigned. Assign a supplier first to enable merging.')}</p>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : eligible.length === 0 ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
            {t('No eligible invoices found. Only unpaid invoices from the same supplier can be merged.')}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground -mb-1">
              {t('Select invoices to merge (unpaid only, same supplier):')}
            </p>

            {/* Eligible invoices list */}
            <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
              {eligible.map(p => (
                <label
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/50 select-none"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    onChange={() => toggleSelect(p.id)}
                    className="h-4 w-4 accent-primary shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{displayInvoiceId(p)}</span>
                      <Badge variant={STATUS_BADGE[p.payment_status] ?? 'secondary'} className="text-[10px]">
                        {t(p.payment_status)}
                      </Badge>
                      {p.supplier_name && (
                        <span className="text-xs text-muted-foreground">{p.supplier_name}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex gap-2">
                      <span>{formatDate(p.purchase_date)}</span>
                      <span className="font-medium text-foreground">{formatCurrency(p.total_amount)}</span>
                      {(p.items_count ?? 0) > 0 && (
                        <span>{t('{{n}} items', { n: p.items_count })}</span>
                      )}
                      {(p.pending_items_count ?? 0) > 0 && (
                        <span className="text-amber-500">{t('{{n}} parked', { n: p.pending_items_count })}</span>
                      )}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            {/* Merge preview */}
            {selectedIds.size > 0 && (
              <div className="rounded-lg border bg-primary/5 border-primary/30 p-3 text-sm space-y-1">
                <p className="font-medium text-primary">
                  {t('{{n}} invoice(s) will be merged.', { n: selectedIds.size })}
                  {' '}
                  {t('New total: {{total}} SDG', { total: previewTotal.toLocaleString() })}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {t('This cannot be undone. All items and payments from selected invoices will be moved here.')}
                </p>
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merging}>
            {t('Cancel')}
          </Button>
          {!noSupplier && eligible.length > 0 && (
            <Button
              onClick={handleMerge}
              disabled={selectedIds.size === 0 || merging}
              className="gap-1.5"
            >
              {merging
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <GitMerge className="h-4 w-4" />}
              {t('Merge')} {selectedIds.size > 0 && `(${selectedIds.size})`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
