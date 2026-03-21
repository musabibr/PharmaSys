import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/api';
import type { Batch, AdjustmentType } from '@/api/types';
import { formatQuantity } from '@/lib/utils';
import { printHtml } from '@/lib/print';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DamageReportFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: Batch | null;
  productName: string;
  parentUnit: string;
  childUnit: string;
  conversionFactor: number;
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// DamageReportForm
// ---------------------------------------------------------------------------

export function DamageReportForm({
  open,
  onOpenChange,
  batch,
  productName,
  parentUnit,
  childUnit,
  conversionFactor,
  onSaved,
}: DamageReportFormProps) {
  const { t } = useTranslation();

  // ── Local state ──────────────────────────────────────────────────────────

  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('damage');
  const [unitType, setUnitType] = useState<'parent' | 'child'>('parent');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Derived values ───────────────────────────────────────────────────────

  const hasChildUnit = conversionFactor > 1;
  const availableBase = batch?.quantity_base ?? 0;

  // Available stock in the selected unit
  const availableInUnit = unitType === 'parent'
    ? Math.floor(availableBase / (conversionFactor || 1))
    : availableBase;

  // ── Reset form when dialog opens/closes ──────────────────────────────────

  // Dynamic button label based on type
  const submitLabel: Record<string, string> = {
    damage: t('Report Damage'),
    expiry: t('Write Off Expiry'),
  };

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      // Reset form when opening
      setAdjustmentType('damage');
      setUnitType('parent');
      setQuantity(1);
      setReason('');
      setError(null);
      setSubmitting(false);
      setConfirming(false);
    }
    onOpenChange(nextOpen);
  }

  // ── Submit handler ───────────────────────────────────────────────────────

  function validate(): boolean {
    setError(null);

    if (quantity < 1 || !Number.isInteger(quantity)) {
      setError(t('Quantity must be at least 1'));
      return false;
    }

    if (quantity > availableInUnit) {
      setError(
        t('Quantity exceeds available stock ({{available}})', {
          available: availableInUnit,
        })
      );
      return false;
    }

    if (!reason.trim()) {
      setError(t('Reason is required'));
      return false;
    }

    return true;
  }

  function handleConfirmStep() {
    if (!validate()) return;
    setConfirming(true);
  }

  async function handleSubmit() {
    if (!batch) return;
    if (!validate()) return;

    const trimmedReason = reason.trim();

    // Convert to base units
    const quantityBase = unitType === 'parent'
      ? quantity * (conversionFactor || 1)
      : quantity;

    // Double check base doesn't exceed available
    if (quantityBase > availableBase) {
      setError(
        t('Quantity exceeds available stock ({{available}})', {
          available: formatQuantity(availableBase, parentUnit, childUnit, conversionFactor),
        })
      );
      setConfirming(false);
      return;
    }

    setSubmitting(true);
    try {
      await api.inventory.reportDamage(batch.id, quantityBase, trimmedReason, adjustmentType);
      toast.success(t('Adjustment submitted successfully'));

      // Print damage report
      const adjLabels: Record<string, string> = {
        damage: t('Damage'),
        expiry: t('Expiry Write-off'),
      };
      const fmtQty = (base: number) => formatQuantity(base, parentUnit, childUnit, conversionFactor);
      const newQty = Math.max(0, availableBase - quantityBase);

      printHtml(`
        <h2>${t('Damage / Write-Off Report')}</h2>
        <p style="color:#666; font-size:12px;">${t('Generated')}: ${new Date().toLocaleString()}</p>
        <div class="summary">
          <p><strong>${t('Product')}:</strong> ${productName}</p>
          <p><strong>${t('Batch')}:</strong> ${batch.batch_number ?? '—'}</p>
          <p><strong>${t('Adjustment Type')}:</strong> <span class="badge badge-${adjustmentType === 'damage' ? 'red' : 'yellow'}">${adjLabels[adjustmentType] || adjustmentType}</span></p>
        </div>
        <table style="margin-top:15px;">
          <thead><tr><th>${t('Before')}</th><th>${t('Written Off')}</th><th>${t('After')}</th></tr></thead>
          <tbody><tr>
            <td style="text-align:center; font-weight:600;">${fmtQty(availableBase)}</td>
            <td style="text-align:center; font-weight:700; color:#dc2626;">− ${fmtQty(quantityBase)}</td>
            <td style="text-align:center; font-weight:700; color:#16a34a;">${fmtQty(newQty)}</td>
          </tr></tbody>
        </table>
        <div style="margin-top:15px; background:#fff7ed; border-inline-start:3px solid #f97316; padding:10px 14px; border-radius:6px;">
          <strong>${t('Reason')}:</strong> ${trimmedReason}
        </div>
        <div style="margin-top:30px; border-top:1px solid #e2e8f0; padding-top:10px; display:flex; justify-content:space-between; font-size:11px; color:#94a3b8;">
          <span>PharmaSys</span>
          <span>${new Date().toLocaleString()}</span>
        </div>
      `);

      onSaved();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to submit damage report');
      setError(msg);
      setConfirming(false);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Report Damage / Write-Off')}</DialogTitle>
          <DialogDescription>
            {t('Record inventory damage or expiry write-off for this batch.')}
          </DialogDescription>
        </DialogHeader>

        {!batch ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-destructive">
              {t('No batch selected')}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {/* ── Read-only batch info ──────────────────────────────────── */}
            <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Product')}</span>
                <span className="font-medium">{productName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Batch')}</span>
                <span className="font-medium">
                  {batch.batch_number ?? '\u2014'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Available Stock')}</span>
                <Badge variant="secondary">
                  {formatQuantity(availableBase, parentUnit, childUnit, conversionFactor)}
                </Badge>
              </div>
            </div>

            {/* ── Adjustment Type ───────────────────────────────────────── */}
            <div className="space-y-2">
              <Label>{t('Adjustment Type')}</Label>
              <Select
                value={adjustmentType}
                onValueChange={(val) => { setAdjustmentType(val as AdjustmentType); setConfirming(false); }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="damage">{t('Damage')}</SelectItem>
                  <SelectItem value="expiry">{t('Expiry')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* ── Unit Type ─────────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label>{t('Unit Type')}</Label>
              <div className="flex gap-3">
                {/* Parent unit option */}
                <label
                  className={`flex flex-1 cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                    unitType === 'parent'
                      ? 'border-primary bg-primary/5'
                      : 'border-input hover:bg-accent/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="damageUnitType"
                    value="parent"
                    checked={unitType === 'parent'}
                    onChange={() => {
                      setUnitType('parent');
                      setQuantity(1);
                      setConfirming(false);
                    }}
                    className="accent-primary"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{parentUnit}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('Available')}: {Math.floor(availableBase / (conversionFactor || 1))}
                    </p>
                  </div>
                </label>

                {/* Child unit option (only if conversionFactor > 1) */}
                {hasChildUnit && (
                  <label
                    className={`flex flex-1 cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                      unitType === 'child'
                        ? 'border-primary bg-primary/5'
                        : 'border-input hover:bg-accent/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="damageUnitType"
                      value="child"
                      checked={unitType === 'child'}
                      onChange={() => {
                        setUnitType('child');
                        setQuantity(1);
                        setConfirming(false);
                      }}
                      className="accent-primary"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{childUnit}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('Available')}: {availableBase}
                      </p>
                    </div>
                  </label>
                )}
              </div>
            </div>

            {/* ── Quantity ──────────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label htmlFor="damage-qty">{t('Quantity')}</Label>
              <Input
                id="damage-qty"
                type="number"
                min={1}
                max={availableInUnit}
                step={1}
                value={quantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setQuantity(Number.isNaN(val) ? 1 : Math.max(1, val));
                  setConfirming(false);
                }}
                className={quantity > availableInUnit ? 'ring-1 ring-destructive' : ''}
              />
              <p className={`text-xs ${quantity > availableInUnit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                {quantity > availableInUnit
                  ? t('Exceeds available stock!')
                  : `${t('Max')}: ${availableInUnit} ${unitType === 'parent' ? parentUnit : childUnit}`
                }
              </p>
            </div>

            {/* ── Reason ───────────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label htmlFor="damage-reason">{t('Reason')} *</Label>
              <Textarea
                id="damage-reason"
                rows={3}
                placeholder={t('Describe why this adjustment is needed...')}
                value={reason}
                onChange={(e) => { setReason(e.target.value); setConfirming(false); }}
              />
            </div>

            {/* ── Confirmation preview ──────────────────────────────────── */}
            {confirming && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                <p className="text-sm font-semibold text-destructive">{t('Please confirm this adjustment')}</p>
                <p className="text-xs text-muted-foreground">
                  {quantity} {unitType === 'parent' ? parentUnit : childUnit} {t('will be deducted from stock.')}
                  {' '}{t('This action cannot be undone.')}
                </p>
              </div>
            )}

            {/* ── Error message ─────────────────────────────────────────── */}
            {error && (
              <p className="text-sm font-medium text-destructive">{error}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('Cancel')}
          </Button>
          {!confirming ? (
            <Button
              variant="destructive"
              onClick={handleConfirmStep}
              disabled={submitting || !batch}
            >
              {submitLabel[adjustmentType]}
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={handleSubmit}
              disabled={submitting || !batch}
            >
              {submitting ? (
                <>
                  <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                  {t('Submitting...')}
                </>
              ) : (
                t('Confirm & Submit')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
