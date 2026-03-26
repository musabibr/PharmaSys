import { useTranslation } from 'react-i18next';
import { Minus, Plus, ShoppingCart, Trash2, X } from 'lucide-react';
import { useCartStore } from '@/stores/cart.store';
import { usePermission } from '@/hooks/usePermission';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CartPanelProps {
  onCheckout: () => void;
  onHold: () => void;
  onRetrieveHeld: () => void;
  shiftOpen: boolean;
}

// ---------------------------------------------------------------------------
// CartPanel
// ---------------------------------------------------------------------------

export function CartPanel({ onCheckout, onHold, onRetrieveHeld, shiftOpen }: CartPanelProps) {
  const { t } = useTranslation();
  const canHeld = usePermission('pos.held_sales');

  const items = useCartStore((s) => s.items);
  const removeItem = useCartStore((s) => s.removeItem);
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const clear = useCartStore((s) => s.clear);
  const getSubtotal = useCartStore((s) => s.getSubtotal);
  const getDiscountTotal = useCartStore((s) => s.getDiscountTotal);
  const getTotal = useCartStore((s) => s.getTotal);
  const getItemCount = useCartStore((s) => s.getItemCount);

  const subtotal = getSubtotal();
  const discountTotal = getDiscountTotal();
  const total = getTotal();
  const itemCount = getItemCount();
  const isEmpty = itemCount === 0;

  // ── Clear cart with confirmation ──────────────────────────────────────────

  function handleClear() {
    if (isEmpty) return;
    const confirmed = window.confirm(t('Are you sure you want to clear the cart?'));
    if (confirmed) clear();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card text-card-foreground shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-5 w-5" />
          <h2 className="text-base font-semibold">{t('Cart')}</h2>
          {itemCount > 0 && (
            <Badge variant="secondary" className="text-xs">
              {itemCount}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={isEmpty}
          onClick={handleClear}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="me-1.5 h-3.5 w-3.5" />
          {t('Clear')}
        </Button>
      </div>

      {/* Items list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <ShoppingCart className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">{t('Cart is empty')}</p>
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item, index) => {
              const unitLabel = item.unit_type === 'parent' ? item.parent_unit : item.child_unit;
              const lineGross = item.unit_price * item.quantity;
              const lineDiscount = Math.floor(lineGross * (item.discount_percent / 100));
              const lineTotal = lineGross - lineDiscount;

              return (
                <div key={`${item.product_id}-${item.unit_type}-${index}`} className="px-4 py-3">
                  {/* Top row: name + line total */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-tight">
                        {item.product_name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.quantity} &times; {formatCurrency(item.unit_price)}/{unitLabel}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.discount_percent > 0 && (
                        <Badge variant="warning" className="text-[10px]">
                          -{item.discount_percent}%
                        </Badge>
                      )}
                      <span className="text-sm font-semibold tabular-nums">
                        {formatCurrency(lineTotal)}
                      </span>
                    </div>
                  </div>

                  {/* Bottom row: quantity controls + remove */}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          if (item.quantity <= 1) {
                            removeItem(index);
                          } else {
                            updateQuantity(index, item.quantity - 1);
                          }
                        }}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="w-8 text-center text-sm tabular-nums">
                        {item.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => updateQuantity(index, item.quantity + 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => removeItem(index)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Summary + action buttons */}
      <div className="border-t">
        {/* Summary */}
        <div data-tour="pos-cart-total" className="space-y-1.5 px-4 py-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Subtotal')}</span>
            <span className="tabular-nums">{formatCurrency(subtotal)}</span>
          </div>
          {discountTotal > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('Total Discount')}</span>
              <span className="tabular-nums text-destructive">
                -{formatCurrency(discountTotal)}
              </span>
            </div>
          )}
          <Separator />
          <div className="flex justify-between">
            <span className="text-base font-bold">{t('Total')}</span>
            <span className="text-lg font-bold tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="space-y-2 border-t px-4 py-3">
          {canHeld && (
            <div className="flex gap-2">
              <Button
                data-tour="pos-hold"
                variant="outline"
                className="flex-1"
                disabled={isEmpty || !shiftOpen}
                onClick={onHold}
              >
                {t('Hold Sale')}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={onRetrieveHeld}
              >
                {t('Retrieve Held')}
              </Button>
            </div>
          )}
          <Button
            data-tour="pos-checkout"
            className="w-full"
            size="lg"
            disabled={isEmpty || !shiftOpen}
            onClick={onCheckout}
          >
            {t('Pay')}
          </Button>
        </div>
      </div>
    </div>
  );
}
