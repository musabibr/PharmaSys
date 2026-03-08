import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { Product, Category } from '@/api/types';
import { api } from '@/api';
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
// ---------------------------------------------------------------------------

export function ProductForm({ open, onOpenChange, product, onSaved }: ProductFormProps) {
  const { t } = useTranslation();
  const isEdit = product != null;

  // ── Form state ──────────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [genericName, setGenericName] = useState('');
  const [categoryId, setCategoryId] = useState<string>(NO_CATEGORY);
  const [barcode, setBarcode] = useState('');
  const [usageInstructions, setUsageInstructions] = useState('');
  const [parentUnit, setParentUnit] = useState('Box');
  const [childUnit, setChildUnit] = useState('Strip');
  const [conversionFactor, setConversionFactor] = useState(1);
  const [minStockLevel, setMinStockLevel] = useState(0);

  // ── UI state ────────────────────────────────────────────────────────────
  const [categories, setCategories] = useState<Category[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch categories on mount ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.categories.getAll();
        if (!cancelled) {
          setCategories(Array.isArray(data) ? data : []);
        }
      } catch {
        // Non-critical — select dropdown stays empty
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // ── Populate form when opening in edit mode ─────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (isEdit && product) {
      setName(product.name);
      setGenericName(product.generic_name || '');
      setCategoryId(product.category_id ? String(product.category_id) : NO_CATEGORY);
      setBarcode(product.barcode || '');
      setUsageInstructions(product.usage_instructions || '');
      setParentUnit(product.parent_unit || 'Box');
      setChildUnit(product.child_unit || 'Strip');
      setConversionFactor(product.conversion_factor || 1);
      setMinStockLevel(product.min_stock_level || 0);
    } else {
      // Reset to defaults for create mode
      setName('');
      setGenericName('');
      setCategoryId(NO_CATEGORY);
      setBarcode('');
      setUsageInstructions('');
      setParentUnit('Box');
      setChildUnit('Strip');
      setConversionFactor(1);
      setMinStockLevel(0);
    }
    setError(null);
  }, [open, isEdit, product]);

  // ── Validation ──────────────────────────────────────────────────────────
  function validate(): boolean {
    if (!name.trim()) {
      setError(t('Product name is required'));
      return false;
    }
    if (conversionFactor < 1) {
      setError(t('Conversion factor must be at least 1'));
      return false;
    }
    return true;
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    setError(null);

    const payload: Partial<Product> = {
      name: name.trim(),
      generic_name: genericName.trim() || null,
      category_id: categoryId !== NO_CATEGORY ? Number(categoryId) : (null as unknown as number),
      barcode: barcode.trim() || null,
      usage_instructions: usageInstructions.trim() || null,
      parent_unit: parentUnit.trim() || 'Box',
      child_unit: childUnit.trim() || 'Strip',
      conversion_factor: Math.max(1, Math.floor(conversionFactor)),
      min_stock_level: Math.max(0, Math.floor(minStockLevel)),
    };

    try {
      if (isEdit && product) {
        await api.products.update(product.id, payload);
        toast.success(t('Product updated'));
      } else {
        await api.products.create(payload);
        toast.success(t('Product created'));
      }
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

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('Edit Product') : t('Add New Product')}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t('Update the product details below.')
              : t('Fill in the details to create a new product.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-2">
            {/* ── Name (required) ──────────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-name">
                {t('Name')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('e.g. Amoxicillin 500mg')}
                autoFocus
              />
            </div>

            {/* ── Generic Name (optional) ──────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-generic">{t('Generic Name')}</Label>
              <Input
                id="pf-generic"
                value={genericName}
                onChange={(e) => setGenericName(e.target.value)}
                placeholder={t('e.g. Amoxicillin')}
              />
            </div>

            {/* ── Category (optional) ──────────────────────────────────── */}
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

            {/* ── Barcode (optional) ───────────────────────────────────── */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-barcode">{t('Barcode')}</Label>
              <Input
                id="pf-barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder={t('e.g. 6001234567890')}
              />
            </div>

            {/* ── Usage Instructions (optional) ────────────────────────── */}
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

            {/* ── Unit configuration ───────────────────────────────────── */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pf-parent-unit">{t('Parent Unit')}</Label>
                <Input
                  id="pf-parent-unit"
                  value={parentUnit}
                  onChange={(e) => setParentUnit(e.target.value)}
                  placeholder="Box"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-child-unit">{t('Child Unit')}</Label>
                <Input
                  id="pf-child-unit"
                  value={childUnit}
                  onChange={(e) => setChildUnit(e.target.value)}
                  placeholder="Strip"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-conv-factor">{t('Conversion Factor')}</Label>
                <Input
                  id="pf-conv-factor"
                  type="number"
                  min={1}
                  step={1}
                  value={conversionFactor}
                  onChange={(e) => setConversionFactor(Number(e.target.value))}
                />
              </div>
            </div>

            {/* ── UOM preview ──────────────────────────────────────────── */}
            {conversionFactor > 1 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                1 {parentUnit || t('Parent')} = {conversionFactor} {childUnit || t('Child')}
              </p>
            )}

            {/* ── Min stock level ──────────────────────────────────────── */}
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
                {t('Low stock warning triggers when stock falls below this level (in parent units).')}
              </p>
            </div>

            {/* ── Inline error ─────────────────────────────────────────── */}
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
