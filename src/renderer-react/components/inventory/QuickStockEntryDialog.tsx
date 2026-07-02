import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Search, Plus, Trash2, Check, Loader2, PackagePlus } from 'lucide-react';
import type { Product } from '@/api/types';
import { api } from '@/api';
import { formatCurrency } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings.store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { QtyInput } from '@/components/ui/qty-input';

interface QuickRow {
  _key: string;
  productId?: number;     // set → existing product (add stock + propagate price)
  productName: string;
  isNew: boolean;
  genericName: string;
  category: string;
  barcode: string;
  parentUnit: string;
  childUnit: string;
  cf: number;
  qtyBase: number;
  cost: number;           // per parent unit
  sell: number;           // per parent unit (0 → backend applies default markup)
  sellTouched: boolean;
  expiry: string;
  batchNumber: string;
}

interface QuickStockEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

let _seq = 0;
const newKey = () => `qse-${Date.now()}-${_seq++}`;

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function QuickStockEntryDialog({ open, onOpenChange, onSaved }: QuickStockEntryDialogProps) {
  const { t } = useTranslation();
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<QuickRow[]>([]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load product + category caches when opened; reset state.
  useEffect(() => {
    if (!open) return;
    setRows([]);
    setQuery('');
    setSearchOpen(false);
    api.products.getAll().then(setAllProducts).catch(() => setAllProducts([]));
    api.categories.getAll()
      .then((cats) => setCategories(cats.map((c: { name: string }) => c.name).filter(Boolean)))
      .catch(() => setCategories([]));
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const addedIds = new Set(rows.map((r) => r.productId).filter(Boolean));
    return allProducts
      .filter((p) => !addedIds.has(p.id))
      .filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.generic_name && p.generic_name.toLowerCase().includes(q)) ||
        (p.barcode && p.barcode.includes(query.trim())))
      .slice(0, 8);
  }, [query, allProducts, rows]);

  function addExisting(p: Product) {
    const cf = p.conversion_factor && p.conversion_factor > 0 ? p.conversion_factor : 1;
    setRows((prev) => [...prev, {
      _key: newKey(),
      productId: p.id,
      productName: p.name,
      isNew: false,
      genericName: p.generic_name ?? '',
      category: p.category_name ?? '',
      barcode: p.barcode ?? '',
      parentUnit: p.parent_unit ?? 'Box',
      childUnit: p.child_unit ?? '',
      cf,
      qtyBase: 0,
      cost: 0,
      sell: 0,
      sellTouched: false,
      expiry: '',
      batchNumber: '',
    }]);
    setQuery('');
    setSearchOpen(false);
    searchRef.current?.focus();
  }

  function addNew(name: string) {
    setRows((prev) => [...prev, {
      _key: newKey(),
      productId: undefined,
      productName: name.trim(),
      isNew: true,
      genericName: '',
      category: '',
      barcode: '',
      parentUnit: 'Box',
      childUnit: '',
      cf: 1,
      qtyBase: 0,
      cost: 0,
      sell: 0,
      sellTouched: false,
      expiry: '',
      batchNumber: '',
    }]);
    setQuery('');
    setSearchOpen(false);
    searchRef.current?.focus();
  }

  function update(key: string, patch: Partial<QuickRow>) {
    setRows((prev) => prev.map((r) => {
      if (r._key !== key) return r;
      const next = { ...r, ...patch };
      // Auto-fill the sell price from cost + default markup until manually edited.
      if (patch.cost !== undefined && !next.sellTouched) {
        next.sell = next.cost > 0 ? Math.round(next.cost * (1 + defaultMarkup / 100)) : 0;
      }
      return next;
    }));
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r._key !== key));
  }

  function rowError(r: QuickRow): string | null {
    if (!r.productName.trim()) return t('Product name is required');
    if (r.isNew && r.cf < 1) return t('Conversion factor must be at least 1');
    if (r.isNew && r.cf > 1 && !r.childUnit.trim()) return t('Small unit is required when conversion factor > 1');
    if (r.qtyBase > 0) {
      if (!r.expiry) return t('Expiry date is required for stock');
      if (r.expiry <= todayStr()) return t('Expiry date must be in the future');
      if (r.cost <= 0) return t('Cost is required for stock');
    }
    return null;
  }

  const firstError = rows.map(rowError).find(Boolean) ?? null;
  const canSave = rows.length > 0 && !firstError && !saving;

  async function handleSave() {
    if (rows.length === 0) return;
    if (firstError) { toast.error(firstError); return; }

    setSaving(true);
    try {
      const items = rows.map((r) => ({
        product_id: r.productId,
        name: r.productName.trim(),
        generic_name: r.genericName.trim() || undefined,
        category_name: r.category.trim() || undefined,
        barcode: r.barcode.trim() || undefined,
        parent_unit: r.parentUnit.trim() || 'Box',
        child_unit: r.childUnit.trim() || undefined,
        conversion_factor: r.cf,
        min_stock_level: 0,
        batch_number: r.batchNumber.trim() || undefined,
        expiry_date: r.expiry,
        quantity_base: r.qtyBase,
        cost_per_parent: r.cost,
        selling_price_parent: r.sell, // 0 → backend applies default markup
      }));

      const results = await api.products.bulkCreate(items as unknown[]);
      const ok = results.filter((x) => x.success).length;
      const failed = results.length - ok;

      if (ok > 0) {
        toast.success(t('{{count}} product(s) saved', { count: ok }));
      }
      if (failed > 0) {
        const firstFail = results.find((x) => !x.success);
        toast.error(t('{{count}} row(s) failed', { count: failed })
          + (firstFail?.error ? `: ${firstFail.error}` : ''));
      }
      if (ok > 0) {
        onSaved();
        if (failed === 0) onOpenChange(false);
        else setRows((prev) => prev.filter((_r, i) => !results[i]?.success));
      }
    } catch (err) {
      toast.error((err as Error).message || t('Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-5xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5" />
            {t('Quick Stock Entry')}
          </DialogTitle>
          <DialogDescription>
            {t('Search to add existing products, or type a new name to create one. Enter stock in boxes and/or strips.')}
          </DialogDescription>
        </DialogHeader>

        {/* Search / add bar */}
        <div className="relative shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchResults.length > 0) addExisting(searchResults[0]);
                    else if (query.trim()) addNew(query);
                  }
                }}
                placeholder={t('Search existing products or type a new name...')}
                className="ps-9"
              />
            </div>
            <Button
              variant="outline" size="sm" className="gap-1 shrink-0"
              disabled={!query.trim()}
              onClick={() => addNew(query)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('Add New')}
            </Button>
          </div>

          {searchOpen && query.trim().length >= 2 && (
            <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
              {searchResults.length > 0 ? (
                <div className="max-h-56 overflow-y-auto p-1">
                  {searchResults.map((p) => (
                    <button
                      key={p.id}
                      className="w-full flex items-center justify-between text-start px-3 py-2 text-sm hover:bg-accent rounded-sm"
                      onClick={() => addExisting(p)}
                    >
                      <span className="font-medium">{p.name}
                        {p.generic_name && (
                          <span className="text-xs text-muted-foreground ms-2">({p.generic_name})</span>
                        )}
                      </span>
                      {(p.selling_price ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">{formatCurrency(p.selling_price!)}</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-3 text-center">
                  <Button variant="link" size="sm" className="gap-1"
                    onClick={() => addNew(query)}>
                    <Plus className="h-3 w-3" />
                    {t('Add "{{name}}" as new product', { name: query.trim() })}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto space-y-2 pe-1">
          {rows.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              {t('No rows yet — search above to add products.')}
            </div>
          ) : rows.map((r) => {
            const err = rowError(r);
            return (
              <div key={r._key} className="rounded-md border p-3 space-y-2.5">
                {/* Header line */}
                <div className="flex items-center gap-2">
                  {r.isNew ? (
                    <Input
                      value={r.productName}
                      onChange={(e) => update(r._key, { productName: e.target.value })}
                      placeholder={t('Product name')}
                      className="h-8 flex-1 font-medium"
                    />
                  ) : (
                    <span className="flex-1 font-medium">{r.productName}</span>
                  )}
                  {r.isNew
                    ? <Badge variant="secondary" className="gap-1"><Plus className="h-3 w-3" />{t('New')}</Badge>
                    : <Badge variant="outline" className="gap-1 text-green-600"><Check className="h-3 w-3" />{t('Existing')}</Badge>}
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                    onClick={() => removeRow(r._key)} title={t('Remove')}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>

                {/* New-product definition fields */}
                {r.isNew && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Category')}</Label>
                      <Input list="qse-categories" value={r.category}
                        onChange={(e) => update(r._key, { category: e.target.value })}
                        className="h-8 w-36" placeholder={t('Optional')} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Base Unit')}</Label>
                      <Input value={r.parentUnit}
                        onChange={(e) => update(r._key, { parentUnit: e.target.value })}
                        className="h-8 w-24" placeholder={t('Box')} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Small Unit')}</Label>
                      <Input value={r.childUnit}
                        onChange={(e) => update(r._key, { childUnit: e.target.value })}
                        className="h-8 w-24" placeholder={t('Optional')} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Conv Factor')}</Label>
                      <Input type="number" min={1} value={r.childUnit ? (r.cf || '') : ''}
                        onChange={(e) => update(r._key, { cf: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
                        disabled={!r.childUnit} className="h-8 w-20" placeholder="1" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Barcode')}</Label>
                      <Input value={r.barcode}
                        onChange={(e) => update(r._key, { barcode: e.target.value })}
                        className="h-8 w-36" placeholder={t('Optional')} />
                    </div>
                  </div>
                )}

                {/* Batch fields */}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Quantity')}</Label>
                    <QtyInput compact cf={r.cf} parentUnit={r.parentUnit} childUnit={r.childUnit}
                      valueBase={r.qtyBase} onChangeBase={(b) => update(r._key, { qtyBase: b })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Cost')}/{r.parentUnit || t('unit')}</Label>
                    <Input type="number" min={0} value={r.cost || ''}
                      onChange={(e) => update(r._key, { cost: Math.round(Number(e.target.value) || 0) })}
                      className="h-8 w-24" placeholder="0" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Sell')}/{r.parentUnit || t('unit')}</Label>
                    <Input type="number" min={0} value={r.sell || ''}
                      onChange={(e) => update(r._key, { sell: Math.round(Number(e.target.value) || 0), sellTouched: true })}
                      className="h-8 w-24" placeholder={t('auto')} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Expiry Date')}</Label>
                    <Input type="date" value={r.expiry}
                      onChange={(e) => update(r._key, { expiry: e.target.value })}
                      className="h-8 w-40" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Batch #')}</Label>
                    <Input value={r.batchNumber}
                      onChange={(e) => update(r._key, { batchNumber: e.target.value })}
                      className="h-8 w-32" placeholder={t('Optional')} />
                  </div>
                </div>

                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            );
          })}
        </div>

        <datalist id="qse-categories">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>

        <DialogFooter className="shrink-0 gap-2 sm:gap-2">
          <span className="me-auto self-center text-sm text-muted-foreground">
            {t('{{count}} row(s)', { count: rows.length })}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Save All')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
