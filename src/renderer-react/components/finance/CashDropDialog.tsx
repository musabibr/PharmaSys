import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Banknote } from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CashDropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// CashDropDialog
// ---------------------------------------------------------------------------

export function CashDropDialog({ open, onOpenChange, onComplete }: CashDropDialogProps) {
  const { t } = useTranslation();

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const parsedAmount = parseInt(amount, 10) || 0;
  const isValid = parsedAmount > 0 && reason.trim().length > 0;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setAmount('');
      setReason('');
      setError('');
      setLoading(false);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!isValid) return;

    setError('');
    setLoading(true);
    try {
      await api.cashDrops.create(parsedAmount, reason.trim());
      toast.success(t('Cash withdrawal recorded successfully'));
      handleOpenChange(false);
      onComplete();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('Failed to record cash withdrawal');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5" />
            {t('Cash Withdrawal')}
          </DialogTitle>
          <DialogDescription>
            {t('Record a cash withdrawal from the register drawer.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Amount */}
          <div className="space-y-2">
            <Label htmlFor="cash-drop-amount">{t('Amount')} (SDG)</Label>
            <Input
              id="cash-drop-amount"
              type="number"
              step="1"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              disabled={loading}
              autoFocus
            />
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="cash-drop-reason">{t('Reason')}</Label>
            <Textarea
              id="cash-drop-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('Enter reason for cash withdrawal')}
              disabled={loading}
              rows={3}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={loading || !isValid}>
              {loading ? t('Recording...') : t('Record Cash Withdrawal')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
