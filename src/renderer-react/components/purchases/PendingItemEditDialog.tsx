import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2 } from 'lucide-react';
import { api } from '@/api';
import { useApiCall } from '@/api/hooks';
import { useSettingsStore } from '@/stores/settings.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingItemDraft {
  name: string;
  genericName: string;
  quantity: number;
  costPerParent: number;
  sellPrice: number;
  sellPriceChild: number;
  expiryDate: string;
  batchNumber: string;
  parentUnit: string;
  childUnit: string;
  convFactor: number;
  categoryName: string;
  barcode: string;
  notes: string;
}

export function parseDraft(rawData: string, notes: string | null): PendingItemDraft {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(rawData); } catch { /* ignore */ }
  return {
    name:           String(p.name          ?? ''),
    genericName:    String(p.genericName   ?? ''),
    quantity:       Number(p.quantity      ?? 1),
    costPerParent:  Number(p.costPerParent ?? 0),
    sellPrice:      Number(p.sellPrice     ?? 0),
    sellPriceChild: Number(p.sellPriceChild ?? 0),
    expiryDate:     String(p.expiryDate    ?? ''),
    batchNumber:    String(p.batchNumber   ?? ''),
    parentUnit:     String(p.parentUnit    ?? 'Unit'),
    childUnit:      String(p.childUnit     ?? ''),
    convFactor:     Math.max(1, Number(p.convFactor ?? 1)),
    categoryName:   String(p.categoryName  ?? ''),
    barcode:        String(p.barcode       ?? ''),
    notes:          notes ?? '',
  };
}

export function draftToRaw(d: PendingItemDraft): string {
  return JSON.stringify({
    name: d.name, genericName: d.genericName, quantity: d.quantity,
    costPerParent: d.costPerParent, sellPrice: d.sellPrice,
    sellPriceChild: d.sellPriceChild, expiryDate: d.expiryDate,
    batchNumber: d.batchNumber, parentUnit: d.parentUnit,
    childUnit: d.childUnit, convFactor: d.convFactor,
    categoryName: d.categoryName, barcode: d.barcode,
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

interface PendingItemEditDialogProps {
  item: PendingItemDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: PendingItemDraft) => void | Promise<void>;
}

export function PendingItemEditDialog({ item, open, onOpenChange, onSave }: PendingItemEditDialogProps) {
  const { t } = useTranslation();
  const { getSetting } = useSettingsStore();
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  const { data: categories } = useApiCall(() => api.categories.getAll(), []);

  const [draft, setDraft] = useState<PendingItemDraft | null>(null);
  const [markup, setMarkup] = useState(defaultMarkup);
  const [syncChildToParent, setSyncChildToParent] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item && open) {
      setDraft({ ...item });
      setSyncChildToParent(false);
      setSaving(false);
      if (item.costPerParent > 0 && item.sellPrice > 0) {
        setMarkup(Math.round(((item.sellPrice - item.costPerParent) / item.costPerParent) * 100));
      } else {
        setMarkup(defaultMarkup);
      }
    }
  }, [item, open, defaultMarkup]);

  function update(field: keyof PendingItemDraft, value: string | number) {
    setDraft(prev => {
      if (!prev) return prev;
      const updated = { ...prev, [field]: value };
      if (field === 'childUnit' || field === 'convFactor' || field === 'sellPrice') {
        if (updated.childUnit && updated.convFactor >= 1 && updated.sellPrice > 0) {
          updated.sellPriceChild = Math.floor(updated.sellPrice / updated.convFactor);
        } else if (!updated.childUnit) {
          updated.sellPriceChild = 0;
          updated.convFactor = 1;
        }
      }
      if (field === 'costPerParent') {
        const cost = Number(value) || 0;
        if (cost > 0) {
          updated.sellPrice = Math.round(cost * (1 + markup / 100));
          if (updated.childUnit && updated.convFactor >= 1 && updated.sellPrice > 0) {
            updated.sellPriceChild = Math.floor(updated.sellPrice / updated.convFactor);
          }
        }
      }
      if (field === 'sellPrice' && updated.costPerParent > 0) {
        const sell = Number(value) || 0;
        setMarkup(Math.round(((sell - updated.costPerParent) / updated.costPerParent) * 100));
      }
      if (field === 'sellPriceChild' && syncChildToParent && updated.childUnit && updated.convFactor > 1) {
        const childSell = Number(value) || 0;
        if (childSell > 0) {
          updated.sellPrice = childSell * updated.convFactor;
          if (updated.costPerParent > 0) {
            setMarkup(Math.round(((updated.sellPrice - updated.costPerParent) / updated.costPerParent) * 100));
          }
        }
      }
      return updated;
    });
  }

  function applyMarkup(newMarkup: number) {
    setMarkup(newMarkup);
    setDraft(prev => {
      if (!prev || prev.costPerParent <= 0) return prev;
      const sell = Math.round(prev.costPerParent * (1 + newMarkup / 100));
      const updated = { ...prev, sellPrice: sell };
      if (updated.childUnit && updated.convFactor >= 1 && sell > 0) {
        updated.sellPriceChild = Math.floor(sell / updated.convFactor);
      }
      return updated;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  if (!draft) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Edit Parked Item')}</DialogTitle>
          <DialogDescription>{t('Update the item details below.')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-2">

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="pi-name">
                {t('Name')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pi-name"
                value={draft.name}
                onChange={e => update('name', e.target.value)}
                placeholder={t('Product Name')}
                autoFocus
                maxLength={60}
              />
            </div>

            {/* Generic Name */}
            <div className="space-y-1.5">
              <Label htmlFor="pi-generic">{t('Generic Name')}</Label>
              <Input
                id="pi-generic"
                value={draft.genericName}
                onChange={e => update('genericName', e.target.value)}
                placeholder={t('Generic')}
                maxLength={60}
              />
            </div>

            {/* Barcode */}
            <div className="space-y-1.5">
              <Label htmlFor="pi-barcode">{t('Barcode')}</Label>
              <Input
                id="pi-barcode"
                value={draft.barcode}
                onChange={e => update('barcode', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                placeholder={t('e.g. 6001234567890')}
              />
            </div>

            {/* Category */}
            <div className="space-y-1.5">
              <Label>{t('Category')}</Label>
              <Select
                value={draft.categoryName || '__none__'}
                onValueChange={val => update('categoryName', val === '__none__' ? '' : val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select category')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('None')}</SelectItem>
                  {categories?.map(cat => (
                    <SelectItem key={cat.id} value={cat.name}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label htmlFor="pi-notes">{t('Notes')}</Label>
              <textarea
                id="pi-notes"
                value={draft.notes}
                onChange={e => update('notes', e.target.value)}
                placeholder={t('Optional notes about this item')}
                rows={2}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <Separator />

            {/* Unit configuration */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pi-parent-unit">{t('Base Unit')}</Label>
                <Input
                  id="pi-parent-unit"
                  value={draft.parentUnit}
                  onChange={e => update('parentUnit', e.target.value)}
                  placeholder="Box"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pi-child-unit">{t('Small Unit')}</Label>
                <div className="relative">
                  <Input
                    id="pi-child-unit"
                    value={draft.childUnit}
                    onChange={e => update('childUnit', e.target.value)}
                    placeholder={t('Optional')}
                    className={draft.childUnit ? 'pr-8' : ''}
                  />
                  {draft.childUnit && (
                    <button
                      type="button"
                      onClick={() => update('childUnit', '')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      title={t('Clear small unit')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pi-conv">{t('Conversion Factor')}</Label>
                <Input
                  id="pi-conv"
                  type="number"
                  min={1}
                  step={1}
                  value={draft.childUnit ? (draft.convFactor || '') : ''}
                  onChange={e => update('convFactor', Math.max(1, Math.round(Number(e.target.value) || 1)))}
                  disabled={!draft.childUnit}
                />
              </div>
            </div>

            {draft.childUnit && draft.convFactor > 1 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                1 {draft.parentUnit || t('Base Unit')} = {draft.convFactor} {draft.childUnit || t('Small Unit')}
              </p>
            )}

            <Separator />

            {/* Batch & Expiry */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pi-batch">{t('Batch #')}</Label>
                <Input
                  id="pi-batch"
                  value={draft.batchNumber}
                  onChange={e => update('batchNumber', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pi-expiry">{t('Expiry Date')}</Label>
                <Input
                  id="pi-expiry"
                  value={draft.expiryDate}
                  onChange={e => update('expiryDate', e.target.value)}
                  placeholder="YYYY-MM or YYYY-MM-DD"
                />
              </div>
            </div>

            <Separator />

            {/* Pricing */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pi-qty">
                  {t('Qty')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="pi-qty"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.quantity || ''}
                  onChange={e => update('quantity', Math.round(Number(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pi-cost">
                  {t('Cost/Unit')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="pi-cost"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.costPerParent || ''}
                  onChange={e => update('costPerParent', Math.round(Number(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pi-sell">{t('Sell/Base')}</Label>
                <Input
                  id="pi-sell"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.sellPrice || ''}
                  onChange={e => update('sellPrice', Math.round(Number(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pi-sell-child">{t('Sell/Small')}</Label>
                <Input
                  id="pi-sell-child"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.childUnit ? (draft.sellPriceChild || '') : ''}
                  onChange={e => update('sellPriceChild', Math.round(Number(e.target.value) || 0))}
                  disabled={!draft.childUnit}
                />
              </div>
              {draft.childUnit && (
                <label htmlFor="pi-sync" className="flex items-center gap-2 col-span-2 cursor-pointer select-none">
                  <input
                    id="pi-sync"
                    type="checkbox"
                    checked={syncChildToParent}
                    onChange={e => setSyncChildToParent(e.target.checked)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">{t('Changing small price updates base price')}</span>
                </label>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="pi-markup">{t('Markup %')}</Label>
                <Input
                  id="pi-markup"
                  type="number"
                  min={0}
                  step={1}
                  value={markup || ''}
                  onChange={e => applyMarkup(Math.round(Number(e.target.value) || 0))}
                  disabled={!draft.costPerParent}
                />
              </div>
            </div>

            {draft.costPerParent > 0 && draft.quantity > 0 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
                {t('Line Total')}: {(draft.costPerParent * draft.quantity).toLocaleString()} SDG
              </p>
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('Save Changes')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
