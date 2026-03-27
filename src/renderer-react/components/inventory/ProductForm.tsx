import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Package, X } from 'lucide-react';
import type { Product, Category } from '@/api/types';
import { api, throwIfError } from '@/api';
import { formatCurrency } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { useSettingsStore } from '@/stores/settings.store';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_CATEGORY = '__none__';

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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProductFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null; // null = create mode
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// ProductForm — create / edit product dialog
// Product-level fields only. Pricing is managed per-batch in BatchForm.
// ---------------------------------------------------------------------------

export function ProductForm({ open, onOpenChange, product, onSaved }: ProductFormProps) {
  const { t } = useTranslation();
  const isEdit = product != null;
  const canViewCosts = usePermission('inventory.view_costs');
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  // ── Product form state ────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [genericName, setGenericName] = useState('');
  const [categoryId, setCategoryId] = useState<string>(NO_CATEGORY);
  const [barcode, setBarcode] = useState('');
  const [usageInstructions, setUsageInstructions] = useState('');
  const [parentUnit, setParentUnit] = useState('Box');
  const [childUnit, setChildUnit] = useState('');
  const [conversionFactor, setConversionFactor] = useState(1);
  const [minStockLevel, setMinStockLevel] = useState(0);

  // ── Initial stock section state (create mode only) ─────────────────────
  const [addStock, setAddStock] = useState(false);
  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [stockQty, setStockQty] = useState(1);
  const [costPerParent, setCostPerParent] = useState(0);
  const [sellPriceParent, setSellPriceParent] = useState(0);
  const [costPerChild, setCostPerChild] = useState(0);
  const [sellPriceChild, setSellPriceChild] = useState(0);

  // Track manual edits to prevent auto-calc from overwriting user input
  const [sellParentTouched, setSellParentTouched] = useState(false);
  const [costChildTouched, setCostChildTouched] = useState(false);
  const [sellChildTouched, setSellChildTouched] = useState(false);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [categories, setCategories] = useState<Category[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChildUnit = !!childUnit.trim() && conversionFactor > 1;

  // ── Fetch categories when dialog opens ───────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.categories.getAll();
        if (!cancelled) setCategories(Array.isArray(data) ? data : []);
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // ── Populate form AFTER categories are loaded (fixes Radix Select blank) ─
  useEffect(() => {
    if (!open) return;
    if (isEdit && product) {
      setName(product.name);
      setGenericName(product.generic_name || '');
      setCategoryId(product.category_id ? String(product.category_id) : NO_CATEGORY);
      setBarcode(product.barcode || '');
      setUsageInstructions(product.usage_instructions || '');
      setParentUnit(product.parent_unit || 'Box');
      setChildUnit(product.child_unit || '');
      setConversionFactor(product.conversion_factor || 1);
      setMinStockLevel(product.min_stock_level || 0);
    } else {
      setName('');
      setGenericName('');
      setCategoryId(NO_CATEGORY);
      setBarcode('');
      setUsageInstructions('');
      setParentUnit('Box');
      setChildUnit('');
      setConversionFactor(1);
      setMinStockLevel(0);
    }
    // Reset stock section
    setAddStock(false);
    setBatchNumber(generateBatchNumber());
    setExpiryDate('');
    setStockQty(1);
    setCostPerParent(0);
    setSellPriceParent(0);
    setCostPerChild(0);
    setSellPriceChild(0);
    setSellParentTouched(false);
    setCostChildTouched(false);
    setSellChildTouched(false);
    setError(null);
  }, [open, isEdit, product, categories]);

  // ── Auto-calc: sell price parent from cost ────────────────────────────────
  useEffect(() => {
    if (!sellParentTouched && costPerParent > 0) {
      setSellPriceParent(Math.round(costPerParent * (1 + defaultMarkup / 100)));
    }
  }, [costPerParent, sellParentTouched, defaultMarkup]);

  // ── Auto-calc: cost per child from cost parent ────────────────────────────
  useEffect(() => {
    if (!costChildTouched && hasChildUnit && costPerParent > 0) {
      setCostPerChild(Math.floor(costPerParent / conversionFactor));
    }
  }, [costPerParent, hasChildUnit, conversionFactor, costChildTouched]);

  // ── Auto-calc: sell price child from sell price parent ───────────────────
  useEffect(() => {
    if (!sellChildTouched && hasChildUnit && sellPriceParent > 0) {
      setSellPriceChild(Math.floor(sellPriceParent / conversionFactor));
    }
  }, [sellPriceParent, hasChildUnit, conversionFactor, sellChildTouched]);

  // ── Margin preview ────────────────────────────────────────────────────────
  const margin = useMemo(() => {
    if (sellPriceParent <= 0 || costPerParent <= 0) return { percent: 0, profit: 0 };
    const profit = sellPriceParent - costPerParent;
    return { percent: Math.round((profit / costPerParent) * 100), profit };
  }, [costPerParent, sellPriceParent]);

  const marginColor =
    margin.percent >= defaultMarkup
      ? 'text-green-600'
      : margin.percent >= defaultMarkup / 2
        ? 'text-yellow-600'
        : 'text-destructive';

  // ── Validation ────────────────────────────────────────────────────────────
  function validate(): boolean {
    if (!name.trim()) {
      setError(t('Product name is required'));
      return false;
    }
    if (conversionFactor < 1) {
      setError(t('Conversion factor must be at least 1'));
      return false;
    }
    if (addStock && !isEdit) {
      if (!expiryDate) {
        setError(t('Expiry date is required when adding stock'));
        return false;
      }
      if (stockQty < 1) {
        setError(t('Quantity must be at least 1'));
        return false;
      }
      if (costPerParent <= 0) {
        setError(t('Cost per base unit is required when adding stock'));
        return false;
      }
    }
    return true;
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    setError(null);

    const effectiveConvFactor = childUnit.trim() ? Math.max(1, Math.floor(conversionFactor)) : 1;

    const productPayload: Partial<Product> = {
      name: name.trim(),
      generic_name: genericName.trim() || null,
      category_id: categoryId !== NO_CATEGORY ? Number(categoryId) : (null as unknown as number),
      barcode: barcode.trim() || null,
      usage_instructions: usageInstructions.trim() || null,
      parent_unit: parentUnit.trim() || 'Box',
      child_unit: childUnit.trim() || '',
      conversion_factor: effectiveConvFactor,
      min_stock_level: Math.max(0, Math.floor(minStockLevel)),
    };

    try {
      let savedProduct: Product;

      if (isEdit && product) {
        savedProduct = throwIfError(await api.products.update(product.id, productPayload));
        toast.success(t('Product updated'));
      } else {
        savedProduct = throwIfError(await api.products.create(productPayload));
        toast.success(t('Product created'));
      }

      // Create initial batch (create mode only)
      if (!isEdit && addStock && savedProduct?.id) {
        const productId = savedProduct.id;
        const cf = effectiveConvFactor;

        const batchPayload: Record<string, unknown> = {
          product_id: productId,
          batch_number: batchNumber.trim() || null,
          expiry_date: expiryDate,
          quantity_base: stockQty * cf,
          cost_per_parent: costPerParent,
          selling_price_parent: sellPriceParent || Math.round(costPerParent * (1 + defaultMarkup / 100)),
        };

        if (hasChildUnit) {
          batchPayload.cost_per_child_override = costPerChild || Math.floor(costPerParent / cf);
          batchPayload.selling_price_child_override =
            sellPriceChild || Math.floor((sellPriceParent || Math.round(costPerParent * (1 + defaultMarkup / 100))) / cf);
        }

        try {
          throwIfError(await api.batches.create(batchPayload as Parameters<typeof api.batches.create>[0]));
          toast.success(t('Stock batch added'));
        } catch (batchErr: unknown) {
          toast.warning(
            t('Product saved but batch failed: {{msg}}', {
              msg: batchErr instanceof Error ? batchErr.message : t('Unknown error'),
            })
          );
        }
      }

      // Signal other components (e.g. POS ProductGrid) to refresh
      window.dispatchEvent(new Event('pharmasys:products-changed'));
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : t(isEdit ? 'Failed to update product' : 'Failed to create product')
      );
    } finally {
      setSaving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('Edit Product') : t('Add New Product')}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t('Update the product details below. Manage pricing in the Batches tab.')
              : t('Fill in the details to create a new product.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-2">

            {/* ── Name (required) ───────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-name">
                {t('Name')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('e.g. Amoxicillin 500mg')}
                maxLength={60}
                autoFocus
              />
            </div>

            {/* ── Generic Name ─────────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-generic">{t('Generic Name')}</Label>
              <Input
                id="pf-generic"
                value={genericName}
                onChange={(e) => setGenericName(e.target.value)}
                placeholder={t('e.g. Amoxicillin')}
                maxLength={60}
              />
            </div>

            {/* ── Category ─────────────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label>{t('Category')}</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('Select category')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>{t('No Category')}</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={String(cat.id)}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* ── Barcode ───────────────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-barcode">{t('Barcode')}</Label>
              <Input
                id="pf-barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                placeholder={t('e.g. 6001234567890')}
              />
            </div>

            {/* ── Usage Instructions ────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-usage">{t('Usage Instructions')}</Label>
              <textarea
                id="pf-usage"
                value={usageInstructions}
                onChange={(e) => setUsageInstructions(e.target.value)}
                placeholder={t('e.g. Take 1 capsule 3 times daily after meals')}
                rows={2}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <Separator />

            {/* ── Unit configuration ────────────────────────────────────── */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pf-parent-unit">{t('Base Unit')}</Label>
                <Input
                  id="pf-parent-unit"
                  value={parentUnit}
                  onChange={(e) => setParentUnit(e.target.value)}
                  placeholder="Box"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-child-unit">{t('Small Unit')}</Label>
                <div className="relative">
                  <Input
                    id="pf-child-unit"
                    value={childUnit}
                    onChange={(e) => setChildUnit(e.target.value)}
                    placeholder={t('Optional')}
                    className={childUnit ? 'pr-8' : ''}
                  />
                  {childUnit && (
                    <button
                      type="button"
                      onClick={() => { setChildUnit(''); setConversionFactor(1); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      title={t('Clear small unit')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-conv-factor">{t('Conversion Factor')}</Label>
                <Input
                  id="pf-conv-factor"
                  type="number"
                  min={1}
                  step={1}
                  value={childUnit ? conversionFactor : ''}
                  onChange={(e) => setConversionFactor(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                  disabled={!childUnit}
                />
              </div>
            </div>

            {/* ── UOM preview ───────────────────────────────────────────── */}
            {childUnit && conversionFactor > 1 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                1 {parentUnit || t('Base Unit')} = {conversionFactor} {childUnit || t('Small Unit')}
              </p>
            )}

            {/* ── CF cascade notice (edit mode) ─────────────────────────── */}
            {isEdit && product && conversionFactor !== (product.conversion_factor || 1) && conversionFactor > 1 && (
              <p className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {t('Changing conversion factor will recalculate all batch child prices automatically.')}
              </p>
            )}

            {/* ── Min stock level ───────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-min-stock">{t('Min Stock Level')}</Label>
              <Input
                id="pf-min-stock"
                type="number"
                min={0}
                step={1}
                value={minStockLevel}
                onChange={(e) => setMinStockLevel(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {t('Low stock warning triggers when stock falls below this level (in base units).')}
              </p>
            </div>

            <Separator />

            {/* ── Add Initial Stock toggle (create mode only) ────────────── */}
            {!isEdit && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {t('Add Initial Stock')}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={addStock}
                  onClick={() => setAddStock(!addStock)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    addStock ? 'bg-primary' : 'bg-input'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                      addStock ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            )}

            {/* ── Stock fields (create mode only, shown when toggle is ON) */}
            {!isEdit && addStock && (
              <div className="space-y-4 rounded-lg border border-dashed p-4">

                {/* Batch number */}
                <div className="space-y-1.5">
                  <Label htmlFor="pf-batch-no">{t('Batch Number')}</Label>
                  <Input
                    id="pf-batch-no"
                    value={batchNumber}
                    onChange={(e) => setBatchNumber(e.target.value)}
                    placeholder={t('Optional — auto-generated if blank')}
                  />
                </div>

                {/* Expiry date */}
                <div className="space-y-1.5">
                  <Label htmlFor="pf-expiry">
                    {t('Expiry Date')} <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="pf-expiry"
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </div>

                {/* Quantity */}
                <div className="space-y-1.5">
                  <Label htmlFor="pf-qty">
                    {t('Quantity')} ({parentUnit || t('Base Unit')}) <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="pf-qty"
                    type="number"
                    min={1}
                    step={1}
                    value={stockQty}
                    onChange={(e) => setStockQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  />
                </div>

                {canViewCosts && (
                  <>
                    <Separator />

                    {/* Cost per parent */}
                    <div className="space-y-1.5">
                      <Label htmlFor="pf-cost">
                        {t('Cost (Base Unit)')} (SDG) <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="pf-cost"
                        type="number"
                        min={0}
                        step={1}
                        value={costPerParent || ''}
                        onChange={(e) => setCostPerParent(Math.max(0, parseInt(e.target.value, 10) || 0))}
                        placeholder="0"
                      />
                    </div>

                    {/* Selling price per parent + markup */}
                    <div className="space-y-1.5">
                      <Label htmlFor="pf-sell">
                        {t('Selling Price (Base Unit)')} (SDG)
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="pf-sell"
                          type="number"
                          min={0}
                          step={1}
                          value={sellPriceParent || ''}
                          onChange={(e) => {
                            setSellParentTouched(true);
                            setSellPriceParent(Math.max(0, parseInt(e.target.value, 10) || 0));
                          }}
                          placeholder={costPerParent > 0
                            ? String(Math.round(costPerParent * (1 + defaultMarkup / 100)))
                            : '0'}
                          className="flex-1"
                        />
                        <div className="w-20 shrink-0">
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={costPerParent > 0 ? Math.round(((sellPriceParent - costPerParent) / costPerParent) * 100) : ''}
                            onChange={(e) => {
                              const pct = parseInt(e.target.value, 10) || 0;
                              setSellParentTouched(true);
                              setSellPriceParent(Math.round(costPerParent * (1 + pct / 100)));
                            }}
                            placeholder="%"
                            disabled={costPerParent <= 0}
                            title={t('Markup %')}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Child unit prices — only shown when product has a child unit */}
                    {hasChildUnit && (
                      <>
                        <Separator />
                        <p className="text-xs text-muted-foreground">
                          {t('Small unit prices')} (1 {parentUnit} = {conversionFactor} {childUnit})
                        </p>

                        {/* Cost per child */}
                        <div className="space-y-1.5">
                          <Label htmlFor="pf-cost-child">
                            {t('Cost (Small Unit)')} (SDG)
                          </Label>
                          <Input
                            id="pf-cost-child"
                            type="number"
                            min={0}
                            step={1}
                            value={costPerChild || ''}
                            onChange={(e) => {
                              setCostChildTouched(true);
                              setCostPerChild(Math.max(0, parseInt(e.target.value, 10) || 0));
                            }}
                            placeholder={costPerParent > 0
                              ? String(Math.floor(costPerParent / conversionFactor))
                              : '0'}
                          />
                        </div>

                        {/* Selling price per child */}
                        <div className="space-y-1.5">
                          <Label htmlFor="pf-sell-child">
                            {t('Selling Price (Small Unit)')} (SDG)
                          </Label>
                          <Input
                            id="pf-sell-child"
                            type="number"
                            min={0}
                            step={1}
                            value={sellPriceChild || ''}
                            onChange={(e) => {
                              setSellChildTouched(true);
                              setSellPriceChild(Math.max(0, parseInt(e.target.value, 10) || 0));
                            }}
                            placeholder={sellPriceParent > 0
                              ? String(Math.floor(sellPriceParent / conversionFactor))
                              : '0'}
                          />
                        </div>
                      </>
                    )}

                    {/* Margin preview */}
                    {costPerParent > 0 && (
                      <>
                        <Separator />
                        <div className="rounded-lg bg-muted/50 px-4 py-3">
                          <p className={`text-sm font-semibold ${marginColor}`}>
                            {t('Margin')}: {margin.percent}% (
                            {formatCurrency(margin.profit)} {t('profit per')} {parentUnit || t('unit')})
                          </p>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Inline error ──────────────────────────────────────────── */}
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {isEdit ? t('Save Changes') : t('Create Product')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
