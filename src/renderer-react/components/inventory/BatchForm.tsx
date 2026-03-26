import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, throwIfError } from '@/api';
import type { Batch } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { useSettingsStore } from '@/stores/settings.store';

/** Generate a default batch number: BN-YYYYMMDD-XXX */
let _batchSeq = 0;
function generateBatchNumber(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  _batchSeq = (_batchSeq % 999) + 1;
  return `BN-${y}${m}${day}-${String(_batchSeq).padStart(3, '0')}`;
}
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Package, Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BatchFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: number;
  productName: string;
  parentUnit: string;
  childUnit: string;
  conversionFactor: number;
  batch?: Batch | null; // null = create mode
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// BatchForm
// ---------------------------------------------------------------------------

export function BatchForm({
  open,
  onOpenChange,
  productId,
  productName,
  parentUnit,
  childUnit,
  conversionFactor,
  batch,
  onSaved,
}: BatchFormProps) {
  const { t } = useTranslation();
  const canViewCosts = usePermission('inventory.view_costs');
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;
  const isEditMode = !!batch;
  const hasChildUnit = conversionFactor > 1;

  // ---- Form state ----
  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [costPerParent, setCostPerParent] = useState(0);
  const [sellPricePerParent, setSellPricePerParent] = useState(0);
  const [costPerChild, setCostPerChild] = useState(0);
  const [sellPricePerChild, setSellPricePerChild] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ---- Create-mode: existing active batches for price update offer ----
  const [existingActiveBatches, setExistingActiveBatches] = useState<
    Array<{ id: number; batch_number: string | null; quantity_base: number; expiry_date: string }>
  >([]);
  const [updateExistingPrices, setUpdateExistingPrices] = useState(false);

  // Track whether sell prices have been manually edited
  const [sellParentTouched, setSellParentTouched] = useState(false);
  const [costChildTouched, setCostChildTouched] = useState(false);
  const [sellChildTouched, setSellChildTouched] = useState(false);

  // ---- Initialize form when opening ----
  useEffect(() => {
    if (!open) return;

    setError('');
    setLoading(false);
    setSellParentTouched(false);
    setCostChildTouched(false);
    setSellChildTouched(false);

    setUpdateExistingPrices(false);

    if (batch) {
      // Edit mode: populate from existing batch
      setBatchNumber(batch.batch_number ?? '');
      setExpiryDate(batch.expiry_date);
      // For edit mode, quantity is the current base quantity converted to parent
      const cf = conversionFactor || 1;
      setQuantity(cf > 1 ? Math.floor(batch.quantity_base / cf) : batch.quantity_base);
      setCostPerParent(batch.cost_per_parent);
      setSellPricePerParent(
        batch.selling_price_parent_override || batch.selling_price_parent || 0
      );
      setCostPerChild(
        batch.cost_per_child_override || batch.cost_per_child || 0
      );
      setSellPricePerChild(
        batch.selling_price_child_override || batch.selling_price_child || 0
      );
    } else {
      // Create mode: auto-generate batch number
      setBatchNumber(generateBatchNumber());
      setExpiryDate('');
      setQuantity(1);
      setCostPerParent(0);
      setSellPricePerParent(0);
      setCostPerChild(0);
      setSellPricePerChild(0);
    }
  }, [open, batch, conversionFactor]);

  // ---- Fetch active batches for price-update offer (create mode only) ----
  useEffect(() => {
    if (!open || isEditMode) {
      setExistingActiveBatches([]);
      return;
    }
    api.batches.getActiveBatchesForPriceUpdate(productId)
      .then(setExistingActiveBatches)
      .catch(() => setExistingActiveBatches([]));
  }, [open, isEditMode, productId]);

  // ---- Auto-calculate sell price per parent (only if not manually touched) ----
  useEffect(() => {
    if (!sellParentTouched && costPerParent > 0) {
      setSellPricePerParent(Math.round(costPerParent * (1 + defaultMarkup / 100)));
    }
  }, [costPerParent, sellParentTouched, defaultMarkup]);

  // ---- Auto-calculate cost per child (only if not manually touched) ----
  useEffect(() => {
    if (!costChildTouched && hasChildUnit && costPerParent > 0) {
      setCostPerChild(Math.floor(costPerParent / conversionFactor));
    }
  }, [costPerParent, hasChildUnit, conversionFactor, costChildTouched]);

  // ---- Auto-calculate sell price per child (only if not manually touched) ----
  useEffect(() => {
    if (!sellChildTouched && hasChildUnit && sellPricePerParent > 0) {
      setSellPricePerChild(Math.floor(sellPricePerParent / conversionFactor));
    }
  }, [sellPricePerParent, hasChildUnit, conversionFactor, sellChildTouched]);

  // ---- Show price-update offer: only when new batch has the latest expiry ----
  const showUpdateOffer = useMemo(() => {
    if (isEditMode || !expiryDate || existingActiveBatches.length === 0) return false;
    const maxExpiry = existingActiveBatches.reduce(
      (max, b) => (b.expiry_date > max ? b.expiry_date : max), ''
    );
    return expiryDate > maxExpiry;
  }, [isEditMode, expiryDate, existingActiveBatches]);

  // ---- Margin calculation (matches old version: (sell-cost)/cost) ----
  const margin = useMemo(() => {
    if (sellPricePerParent <= 0 || costPerParent <= 0) {
      return { percent: 0, profit: 0 };
    }
    const profit = sellPricePerParent - costPerParent;
    const percent = Math.round((profit / costPerParent) * 100);
    return { percent, profit };
  }, [costPerParent, sellPricePerParent]);

  const marginColor =
    margin.percent >= defaultMarkup
      ? 'text-green-600'
      : margin.percent >= defaultMarkup / 2
        ? 'text-yellow-600'
        : 'text-destructive';

  // ---- Validation ----
  function validate(): string | null {
    if (!expiryDate) return t('Expiry date is required');
    if (!isEditMode) {
      if (quantity < 1) return t('Quantity must be at least 1');
    }
    if (costPerParent <= 0) return t('Cost per base unit is required');
    return null;
  }

  // ---- Submit ----
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setLoading(true);

    try {
      if (isEditMode && batch) {
        // Edit mode: update batch (including quantity for physical count corrections)
        const cf = conversionFactor || 1;
        const updateData: Record<string, unknown> = {
          version: batch.version,
          expiry_date: expiryDate,
          quantity_base: quantity * cf,
          cost_per_parent: costPerParent,
          selling_price_parent: sellPricePerParent || null,
          selling_price_parent_override: sellPricePerParent || null,
        };

        if (hasChildUnit) {
          updateData.cost_per_child_override = costPerChild || 0;
          updateData.selling_price_child_override = sellPricePerChild || 0;
        }

        throwIfError(await api.batches.update(batch.id, updateData as Partial<Batch>));
        toast.success(t('Batch updated successfully'));
      } else {
        // Create mode: create new batch
        const cf = conversionFactor || 1;
        const createData: Record<string, unknown> = {
          product_id: productId,
          batch_number: batchNumber.trim() || null,
          expiry_date: expiryDate,
          quantity_base: quantity * cf,
          cost_per_parent: costPerParent,
          selling_price_parent: sellPricePerParent || Math.round(costPerParent * 1.2),
        };

        if (hasChildUnit) {
          createData.cost_per_child_override = costPerChild || Math.floor(costPerParent / conversionFactor);
          createData.selling_price_child_override = sellPricePerChild || Math.floor((sellPricePerParent || Math.round(costPerParent * 1.2)) / conversionFactor);
        }

        throwIfError(await api.batches.create(createData as Partial<Batch>));

        if (updateExistingPrices && showUpdateOffer && sellPricePerParent > 0) {
          const updatedCount = await api.batches.updatePricesByProduct({
            productId,
            sellingPriceParent: sellPricePerParent,
            ...(hasChildUnit && sellPricePerChild > 0 ? { sellingPriceChild: sellPricePerChild } : {}),
          });
          toast.success(t('Batch created and {{count}} existing prices updated', { count: updatedCount }));
        } else {
          toast.success(t('Batch created successfully'));
        }
      }

      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  // ---- Render ----
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {isEditMode ? t('Edit Batch') : t('Add New Batch')}
          </DialogTitle>
          <DialogDescription>
            {productName}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* ---- Batch number ---- */}
          <div className="space-y-2">
            <Label htmlFor="batch-number">{t('Batch Number')}</Label>
            {isEditMode ? (
              <p className="text-sm font-medium rounded-md border bg-muted/50 px-3 py-2">
                {batchNumber || '---'}
              </p>
            ) : (
              <Input
                id="batch-number"
                value={batchNumber}
                onChange={(e) => setBatchNumber(e.target.value)}
                placeholder={t('Optional')}
                disabled={loading}
              />
            )}
          </div>

          {/* ---- Expiry date ---- */}
          <div className="space-y-2">
            <Label htmlFor="expiry-date">{t('Expiry Date')} *</Label>
            <Input
              id="expiry-date"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          {/* ---- Quantity ---- */}
          <div className="space-y-2">
            <Label htmlFor="batch-qty">
              {isEditMode ? t('Stock Quantity') : t('Quantity')} ({parentUnit}) {!isEditMode && '*'}
            </Label>
            <Input
              id="batch-qty"
              type="number"
              min={isEditMode ? 0 : 1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(isEditMode ? 0 : 1, parseInt(e.target.value, 10) || (isEditMode ? 0 : 1)))}
              disabled={loading}
            />
            {isEditMode && (
              <p className="text-xs text-muted-foreground">
                {t('Whole numbers only — adjust for physical count corrections')}
              </p>
            )}
          </div>

          {canViewCosts && (
            <>
              <Separator />

              {/* ---- Cost per parent ---- */}
              <div className="space-y-2">
                <Label htmlFor="cost-parent">
                  {t('Cost (Base Unit)')} (SDG) *
                </Label>
                <Input
                  id="cost-parent"
                  type="number"
                  min={0}
                  step={1}
                  value={costPerParent || ''}
                  onChange={(e) => {
                    setCostPerParent(Math.max(0, parseInt(e.target.value, 10) || 0));
                  }}
                  placeholder="0"
                  disabled={loading}
                />
              </div>

              {/* ---- Selling price per parent + markup ---- */}
              <div className="space-y-2">
                <Label htmlFor="sell-parent">
                  {t('Selling Price (Base Unit)')} (SDG)
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="sell-parent"
                    type="number"
                    min={0}
                    step={1}
                    value={sellPricePerParent || ''}
                    onChange={(e) => {
                      setSellParentTouched(true);
                      setSellPricePerParent(Math.max(0, parseInt(e.target.value, 10) || 0));
                    }}
                    placeholder={costPerParent > 0 ? String(Math.round(costPerParent * 1.2)) : '0'}
                    disabled={loading}
                    className="flex-1"
                  />
                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={costPerParent > 0 ? Math.round(((sellPricePerParent - costPerParent) / costPerParent) * 100) : ''}
                      onChange={(e) => {
                        const pct = parseInt(e.target.value, 10) || 0;
                        setSellParentTouched(true);
                        setSellPricePerParent(Math.round(costPerParent * (1 + pct / 100)));
                      }}
                      placeholder="%"
                      disabled={loading || costPerParent <= 0}
                      title={t('Markup %')}
                    />
                  </div>
                </div>
              </div>

              {/* ---- Child unit fields (only when conversionFactor > 1) ---- */}
              {hasChildUnit && (
                <>
                  <Separator />

                  <p className="text-xs text-muted-foreground">
                    {t('Small unit prices')} (1 {parentUnit} = {conversionFactor} {childUnit})
                  </p>

                  {/* ---- Cost per child ---- */}
                  <div className="space-y-2">
                    <Label htmlFor="cost-child">
                      {t('Cost (Small Unit)')} (SDG)
                    </Label>
                    <Input
                      id="cost-child"
                      type="number"
                      min={0}
                      step={1}
                      value={costPerChild || ''}
                      onChange={(e) => {
                        setCostChildTouched(true);
                        setCostPerChild(Math.max(0, parseInt(e.target.value, 10) || 0));
                      }}
                      placeholder={costPerParent > 0 ? String(Math.floor(costPerParent / conversionFactor)) : '0'}
                      disabled={loading}
                    />
                  </div>

                  {/* ---- Selling price per child ---- */}
                  <div className="space-y-2">
                    <Label htmlFor="sell-child">
                      {t('Selling Price (Small Unit)')} (SDG)
                    </Label>
                    <Input
                      id="sell-child"
                      type="number"
                      min={0}
                      step={1}
                      value={sellPricePerChild || ''}
                      onChange={(e) => {
                        setSellChildTouched(true);
                        setSellPricePerChild(Math.max(0, parseInt(e.target.value, 10) || 0));
                      }}
                      placeholder={sellPricePerParent > 0 ? String(Math.floor(sellPricePerParent / conversionFactor)) : '0'}
                      disabled={loading}
                    />
                  </div>
                </>
              )}

              {/* ---- Margin preview ---- */}
              {costPerParent > 0 && (
                <>
                  <Separator />
                  <div className="rounded-lg bg-muted/50 px-4 py-3">
                    <p className={`text-sm font-semibold ${marginColor}`}>
                      {t('Margin')}: {margin.percent}% ({formatCurrency(margin.profit)} {t('profit per')} {parentUnit})
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          {/* ---- Price update offer (create mode, new batch has latest expiry) ---- */}
          {!isEditMode && showUpdateOffer && canViewCosts && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 p-3 space-y-2">
              <p className="text-sm text-blue-700 dark:text-blue-300">
                {t('There are {{count}} active batch(es) with older expiry dates.', { count: existingActiveBatches.length })}
              </p>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={updateExistingPrices}
                  onChange={(e) => setUpdateExistingPrices(e.target.checked)}
                  disabled={loading}
                  className="h-4 w-4 rounded border-gray-300 accent-primary"
                />
                <span className="text-sm text-blue-700 dark:text-blue-300">
                  {t('Also update their selling prices to match this batch')}
                </span>
              </label>
            </div>
          )}

          {/* ---- Error ---- */}
          {error && (
            <p className="text-sm font-medium text-destructive">{error}</p>
          )}

          {/* ---- Footer ---- */}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                  {t('Saving...')}
                </>
              ) : isEditMode ? (
                t('Update Batch')
              ) : (
                t('Create Batch')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
