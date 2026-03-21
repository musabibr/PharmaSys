import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Transaction, TransactionItem } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RotateCcw, Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReturnDialogProps {
  transactionId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReturnableItem {
  /** Original transaction item */
  item: TransactionItem;
  /** Maximum returnable display-unit quantity */
  maxReturnable: number;
  /** User-selected return quantity */
  returnQty: number;
}

// ---------------------------------------------------------------------------
// ReturnDialog
// ---------------------------------------------------------------------------

export function ReturnDialog({
  transactionId,
  open,
  onOpenChange,
  onComplete,
}: ReturnDialogProps) {
  const { t } = useTranslation();

  // ── State ──────────────────────────────────────────────────────────────────

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [returnableItems, setReturnableItems] = useState<ReturnableItem[]>([]);
  const [notes, setNotes] = useState('');

  // ── Fetch data on open ─────────────────────────────────────────────────────

  const fetchData = useCallback(async (txnId: number) => {
    setLoading(true);
    setError(null);
    setTransaction(null);
    setReturnableItems([]);
    setNotes('');

    try {
      const [txn, returnedMap] = await Promise.all([
        api.transactions.getById(txnId),
        api.transactions.getReturnedQty(txnId),
      ]);

      setTransaction(txn);

      const items = Array.isArray(txn.items) ? txn.items : [];
      const returnable: ReturnableItem[] = [];

      for (const item of items) {
        const key = `${item.batch_id}_${item.unit_type}`;
        const alreadyReturnedBase = (returnedMap && typeof returnedMap === 'object')
          ? (returnedMap[key] ?? 0)
          : 0;
        const remainingBase = item.quantity_base - alreadyReturnedBase;

        if (remainingBase > 0) {
          // Convert base units → display units for parent items
          const cf = item.unit_type === 'parent' ? (item.conversion_factor_snapshot ?? item.conversion_factor ?? 1) : 1;
          const maxReturnable = cf > 1 ? Math.floor(remainingBase / cf) : remainingBase;

          if (maxReturnable > 0) {
            returnable.push({
              item,
              maxReturnable,
              returnQty: 0,
            });
          }
        }
      }

      setReturnableItems(returnable);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to load transaction');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open && transactionId !== null) {
      fetchData(transactionId);
    }
  }, [open, transactionId, fetchData]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const hasSelectedItems = useMemo(
    () => returnableItems.some((ri) => ri.returnQty > 0),
    [returnableItems]
  );

  const totalRefund = useMemo(() => {
    let total = 0;
    for (const ri of returnableItems) {
      if (ri.returnQty > 0) {
        total += calculateLineRefund(ri.item, ri.returnQty);
      }
    }
    return total;
  }, [returnableItems]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function updateReturnQty(index: number, qty: number) {
    setReturnableItems((prev) => {
      const next = [...prev];
      const ri = next[index];
      const clamped = Math.max(0, Math.min(qty, ri.maxReturnable));
      next[index] = { ...ri, returnQty: clamped };
      return next;
    });
  }

  async function handleSubmit() {
    if (!transaction || !hasSelectedItems) return;

    setSubmitting(true);
    setError(null);

    try {
      const returnItems = returnableItems
        .filter((ri) => ri.returnQty > 0)
        .map((ri) => ({
          product_id: ri.item.product_id,
          batch_id: ri.item.batch_id,
          quantity: ri.returnQty,
          unit_type: ri.item.unit_type,
          unit_price: ri.item.unit_price,
          cost_price: ri.item.cost_price,
          discount_percent: ri.item.discount_percent,
        }));

      await api.transactions.createReturn({
        original_transaction_id: transaction.id,
        items: returnItems,
        payment_method: 'cash',
        notes: notes.trim() || undefined,
      });

      toast.success(t('Return processed successfully'));
      onComplete();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to process return');
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setLoading(true);
      setSubmitting(false);
      setError(null);
      setTransaction(null);
      setReturnableItems([]);
      setNotes('');
    }
    onOpenChange(nextOpen);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5" />
            {t('Return Items')}
          </DialogTitle>
          <DialogDescription>
            {transaction
              ? t('Select items and quantities to return from transaction {{number}}.', {
                  number: transaction.transaction_number,
                })
              : t('Loading transaction details...')}
          </DialogDescription>
        </DialogHeader>

        {/* ── Loading skeleton ──────────────────────────────────────────── */}
        {loading && (
          <div className="space-y-4 py-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {/* ── Error state ──────────────────────────────────────────────── */}
        {!loading && error && !transaction && (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* ── Main content ─────────────────────────────────────────────── */}
        {!loading && transaction && (
          <div className="flex flex-1 flex-col gap-4 overflow-hidden">
            {/* Transaction info summary */}
            <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Transaction')}</span>
                <span className="font-medium">{transaction.transaction_number}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Date')}</span>
                <span className="font-medium">
                  {new Date(transaction.created_at).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Original Amount')}</span>
                <span className="font-medium">{formatCurrency(transaction.total_amount)}</span>
              </div>
            </div>

            {/* Returnable items or empty state */}
            {returnableItems.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-sm text-muted-foreground">
                  {t('All items from this transaction have already been returned.')}
                </p>
              </div>
            ) : (
              <ScrollArea className="flex-1 -mx-1 px-1">
                <div className="space-y-3">
                  {returnableItems.map((ri, index) => {
                    const lineRefund = ri.returnQty > 0
                      ? calculateLineRefund(ri.item, ri.returnQty)
                      : 0;
                    // Show display units (parent or child) not raw base units
                    const cf = ri.item.unit_type === 'parent' ? (ri.item.conversion_factor_snapshot ?? ri.item.conversion_factor ?? 1) : 1;
                    const displayOriginal = cf > 1 ? Math.floor(ri.item.quantity_base / cf) : ri.item.quantity_base;
                    const alreadyReturned = displayOriginal - ri.maxReturnable;

                    return (
                      <div
                        key={`${ri.item.batch_id}_${ri.item.unit_type}_${ri.item.id}`}
                        className="rounded-lg border p-3 space-y-2"
                      >
                        {/* Product name and unit type */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {ri.item.product_name ?? t('Product #{{id}}', { id: ri.item.product_id })}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t('Unit price')}: {formatCurrency(ri.item.unit_price)}
                              {ri.item.discount_percent > 0 && (
                                <span className="ms-2 text-destructive">
                                  -{ri.item.discount_percent}%
                                </span>
                              )}
                            </p>
                          </div>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium uppercase">
                            {ri.item.unit_type}
                          </span>
                        </div>

                        {/* Quantity info and input */}
                        <div className="grid grid-cols-4 gap-2 items-center text-xs">
                          <div>
                            <span className="text-muted-foreground">{t('Original')}</span>
                            <p className="font-medium tabular-nums">{displayOriginal}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('Returned')}</span>
                            <p className="font-medium tabular-nums">{alreadyReturned}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('Max')}</span>
                            <p className="font-medium tabular-nums">{ri.maxReturnable}</p>
                          </div>
                          <div>
                            <Label htmlFor={`return-qty-${index}`} className="text-xs">
                              {t('Return Qty')}
                            </Label>
                            <Input
                              id={`return-qty-${index}`}
                              type="number"
                              min={0}
                              max={ri.maxReturnable}
                              step={1}
                              value={ri.returnQty}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10);
                                updateReturnQty(index, Number.isNaN(val) ? 0 : val);
                              }}
                              className="h-8 text-sm tabular-nums"
                              disabled={submitting}
                            />
                          </div>
                        </div>

                        {/* Line refund */}
                        {ri.returnQty > 0 && (
                          <div className="flex justify-end">
                            <span className="text-sm font-medium text-destructive">
                              {t('Refund')}: {formatCurrency(lineRefund)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="return-notes">{t('Notes')}</Label>
              <Textarea
                id="return-notes"
                rows={2}
                placeholder={t('Optional return notes...')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={submitting}
              />
            </div>

            {/* Summary */}
            {hasSelectedItems && (
              <>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{t('Total Refund')}</span>
                  <span className="text-lg font-bold text-destructive">
                    {formatCurrency(totalRefund)}
                  </span>
                </div>
              </>
            )}

            {/* Error during submission */}
            {error && transaction && (
              <p className="text-sm font-medium text-destructive">{error}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            {t('Cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !hasSelectedItems || loading}
          >
            {submitting ? (
              <>
                <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                {t('Processing...')}
              </>
            ) : (
              t('Process Return')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate the refund amount for a single line item.
 * Uses original sale prices and discount, matching the backend logic.
 */
function calculateLineRefund(item: TransactionItem, returnQty: number): number {
  const effectivePrice = Math.floor(item.unit_price * (100 - item.discount_percent) / 100);
  return effectivePrice * returnQty;
}
