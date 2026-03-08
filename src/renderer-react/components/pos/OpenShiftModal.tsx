import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { useShiftStore } from '@/stores/shift.store';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface OpenShiftModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OpenShiftModal({ open, onOpenChange }: OpenShiftModalProps) {
  const { t } = useTranslation();
  const openShift = useShiftStore((s) => s.openShift);

  const [amount, setAmount] = useState('');
  const [lastCash, setLastCash] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingLast, setFetchingLast] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;

    setError('');
    setLoading(false);
    setFetchingLast(true);

    let cancelled = false;

    (async () => {
      try {
        const cash = await api.shifts.getLastCash();
        if (cancelled) return;
        setLastCash(cash);
        if (cash !== null && cash > 0) {
          setAmount(String(cash));
        } else {
          setAmount('');
        }
      } catch {
        if (!cancelled) {
          setLastCash(null);
          setAmount('');
        }
      } finally {
        if (!cancelled) setFetchingLast(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const parsed = parseInt(amount, 10);
    if (isNaN(parsed) || parsed < 0) {
      setError(t('Please enter a valid opening amount'));
      return;
    }

    setError('');
    setLoading(true);
    try {
      await openShift(parsed);
      toast.success(t('Shift opened successfully'));
      onOpenChange(false);
    } catch (err: any) {
      setError(err.message || t('Failed to open shift'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Open New Shift')}</DialogTitle>
          <DialogDescription>
            {t('Enter the opening cash amount for this shift.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="opening-amount">{t('Opening Amount')}</Label>
            <Input
              id="opening-amount"
              type="number"
              step="1"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              disabled={loading || fetchingLast}
              autoFocus
            />
            {lastCash !== null && lastCash > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('Last closing amount')}: {formatCurrency(lastCash)}
              </p>
            )}
          </div>

          {error && (
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
            <Button type="submit" disabled={loading || fetchingLast}>
              {loading ? t('Opening...') : t('Open Shift')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
