import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth.store';
import type { Transaction } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, Ban, Loader2, Info } from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VoidDialogProps {
  transactionId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// VoidDialog
// ---------------------------------------------------------------------------

export function VoidDialog({
  transactionId,
  open,
  onOpenChange,
  onComplete,
}: VoidDialogProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.currentUser);
  const isAdmin = user?.role === 'admin';

  // ── State ──────────────────────────────────────────────────────────────────

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [reason, setReason] = useState('');
  const [forceVoid, setForceVoid] = useState(false);

  // ── Fetch transaction on open ──────────────────────────────────────────────

  const fetchTransaction = useCallback(async (txnId: number) => {
    setLoading(true);
    setError(null);
    setTransaction(null);
    setReason('');
    setForceVoid(false);

    try {
      const txn = await api.transactions.getById(txnId);
      setTransaction(txn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to load transaction');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open && transactionId !== null) {
      fetchTransaction(transactionId);
    }
  }, [open, transactionId, fetchTransaction]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const trimmedReason = reason.trim();
  const canSubmit = !submitting && !loading && !!transaction && trimmedReason.length > 0;

  const itemCount = Array.isArray(transaction?.items) ? transaction.items.length : 0;
  const itemTotal = Array.isArray(transaction?.items)
    ? transaction.items.reduce((sum, item) => sum + item.line_total, 0)
    : transaction?.total_amount ?? 0;

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!transaction || !trimmedReason) return;

    setSubmitting(true);
    setError(null);

    try {
      await api.transactions.void(transaction.id, trimmedReason, forceVoid || undefined);
      toast.success(t('Transaction voided'));
      onComplete();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to void transaction');
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
      setReason('');
      setForceVoid(false);
    }
    onOpenChange(nextOpen);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-5 w-5" />
            {t('Void Transaction')}
          </DialogTitle>
          <DialogDescription>
            {t('Permanently void this transaction and reverse all associated stock changes.')}
          </DialogDescription>
        </DialogHeader>

        {/* ── Loading skeleton ──────────────────────────────────────────── */}
        {loading && (
          <div className="space-y-4 py-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {/* ── Error state (failed to load) ─────────────────────────────── */}
        {!loading && error && !transaction && (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* ── Main content ─────────────────────────────────────────────── */}
        {!loading && transaction && (
          <div className="space-y-4">
            {/* Warning banner */}
            <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-destructive">
                  {t('This action cannot be undone.')}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {t('Voiding will reverse all stock changes and mark the transaction as void.')}
                </p>
              </div>
            </div>

            {/* Partial return warning */}
            {transaction.transaction_type === 'sale' && (transaction.returned_amount ?? 0) > 0 && (
              <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/50">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-amber-800 dark:text-amber-200">
                    {t('This sale has returns totalling')} {formatCurrency(transaction.returned_amount ?? 0)}
                  </p>
                  <p className="mt-1 text-amber-700 dark:text-amber-300">
                    {t('Only non-returned stock will be restored. Returned items remain with the customer.')}
                  </p>
                </div>
              </div>
            )}

            {/* Transaction details */}
            <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1.5">
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
                <span className="text-muted-foreground">{t('Type')}</span>
                <span className="font-medium capitalize">{transaction.transaction_type}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Amount')}</span>
                <span className="font-medium">{formatCurrency(transaction.total_amount)}</span>
              </div>

              <Separator className="my-1.5" />

              {/* Items summary (brief) */}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Items')}</span>
                <span className="font-medium">
                  {t('{{count}} items', { count: itemCount })}
                  {' \u2014 '}
                  {formatCurrency(itemTotal)}
                </span>
              </div>
            </div>

            {/* Reason textarea (required) */}
            <div className="space-y-2">
              <Label htmlFor="void-reason">
                {t('Reason')} <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="void-reason"
                rows={3}
                placeholder={t('Enter the reason for voiding this transaction...')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={submitting}
              />
              {!trimmedReason && reason.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('Reason cannot be blank')}
                </p>
              )}
            </div>

            {/* Force void (admin only) */}
            {isAdmin && (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="force-void" className="cursor-pointer">
                    {t('Force void')}
                  </Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <p>
                          {t('Force void bypasses certain validation checks such as batch status conflicts. Use this only when a normal void fails due to edge cases.')}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Switch
                  id="force-void"
                  checked={forceVoid}
                  onCheckedChange={setForceVoid}
                  disabled={submitting}
                />
              </div>
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
            variant="destructive"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                {t('Voiding...')}
              </>
            ) : (
              t('Void Transaction')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
