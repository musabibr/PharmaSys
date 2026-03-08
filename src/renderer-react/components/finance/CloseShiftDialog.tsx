import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShiftStore } from '@/stores/shift.store';
import { api } from '@/api';
import type { ShiftExpectedCash } from '@/api/types';
import { formatCurrency, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Lock,
  Plus,
  Minus,
  Equal,
  TrendingDown,
  TrendingUp,
  CheckCircle,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CloseShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Variance helpers
// ---------------------------------------------------------------------------

function varianceLabel(
  variance: number,
  t: (key: string) => string
): { text: string; className: string; icon: React.ReactNode } {
  if (variance < 0) {
    return {
      text: `${t('Shortage')}: ${formatCurrency(Math.abs(variance))}`,
      className: 'text-destructive',
      icon: <TrendingDown className="h-4 w-4" />,
    };
  }
  if (variance > 0) {
    return {
      text: `${t('Overage')}: ${formatCurrency(variance)}`,
      className: 'text-amber-600 dark:text-amber-400',
      icon: <TrendingUp className="h-4 w-4" />,
    };
  }
  return {
    text: t('Balanced'),
    className: 'text-emerald-600 dark:text-emerald-400',
    icon: <CheckCircle className="h-4 w-4" />,
  };
}

// ---------------------------------------------------------------------------
// BreakdownRow — a single line in the cash breakdown
// ---------------------------------------------------------------------------

interface BreakdownRowProps {
  label: string;
  amount: number;
  sign?: '+' | '-' | '=';
  bold?: boolean;
  highlight?: boolean;
}

function BreakdownRow({ label, amount, sign, bold, highlight }: BreakdownRowProps) {
  const signIcon =
    sign === '+' ? <Plus className="h-3.5 w-3.5 text-emerald-500" /> :
    sign === '-' ? <Minus className="h-3.5 w-3.5 text-destructive" /> :
    sign === '=' ? <Equal className="h-3.5 w-3.5 text-primary" /> :
    null;

  return (
    <div
      className={cn(
        'flex items-center justify-between py-1.5',
        highlight && 'rounded-md bg-muted/50 px-2 -mx-2',
        bold && 'font-semibold'
      )}
    >
      <span className="flex items-center gap-2 text-sm">
        {signIcon}
        {label}
      </span>
      <span className={cn('tabular-nums text-sm', bold && 'font-bold')}>
        {formatCurrency(amount)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CloseShiftDialog
// ---------------------------------------------------------------------------

export function CloseShiftDialog({ open, onOpenChange, onComplete }: CloseShiftDialogProps) {
  const { t } = useTranslation();
  const currentShift = useShiftStore((s) => s.currentShift);

  const [expected, setExpected] = useState<ShiftExpectedCash | null>(null);
  const [actualCash, setActualCash] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');

  // ---- Fetch expected cash breakdown when dialog opens ----
  useEffect(() => {
    if (!open || !currentShift) return;

    let cancelled = false;
    setFetching(true);
    setError('');
    setNotes('');

    (async () => {
      try {
        const data = await api.shifts.getExpectedCash(currentShift.id);
        if (cancelled) return;
        setExpected(data);
        setActualCash(String(data.expected_cash));
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : t('Failed to load shift data');
          setError(msg);
          setExpected(null);
          setActualCash('');
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, currentShift, t]);

  // ---- Derived values ----
  const parsedActual = parseInt(actualCash, 10);
  const actualValid = !isNaN(parsedActual) && parsedActual >= 0;
  const variance = actualValid && expected ? parsedActual - expected.expected_cash : 0;
  const varianceInfo = varianceLabel(variance, t);

  // ---- Submit handler ----
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!currentShift || !actualValid) return;

    setError('');
    setLoading(true);
    try {
      await useShiftStore.getState().closeShift(
        currentShift.id,
        parsedActual,
        notes.trim() || undefined
      );
      toast.success(t('Shift closed successfully'));
      onOpenChange(false);
      onComplete();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('Failed to close shift');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t('Close Shift')}
          </DialogTitle>
          <DialogDescription>
            {t('Review the cash breakdown and enter the actual cash in the drawer.')}
          </DialogDescription>
        </DialogHeader>

        {/* ---- Loading state ---- */}
        {fetching && (
          <div className="space-y-3 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        )}

        {/* ---- Error state (could not fetch) ---- */}
        {!fetching && error && !expected && (
          <div className="py-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* ---- Main content ---- */}
        {!fetching && expected && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Cash Breakdown */}
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                {t('Cash Breakdown')}
              </p>
              <div className="rounded-lg border p-3 space-y-0.5">
                <BreakdownRow
                  label={t('Opening Amount')}
                  amount={expected.opening_amount}
                />
                <BreakdownRow
                  label={t('Cash Sales')}
                  amount={expected.total_cash_sales}
                  sign="+"
                />
                <BreakdownRow
                  label={t('Cash Returns')}
                  amount={expected.total_cash_returns}
                  sign="-"
                />
                <BreakdownRow
                  label={t('Cash Expenses')}
                  amount={expected.total_cash_expenses}
                  sign="-"
                />
                <BreakdownRow
                  label={t('Cash Withdrawals')}
                  amount={expected.total_cash_drops}
                  sign="-"
                />
                <Separator className="my-1.5" />
                <BreakdownRow
                  label={t('Expected Cash')}
                  amount={expected.expected_cash}
                  sign="="
                  bold
                  highlight
                />
              </div>
            </div>

            {/* Actual Cash Input */}
            <div className="space-y-2">
              <Label htmlFor="actual-cash">{t('Actual Cash in Drawer')} (SDG)</Label>
              <Input
                id="actual-cash"
                type="number"
                step="1"
                min="0"
                value={actualCash}
                onChange={(e) => setActualCash(e.target.value)}
                placeholder="0"
                disabled={loading}
                autoFocus
              />

              {/* Variance indicator */}
              {actualValid && (
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2',
                    variance < 0 && 'border-destructive/50 bg-destructive/5',
                    variance > 0 && 'border-amber-500/50 bg-amber-50 dark:bg-amber-950/20',
                    variance === 0 && 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/20'
                  )}
                >
                  {varianceInfo.icon}
                  <span className={cn('text-sm font-medium', varianceInfo.className)}>
                    {varianceInfo.text}
                  </span>
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="close-shift-notes">
                {t('Notes')} <span className="text-muted-foreground">({t('Optional')})</span>
              </Label>
              <Textarea
                id="close-shift-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('Add notes about the shift...')}
                disabled={loading}
                rows={2}
              />
            </div>

            {error && expected && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={loading}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={loading || !actualValid || expected === null || fetching}>
                {loading ? t('Closing...') : t('Close Shift')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
