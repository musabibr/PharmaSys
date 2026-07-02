import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Search, Plus, Trash2, Check, Loader2, PackagePlus, ArrowLeft, ArrowRight } from 'lucide-react';
import type { Product } from '@/api/types';
import { api } from '@/api';
import { formatCurrency, formatQuantity, unitLabel } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings.store';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { QtyInput } from '@/components/ui/qty-input';

interface QuickRow {
  _key: string;
  productId?: number;     // set → existing product (add stock + propagate price)
  productName: string;
  isNew: boolean;
  genericName: string;
  usageInstructions: string;
  category: string;
  barcode: string;
  parentUnit: string;
  childUnit: string;
  cf: number;
  minStock: number;
  currentStockBase: number; // existing products: stock on hand, for context
  qtyBase: number;
  cost: number;            // per parent unit
  costSmall: number;        // per small unit
  costSmallTouched: boolean;
  sell: number;             // per parent unit (0 → backend applies default markup)
  sellTouched: boolean;
  sellSmall: number;        // per small unit
  sellSmallTouched: boolean;
  expiry: string;
  batchNumber: string;
}

let _seq = 0;
const newKey = () => `qse-${Date.now()}-${_seq++}`;

/** Default batch number, same convention as BatchForm / the product form: BN-YYYYMMDD-XXX */
let _batchSeq = 0;
function generateBatchNumber(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  _batchSeq = (_batchSeq % 999) + 1;
  return `BN-${y}${m}${day}-${String(_batchSeq).padStart(3, '0')}`;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function QuickStockEntryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const isRtl = i18n.dir() === 'rtl';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<QuickRow[]>([]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.products.getAll().then(setAllProducts).catch(() => setAllProducts([]));
    api.categories.getAll()
      .then((cats) => setCategories(cats.map((c: { name: string }) => c.name).filter(Boolean)))
      .catch(() => setCategories([]));
    setTimeout(() => searchRef.current?.focus(), 50);
  }, []);

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
      usageInstructions: p.usage_instructions ?? '',
      category: p.category_name ?? '',
      barcode: p.barcode ?? '',
      parentUnit: p.parent_unit ?? 'Box',
      childUnit: p.child_unit ?? '',
      cf,
      minStock: p.min_stock_level ?? 0,
      currentStockBase: p.total_stock_base ?? 0,
      qtyBase: 0,
      cost: 0,
      costSmall: 0,
      costSmallTouched: false,
      // Prefill with the product's current effective prices so a plain restock
      // keeps the shelf price unless the user changes it.
      sell: p.selling_price ?? 0,
      sellTouched: (p.selling_price ?? 0) > 0,
      sellSmall: p.selling_price_child ?? 0,
      sellSmallTouched: (p.selling_price_child ?? 0) > 0,
      expiry: '',
      batchNumber: generateBatchNumber(),
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
      usageInstructions: '',
      category: '',
      barcode: '',
      parentUnit: 'Box',
      childUnit: '',
      cf: 1,
      minStock: 0,
      currentStockBase: 0,
      qtyBase: 0,
      cost: 0,
      costSmall: 0,
      costSmallTouched: false,
      sell: 0,
      sellTouched: false,
      sellSmall: 0,
      sellSmallTouched: false,
      expiry: '',
      batchNumber: generateBatchNumber(),
    }]);
    setQuery('');
    setSearchOpen(false);
    searchRef.current?.focus();
  }

  /** Update a row and re-derive untouched prices: cost → sell (markup) and both small-unit values (floor division). */
  function update(key: string, patch: Partial<QuickRow>) {
    setRows((prev) => prev.map((r) => {
      if (r._key !== key) return r;
      const next = { ...r, ...patch };
      const cf = next.cf > 1 ? next.cf : 1;
      if (patch.cost !== undefined && !next.sellTouched) {
        next.sell = next.cost > 0 ? Math.round(next.cost * (1 + defaultMarkup / 100)) : 0;
      }
      if ((patch.cost !== undefined || patch.cf !== undefined) && !next.costSmallTouched) {
        next.costSmall = next.cost > 0 && cf > 1 ? Math.floor(next.cost / cf) : 0;
      }
      if ((patch.cost !== undefined || patch.sell !== undefined || patch.cf !== undefined) && !next.sellSmallTouched) {
        next.sellSmall = next.sell > 0 && cf > 1 ? Math.floor(next.sell / cf) : 0;
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
  const grandTotal = rows.reduce(
    (sum, r) => sum + Math.round((r.cost * r.qtyBase) / (r.cf > 1 ? r.cf : 1)), 0,
  );

  async function handleSave() {
    if (rows.length === 0) return;
    if (firstError) { toast.error(firstError); return; }

    setSaving(true);
    try {
      const items = rows.map((r) => ({
        product_id: r.productId,
        name: r.productName.trim(),
        generic_name: r.genericName.trim() || undefined,
        usage_instructions: r.usageInstructions.trim() || undefined,
        category_name: r.category.trim() || undefined,
        barcode: r.barcode.trim() || undefined,
        parent_unit: r.parentUnit.trim() || 'Box',
        child_unit: r.childUnit.trim() || undefined,
        conversion_factor: r.cf,
        min_stock_level: r.minStock,
        batch_number: r.batchNumber.trim() || undefined,
        expiry_date: r.expiry,
        quantity_base: r.qtyBase,
        cost_per_parent: r.cost,
        cost_per_child: r.cf > 1 && r.costSmall > 0 ? r.costSmall : undefined,
        selling_price_parent: r.sell, // 0 → backend applies default markup
        selling_price_child: r.cf > 1 && r.sellSmall > 0 ? r.sellSmall : undefined,
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
        // Keep only the failed rows so they can be corrected and retried.
        setRows((prev) => prev.filter((_r, i) => !results[i]?.success));
        // Refresh the product cache (new products are now matchable).
        api.products.getAll().then(setAllProducts).catch(() => {});
      }
    } catch (err) {
      toast.error((err as Error).message || t('Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/inventory')} title={t('Back to Inventory')}>
          <BackIcon className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-48">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PackagePlus className="h-6 w-6" />
            {t('Quick Stock Entry')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('Search to add existing products, or type a new name to create one. Enter stock in boxes and/or strips.')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t('{{count}} row(s)', { count: rows.length })}
            {grandTotal > 0 && <> · {t('Total')}: <span className="font-medium text-foreground">{formatCurrency(grandTotal)}</span></>}
          </span>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Save All')}
          </Button>
        </div>
      </div>

      {/* Search / add bar */}
      <div className="relative max-w-2xl">
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
      <div className="space-y-3">
        {rows.length === 0 ? (
          <Card>
            <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              {t('No rows yet — search above to add products.')}
            </CardContent>
          </Card>
        ) : rows.map((r) => {
          const err = rowError(r);
          const hasSmall = r.cf > 1;
          const pUnit = unitLabel(r.parentUnit, t, t('unit'));
          const cUnit = unitLabel(r.childUnit, t, t('unit'));
          // Don't repeat the generic name when it's already part of the product name.
          const showGeneric = !!r.genericName
            && !r.productName.toLowerCase().includes(r.genericName.toLowerCase());
          return (
            <Card key={r._key}>
              <CardContent className="p-4 space-y-3">
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
                    <span className="flex-1 font-medium">
                      {r.productName}
                      {showGeneric && (
                        <span className="ms-2 text-xs font-normal text-muted-foreground">({r.genericName})</span>
                      )}
                    </span>
                  )}
                  {r.isNew
                    ? <Badge variant="secondary" className="gap-1"><Plus className="h-3 w-3" />{t('New')}</Badge>
                    : <Badge variant="outline" className="gap-1 text-green-600"><Check className="h-3 w-3" />{t('Existing')}</Badge>}
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                    onClick={() => removeRow(r._key)} title={t('Remove')}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>

                {/* Existing products: context line (category, unit ratio, stock, barcode) */}
                {!r.isNew && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {r.category && <span>{r.category}</span>}
                    {hasSmall && <span>1 {pUnit} = {r.cf} {cUnit}</span>}
                    <span>
                      {t('In stock')}: {formatQuantity(r.currentStockBase, pUnit, cUnit, r.cf)}
                    </span>
                    {r.barcode && (
                      <span>
                        {t('Barcode')}: <bdi dir="ltr">{r.barcode}</bdi>
                      </span>
                    )}
                  </div>
                )}

                {/* Product definition fields (full set for new; barcode fill-in for existing) */}
                {(r.isNew || !r.barcode) && (
                <div className="flex flex-wrap items-end gap-2">
                  {r.isNew && (
                    <>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Generic Name')}</Label>
                        <Input value={r.genericName}
                          onChange={(e) => update(r._key, { genericName: e.target.value })}
                          className="h-8 w-36" placeholder={t('Optional')} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Category')}</Label>
                        <Input list="qse-categories" value={r.category}
                          onChange={(e) => update(r._key, { category: e.target.value })}
                          className="h-8 w-36" placeholder={t('Optional')} />
                      </div>
                    </>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Barcode')}</Label>
                    <Input value={r.barcode} dir="ltr"
                      onChange={(e) => update(r._key, { barcode: e.target.value })}
                      className="h-8 w-36" placeholder={t('Optional')} />
                  </div>
                  {r.isNew && (
                    <>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Base Unit')}</Label>
                        <Input value={r.parentUnit}
                          onChange={(e) => update(r._key, { parentUnit: e.target.value })}
                          className="h-8 w-24" placeholder={t('Box')} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Small Unit')}</Label>
                        <Input value={r.childUnit}
                          onChange={(e) => update(r._key, { childUnit: e.target.value, ...(e.target.value ? {} : { cf: 1 }) })}
                          className="h-8 w-24" placeholder={t('Optional')} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Conv Factor')}</Label>
                        <Input type="number" min={1} value={r.childUnit ? (r.cf || '') : ''}
                          onChange={(e) => update(r._key, { cf: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
                          disabled={!r.childUnit} className="h-8 w-20" placeholder="1" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Min Stock Level')}</Label>
                        <Input type="number" min={0} value={r.minStock || ''}
                          onChange={(e) => update(r._key, { minStock: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                          className="h-8 w-20" placeholder="0" />
                      </div>
                      <div className="space-y-1 flex-1 min-w-48">
                        <Label className="text-xs text-muted-foreground">{t('Usage Instructions')}</Label>
                        <Input value={r.usageInstructions}
                          onChange={(e) => update(r._key, { usageInstructions: e.target.value })}
                          className="h-8" placeholder={t('e.g. 3 times daily')} />
                      </div>
                    </>
                  )}
                </div>
                )}

                {/* Batch fields: quantity | costs + margin + prices | expiry + batch # */}
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Quantity')}</Label>
                    <QtyInput compact cf={r.cf} parentUnit={r.parentUnit} childUnit={r.childUnit}
                      valueBase={r.qtyBase} onChangeBase={(b) => update(r._key, { qtyBase: b })} />
                  </div>
                  <div className="flex flex-wrap items-end gap-2 border-s ps-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Cost')}/{pUnit}</Label>
                    <Input type="number" min={0} value={r.cost || ''}
                      onChange={(e) => update(r._key, { cost: Math.round(Number(e.target.value) || 0) })}
                      className="h-8 w-24" placeholder="0" />
                  </div>
                  {hasSmall && (
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Cost')}/{cUnit}</Label>
                      <Input type="number" min={0} value={r.costSmall || ''}
                        onChange={(e) => update(r._key, { costSmall: Math.round(Number(e.target.value) || 0), costSmallTouched: true })}
                        className="h-8 w-24" placeholder={t('auto')} />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Margin')} %</Label>
                    {/* Typing a margin sets the base sell price from the cost. */}
                    <Input type="number"
                      className="h-8 w-20 text-end"
                      value={r.cost > 0 && r.sell > 0 ? Math.round(((r.sell - r.cost) / r.cost) * 100) : ''}
                      disabled={r.cost <= 0}
                      placeholder="%"
                      onChange={(e) => {
                        const m = Number(e.target.value);
                        if (!Number.isFinite(m) || r.cost <= 0) return;
                        update(r._key, { sell: Math.max(0, Math.round(r.cost * (1 + m / 100))), sellTouched: true });
                      }} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Sell')}/{pUnit}</Label>
                    <Input type="number" min={0} value={r.sell || ''}
                      onChange={(e) => update(r._key, { sell: Math.round(Number(e.target.value) || 0), sellTouched: true })}
                      className="h-8 w-24" placeholder={t('auto')} />
                  </div>
                  {hasSmall && (
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('Sell')}/{cUnit}</Label>
                      <Input type="number" min={0} value={r.sellSmall || ''}
                        onChange={(e) => update(r._key, { sellSmall: Math.round(Number(e.target.value) || 0), sellSmallTouched: true })}
                        className="h-8 w-24" placeholder={t('auto')} />
                    </div>
                  )}
                  </div>
                  <div className="flex flex-wrap items-end gap-2 border-s ps-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Expiry Date')}</Label>
                    <Input type="date" value={r.expiry}
                      onChange={(e) => update(r._key, { expiry: e.target.value })}
                      className="h-8 w-40" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t('Batch #')}</Label>
                    <Input value={r.batchNumber} dir="ltr"
                      onChange={(e) => update(r._key, { batchNumber: e.target.value })}
                      className="h-8 w-40" placeholder={t('Optional')} />
                  </div>
                  </div>
                </div>

                {/* Summary line: quantity, margin, line total */}
                {(r.qtyBase > 0 || r.cost > 0) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    {r.qtyBase > 0 && (
                      <span className="text-muted-foreground">
                        {t('Total')}: {formatQuantity(r.qtyBase, pUnit, cUnit, r.cf)}
                      </span>
                    )}
                    {r.cost > 0 && r.sell > 0 && (() => {
                      const marginPct = Math.round(((r.sell - r.cost) / r.cost) * 100);
                      const color = marginPct >= defaultMarkup ? 'text-green-600'
                        : marginPct >= defaultMarkup / 2 ? 'text-yellow-600' : 'text-destructive';
                      return (
                        <span className={color}>
                          {t('Margin')}: {marginPct}% ({formatCurrency(r.sell - r.cost)})
                        </span>
                      );
                    })()}
                    {r.qtyBase > 0 && r.cost > 0 && (
                      <span className="font-medium">
                        {t('Line Total')}: {formatCurrency(Math.round((r.cost * r.qtyBase) / (r.cf > 1 ? r.cf : 1)))}
                      </span>
                    )}
                  </div>
                )}
                {err && <p className="text-xs text-destructive">{err}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <datalist id="qse-categories">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>

      {/* Bottom save bar for long lists */}
      {rows.length > 1 && (
        <div className="flex items-center justify-end gap-3">
          {grandTotal > 0 && (
            <span className="text-sm text-muted-foreground">
              {t('Total')}: <span className="font-medium text-foreground">{formatCurrency(grandTotal)}</span>
            </span>
          )}
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Save All')}
          </Button>
        </div>
      )}
    </div>
  );
}
