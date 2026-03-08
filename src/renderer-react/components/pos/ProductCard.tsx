import { useTranslation } from 'react-i18next';
import { Package, Info } from 'lucide-react';
import type { Product } from '@/api/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatQuantity, formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProductCardProps {
  product: Product;
  onClick: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StockLevel = 'out' | 'low' | 'ok';

function getStockLevel(product: Product): StockLevel {
  const stock = product.total_stock_base ?? 0;
  if (stock === 0) return 'out';
  const lowThreshold = product.min_stock_level * product.conversion_factor;
  if (stock <= lowThreshold) return 'low';
  return 'ok';
}

/** Resolve the effective selling price (already resolved from FIFO batch by backend) */
function getPrice(product: Product, type: 'parent' | 'child'): number | null {
  if (type === 'parent') {
    return product.selling_price || null;
  }
  return product.selling_price_child || null;
}

// ---------------------------------------------------------------------------
// ProductCard
// ---------------------------------------------------------------------------

export function ProductCard({ product, onClick }: ProductCardProps) {
  const { t } = useTranslation();
  const stockLevel = getStockLevel(product);
  const isOutOfStock = stockLevel === 'out';

  const parentPrice = getPrice(product, 'parent');
  const childPrice = product.conversion_factor > 1 ? getPrice(product, 'child') : null;
  const hasUsageInstructions = !!product.usage_instructions;

  return (
    <Card
      role="button"
      tabIndex={isOutOfStock ? -1 : 0}
      aria-disabled={isOutOfStock}
      onClick={isOutOfStock ? undefined : onClick}
      onKeyDown={(e) => {
        if (!isOutOfStock && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group cursor-pointer select-none transition-[transform,box-shadow] duration-150 hover:scale-[0.97] hover:shadow-md',
        isOutOfStock && 'pointer-events-none opacity-50'
      )}
    >
      <CardContent className="p-3">
        {/* Product name + usage info icon */}
        <div className="flex items-start gap-1">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
            {product.name}
          </p>
          {hasUsageInstructions && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-primary focus:outline-none focus:ring-1 focus:ring-ring"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                collisionPadding={16}
                avoidCollisions
                className="max-w-[280px] whitespace-pre-wrap text-xs leading-relaxed"
              >
                <p className="mb-1 font-semibold">{t('Usage Instructions')}</p>
                <p>{product.usage_instructions}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Generic name */}
        {product.generic_name && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {product.generic_name}
          </p>
        )}

        {/* Price row */}
        <div className="mt-2 flex items-baseline gap-2">
          {parentPrice ? (
            <span className="text-sm font-bold tabular-nums text-primary">
              {formatCurrency(parentPrice)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/60">{t('No price')}</span>
          )}
          {childPrice && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {product.child_unit}: {formatCurrency(childPrice)}
            </span>
          )}
        </div>

        {/* Stock row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Package className="h-3 w-3 shrink-0" />
            <span className="truncate tabular-nums">
              {formatQuantity(
                product.total_stock_base ?? 0,
                product.parent_unit,
                product.child_unit,
                product.conversion_factor
              )}
            </span>
          </div>

          {/* Stock badge */}
          {stockLevel === 'out' && (
            <Badge variant="destructive" className="shrink-0 px-1.5 py-0 text-[10px] leading-tight">
              {t('Out of Stock')}
            </Badge>
          )}
          {stockLevel === 'low' && (
            <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10px] leading-tight">
              {t('Low Stock')}
            </Badge>
          )}
          {stockLevel === 'ok' && (
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
