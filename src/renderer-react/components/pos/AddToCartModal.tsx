import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Batch, Product } from '@/api/types';
import { useCartStore, type CartItem } from '@/stores/cart.store';
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
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AddToCartModalProps {
  productId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve selling price from a batch, using override-or-fallback logic. */
function getSellingPrice(batch: Batch, unitType: 'parent' | 'child'): number {
  if (unitType === 'parent') {
    return batch.selling_price_parent_override || batch.selling_price_parent || 0;
  }
  return batch.selling_price_child_override || batch.selling_price_child || 0;
}

/** Resolve cost price from a batch. */
function getCostPrice(batch: Batch, unitType: 'parent' | 'child'): number {
  if (unitType === 'parent') {
    return batch.cost_per_parent || 0;
  }
  return batch.cost_per_child_override || batch.cost_per_child || 0;
}

/** Total available stock in base units across all batches. */
function totalAvailableBase(batches: Batch[]): number {
  return batches.reduce((sum, b) => sum + b.quantity_base, 0);
}

// ---------------------------------------------------------------------------
// AddToCartModal
// ---------------------------------------------------------------------------

export function AddToCartModal({ productId, open, onOpenChange }: AddToCartModalProps) {
  const { t } = useTranslation();

  // ── Local state ───────────────────────────────────────────────────────────

  const [product, setProduct] = useState<Product | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);
  const [unitType, setUnitType] = useState<'parent' | 'child'>('parent');
  const [quantity, setQuantity] = useState(1);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const canDiscount = usePermission('pos.discounts');

  // ── Cart store ────────────────────────────────────────────────────────────

  const items = useCartStore((s) => s.items);
  const addItem = useCartStore((s) => s.addItem);

  // ── Fetch product + batches when modal opens ──────────────────────────────

  useEffect(() => {
    if (!open || productId == null) return;

    // Reset form state
    setUnitType('parent');
    setQuantity(1);
    setDiscountPercent(0);
    setError(null);
    setProduct(null);
    setBatches([]);

    setLoading(true);
    Promise.all([
      api.products.getById(productId),
      api.batches.getAvailable(productId),
    ])
      .then(([prod, avail]) => {
        setProduct(prod);
        setBatches(avail);
      })
      .catch(() => {
        toast.error(t('Failed to load product details'));
        onOpenChange(false);
      })
      .finally(() => setLoading(false));
  }, [open, productId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived values ────────────────────────────────────────────────────────

  const conversionFactor = product?.conversion_factor ?? 1;
  const hasChildUnit = conversionFactor > 1;
  const firstBatch = batches[0] ?? null;

  const unitPrice = firstBatch ? getSellingPrice(firstBatch, unitType) : 0;
  const costPrice = firstBatch ? getCostPrice(firstBatch, unitType) : 0;

  const unitLabel = unitType === 'parent'
    ? (product?.parent_unit ?? '')
    : (product?.child_unit ?? '');

  // Available stock in selected unit type
  const totalBase = totalAvailableBase(batches);
  const availableInUnit = unitType === 'parent'
    ? Math.floor(totalBase / conversionFactor)
    : totalBase;

  // Already in cart for this product (in base units)
  const inCartBase = useMemo(() => {
    return items
      .filter((ci) => ci.product_id === productId)
      .reduce((sum, ci) => {
        return sum + (ci.unit_type === 'parent' ? ci.quantity * ci.conversion_factor : ci.quantity);
      }, 0);
  }, [items, productId]);

  const inCartInUnit = unitType === 'parent'
    ? Math.floor(inCartBase / conversionFactor)
    : inCartBase;

  const remainingInUnit = Math.max(0, availableInUnit - inCartInUnit);

  // Line total calculation
  const lineGross = unitPrice * quantity;
  const lineDiscount = Math.floor(lineGross * (discountPercent / 100));
  const lineTotal = lineGross - lineDiscount;

  // ── Submit handler ────────────────────────────────────────────────────────

  function handleSubmit() {
    if (!product || !firstBatch) return;

    setError(null);

    // Validate quantity
    if (quantity < 1 || !Number.isInteger(quantity)) {
      setError(t('Quantity must be at least 1'));
      return;
    }

    // Convert to base units for stock check
    const qtyBase = unitType === 'parent' ? quantity * conversionFactor : quantity;
    const availableBase = totalBase - inCartBase;

    if (qtyBase > availableBase) {
      setError(
        t('Insufficient stock. Available: {{available}}', {
          available: formatQuantity(
            availableBase,
            product.parent_unit,
            product.child_unit,
            conversionFactor
          ),
        })
      );
      return;
    }

    // Check if same product + unit_type already in cart, merge quantities
    const existingIndex = items.findIndex(
      (ci) => ci.product_id === product.id && ci.unit_type === unitType
    );

    if (existingIndex >= 0) {
      const existing = items[existingIndex];
      const newQty = existing.quantity + quantity;
      const newQtyBase = unitType === 'parent' ? newQty * conversionFactor : newQty;

      if (newQtyBase > totalBase) {
        setError(
          t('Insufficient stock. Available: {{available}}', {
            available: formatQuantity(
              totalBase,
              product.parent_unit,
              product.child_unit,
              conversionFactor
            ),
          })
        );
        return;
      }

      // Merge: update quantity (and discount if changed)
      const updateQuantity = useCartStore.getState().updateQuantity;
      const updateDiscount = useCartStore.getState().updateDiscount;
      updateQuantity(existingIndex, newQty);
      if (discountPercent !== existing.discount_percent) {
        updateDiscount(existingIndex, discountPercent);
      }
    } else {
      // Add new item
      const cartItem: CartItem = {
        product_id: product.id,
        product_name: product.name,
        batch_id: firstBatch.id,
        batch_number: firstBatch.batch_number,
        quantity,
        unit_type: unitType,
        unit_price: unitPrice,
        cost_price: costPrice,
        discount_percent: discountPercent,
        conversion_factor: conversionFactor,
        parent_unit: product.parent_unit,
        child_unit: product.child_unit,
      };
      addItem(cartItem);
    }

    toast.success(
      t('Added {{name}} to cart', { name: product.name })
    );
    onOpenChange(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{product?.name ?? t('Add to Cart')}</DialogTitle>
          <DialogDescription>
            {product?.generic_name ?? t('Select unit type and quantity')}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">{t('Loading...')}</p>
          </div>
        ) : !product || batches.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-destructive">
              {t('No available stock for this product')}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Unit type selection */}
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
                    name="unitType"
                    value="parent"
                    checked={unitType === 'parent'}
                    onChange={() => setUnitType('parent')}
                    className="accent-primary"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{product.parent_unit}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(getSellingPrice(firstBatch, 'parent'))}
                    </p>
                  </div>
                </label>

                {/* Child unit option (only if conversion_factor > 1) */}
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
                      name="unitType"
                      value="child"
                      checked={unitType === 'child'}
                      onChange={() => setUnitType('child')}
                      className="accent-primary"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{product.child_unit}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(getSellingPrice(firstBatch, 'child'))}
                      </p>
                    </div>
                  </label>
                )}
              </div>
            </div>

            {/* Available stock */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('Available')}:</span>
              <Badge variant="secondary">
                {remainingInUnit} {unitLabel}
              </Badge>
              {inCartInUnit > 0 && (
                <span className="text-xs text-muted-foreground">
                  ({inCartInUnit} {t('in cart')})
                </span>
              )}
            </div>

            {/* Quantity */}
            <div className="space-y-2">
              <Label htmlFor="add-qty">{t('Quantity')}</Label>
              <Input
                id="add-qty"
                type="number"
                min={1}
                max={remainingInUnit}
                step={1}
                value={quantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setQuantity(Number.isNaN(val) ? 1 : Math.max(1, val));
                }}
              />
            </div>

            {/* Discount — only shown if user has pos.discounts permission */}
            {canDiscount && (
              <div className="space-y-2">
                <Label htmlFor="add-discount">{t('Line Discount %')}</Label>
                <Input
                  id="add-discount"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={discountPercent}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setDiscountPercent(Number.isNaN(val) ? 0 : Math.min(100, Math.max(0, val)));
                  }}
                />
              </div>
            )}

            {/* Line total preview */}
            <div className="rounded-lg bg-muted/50 px-4 py-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {quantity} &times; {formatCurrency(unitPrice)}
                </span>
                <span className="tabular-nums">{formatCurrency(lineGross)}</span>
              </div>
              {discountPercent > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('Discount')} ({discountPercent}%)
                  </span>
                  <span className="tabular-nums text-destructive">
                    -{formatCurrency(lineDiscount)}
                  </span>
                </div>
              )}
              <div className="mt-1 flex justify-between border-t pt-1">
                <span className="font-semibold">{t('Total')}</span>
                <span className="font-bold tabular-nums">{formatCurrency(lineTotal)}</span>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <p className="text-sm font-medium text-destructive">{error}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading || !product || batches.length === 0}
          >
            {t('Add to Cart')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
