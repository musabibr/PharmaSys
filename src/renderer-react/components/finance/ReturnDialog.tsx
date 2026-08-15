import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Transaction, TransactionItem } from '@/api/types';
import { formatCurrency, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RotateCcw, Loader2, AlertTriangle } from 'lucide-react';

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

/**
 * One entry per BATCH, not per original line.
 *
 * Returns are tracked per batch (`getReturnedQty` keys on batch_id), so a
 * per-line "remaining" is genuinely unknowable once a partial return exists —
 * there is no record of which line it came from. A sale can hold two lines on
 * one batch ("1 box" + "3 strips" both FIFO-resolve to it), and giving each
 * line the batch's full remaining pool would offer to refund the pool twice.
 * Grouping by batch matches how the backend validates, so what the dialog
 * offers is exactly what will be accepted.
 */
interface ReturnableItem {
  batchId: number;
  /** Representative line for display/cf — the parent line when one exists. */
  item: TransactionItem;
  /** Parent-unit line on this batch, if the sale had one. */
  parentItem?: TransactionItem;
  /** Child-unit line on this batch, if the sale had one. */
  childItem?: TransactionItem;
  /** Base units sold on this batch across every line. */
  soldBase: number;
  /** Total remaining base units — constant source of truth */
  maxReturnableBase: number;
  /** Which unit the user is currently returning in (can be toggled for parent items) */
  returnUnitType: 'parent' | 'child';
  /** Return quantity in returnUnitType display units */
  returnQty: number;
}

/**
 * The line the BACKEND will price this return against, mirroring its lookup
 * exactly: exact unit_type match first, else the parent line (a cross-unit
 * return). Resolving it the same way here keeps the previewed refund and the
 * charged refund identical when a batch has both a parent and a child line
 * at different effective per-unit prices.
 */
function pricingItem(ri: ReturnableItem): TransactionItem {
  if (ri.returnUnitType === 'child' && ri.childItem) return ri.childItem;
  if (ri.returnUnitType === 'parent' && ri.parentItem) return ri.parentItem;
  return ri.item;
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

      // C1: a sale can legitimately contain two lines against the same batch
      // (e.g. "1 box" + "3 strips" both FIFO-resolved to it), and returns are
      // recorded per batch, not per line. Group by batch so the sold side,
      // the already-returned side, and the remaining pool are all measured
      // the same way the backend measures them — one row per batch, offering
      // the pool exactly once.
      const byBatch = new Map<number, {
        parentItem?: TransactionItem;
        childItem?: TransactionItem;
        first: TransactionItem;
        soldBase: number;
      }>();

      for (const item of items) {
        const g = byBatch.get(item.batch_id)
          ?? { first: item, soldBase: 0 };
        g.soldBase += item.quantity_base;
        if (item.unit_type === 'parent') g.parentItem ??= item;
        else g.childItem ??= item;
        byBatch.set(item.batch_id, g);
      }

      for (const [batchId, g] of byBatch) {
        const alreadyReturnedBase = (returnedMap && typeof returnedMap === 'object')
          ? (returnedMap[`${batchId}`] ?? 0)
          : 0;
        const remainingBase = g.soldBase - alreadyReturnedBase;

        // Include the batch if any base units remain — even < 1 full box counts
        // because the user can return individual strips via cross-unit return.
        if (remainingBase > 0) {
          // Prefer the parent line as the representative: it carries the
          // conversion factor and is what enables the parent/child toggle.
          const primary = g.parentItem ?? g.childItem ?? g.first;
          returnable.push({
            batchId,
            item: primary,
            parentItem: g.parentItem,
            childItem: g.childItem,
            soldBase: g.soldBase,
            maxReturnableBase: remainingBase,
            returnUnitType: primary.unit_type,
            returnQty: 0,
          });
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
        total += calculateLineRefund(pricingItem(ri), ri.returnQty, ri.returnUnitType);
      }
    }
    return total;
  }, [returnableItems]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function getMaxReturnable(ri: ReturnableItem): number {
    const cf = ri.item.unit_type === 'parent'
      ? (ri.item.conversion_factor_snapshot ?? ri.item.conversion_factor ?? 1)
      : 1;
    // Cross-unit: strip count equals base count directly
    if (ri.returnUnitType === 'child' && ri.item.unit_type === 'parent') {
      return ri.maxReturnableBase;
    }
    return cf > 1 ? Math.floor(ri.maxReturnableBase / cf) : ri.maxReturnableBase;
  }

  function updateReturnQty(index: number, qty: number) {
    setReturnableItems((prev) => {
      const next = [...prev];
      const ri = next[index];
      const clamped = Math.max(0, Math.min(qty, getMaxReturnable(ri)));
      next[index] = { ...ri, returnQty: clamped };
      return next;
    });
  }

  function updateReturnUnitType(index: number, unitType: 'parent' | 'child') {
    setReturnableItems((prev) => {
      const next = [...prev];
      // Reset qty when switching units to avoid stale values
      next[index] = { ...next[index], returnUnitType: unitType, returnQty: 0 };
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
          batch_id: ri.batchId,
          quantity: ri.returnQty,
          unit_type: ri.returnUnitType,  // may differ from item.unit_type for cross-unit
        }));

      await api.transactions.createReturn({
        original_transaction_id: transaction.id,
        items: returnItems,
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
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
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
          <div className="flex flex-1 flex-col gap-4 overflow-hidden min-h-0">
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

            {/* ── Deleted-batch / inactive-product warnings ─────────────── */}
            {(() => {
              const hasDeletedBatch = returnableItems.some((ri) => ri.item.batch_number == null);
              const hasInactiveProduct = returnableItems.some((ri) => ri.item.product_is_active === 0);
              if (!hasDeletedBatch && !hasInactiveProduct) return null;
              return (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 space-y-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                    <div className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
                      {hasDeletedBatch && (
                        <p>{t('One or more items reference batches that have been deleted. Proceeding will restore those batches as new quarantine batches with the returned quantity. A pharmacist must review them.')}</p>
                      )}
                      {hasInactiveProduct && (
                        <p>{t('One or more items have an inactive (deleted) product. The product must be reactivated before any restored stock can be sold.')}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Returnable items or empty state */}
            {returnableItems.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-sm text-muted-foreground">
                  {t('All items from this transaction have already been returned.')}
                </p>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
                <div className="space-y-3">
                  {returnableItems.map((ri, index) => {
                    const cf = ri.item.unit_type === 'parent'
                      ? (ri.item.conversion_factor_snapshot ?? ri.item.conversion_factor ?? 1)
                      : 1;
                    const isCrossReturn = ri.returnUnitType === 'child' && ri.item.unit_type === 'parent';
                    const canToggleUnit = ri.item.unit_type === 'parent' && cf > 1;
                    const maxReturnable = getMaxReturnable(ri);

                    // Display quantities in terms of the current returnUnitType.
                    // Both sides are batch-level (soldBase, maxReturnableBase) —
                    // mixing a line's own quantity_base with a batch-level
                    // remaining produced a negative "already returned" on the
                    // smaller of two lines sharing a batch.
                    const alreadyReturnedBase = ri.soldBase - ri.maxReturnableBase;
                    const displayOriginal = isCrossReturn
                      ? ri.soldBase
                      : (cf > 1 ? Math.floor(ri.soldBase / cf) : ri.soldBase);
                    const alreadyReturned = isCrossReturn
                      ? alreadyReturnedBase
                      : (cf > 1 ? Math.floor(alreadyReturnedBase / cf) : alreadyReturnedBase);

                    // Price from the line the backend will actually match, so
                    // the previewed refund equals the charged refund.
                    const priceItem = pricingItem(ri);
                    const priceIsCross = priceItem.unit_type !== ri.returnUnitType;
                    const displayUnitPrice = (priceIsCross && ri.returnUnitType === 'child' && cf > 1)
                      ? Math.floor(priceItem.unit_price / cf)
                      : priceItem.unit_price;
                    const lineRefund = ri.returnQty > 0
                      ? calculateLineRefund(priceItem, ri.returnQty, ri.returnUnitType)
                      : 0;

                    return (
                      <div
                        key={`batch_${ri.batchId}`}
                        className="rounded-lg border p-3 space-y-2"
                      >
                        {/* Product name and unit type */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {ri.item.product_name ?? t('Product #{{id}}', { id: ri.item.product_id })}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t('Unit price')}: {formatCurrency(displayUnitPrice)}
                              {isCrossReturn && cf > 1 && (
                                <span className="ms-1 text-muted-foreground/70">
                                  / {ri.item.child_unit ?? t('strip')}
                                </span>
                              )}
                              {/* From the priced line, not the representative —
                                  the two can carry different discounts. */}
                              {priceItem.discount_percent > 0 && (
                                <span className="ms-2 text-destructive">
                                  -{priceItem.discount_percent}%
                                </span>
                              )}
                            </p>
                            {canToggleUnit && (
                              <div className="flex items-center gap-1.5 mt-1">
                                <span className="text-xs text-muted-foreground">{t('Return as')}:</span>
                                <button
                                  type="button"
                                  onClick={() => updateReturnUnitType(index, 'parent')}
                                  className={cn(
                                    'px-2 py-0.5 text-xs rounded border transition-colors',
                                    ri.returnUnitType === 'parent'
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : 'bg-background border-border text-muted-foreground hover:bg-muted'
                                  )}
                                  disabled={submitting}
                                >
                                  {ri.item.parent_unit ?? t('Box')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => updateReturnUnitType(index, 'child')}
                                  className={cn(
                                    'px-2 py-0.5 text-xs rounded border transition-colors',
                                    ri.returnUnitType === 'child'
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : 'bg-background border-border text-muted-foreground hover:bg-muted'
                                  )}
                                  disabled={submitting}
                                >
                                  {ri.item.child_unit ?? t('Strip')}
                                </button>
                              </div>
                            )}
                            {ri.item.batch_number == null && (
                              <span className="inline-flex items-center gap-1 mt-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="h-3 w-3" />
                                {t('Batch deleted — will restore as quarantine')}
                              </span>
                            )}
                            {ri.item.product_is_active === 0 && (
                              <span className="inline-flex items-center gap-1 mt-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="h-3 w-3" />
                                {t('Product inactive — must reactivate before selling')}
                              </span>
                            )}
                          </div>
                          <span className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium uppercase',
                            isCrossReturn ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-muted'
                          )}>
                            {ri.returnUnitType}
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
                            <p className="font-medium tabular-nums">{maxReturnable}</p>
                          </div>
                          <div>
                            <Label htmlFor={`return-qty-${index}`} className="text-xs">
                              {t('Return Qty')}
                            </Label>
                            <Input
                              id={`return-qty-${index}`}
                              type="number"
                              min={0}
                              max={maxReturnable}
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
              </div>
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
 * For cross-unit returns (sold box, returning strips) the per-strip price is derived
 * from the original box price using floor division — matching the backend logic exactly.
 */
function calculateLineRefund(
  item: TransactionItem,
  returnQty: number,
  returnUnitType: 'parent' | 'child'
): number {
  const cf = item.unit_type === 'parent'
    ? (item.conversion_factor_snapshot ?? item.conversion_factor ?? 1)
    : 1;
  const isCrossUnit = item.unit_type !== returnUnitType;
  const unitPrice = (isCrossUnit && returnUnitType === 'child' && cf > 1)
    ? Math.floor(item.unit_price / cf)
    : item.unit_price;
  return Math.floor(unitPrice * (100 - item.discount_percent) / 100) * returnQty;
}
