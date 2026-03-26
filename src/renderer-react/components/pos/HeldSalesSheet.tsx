import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { PauseCircle, Play, Trash2, ShoppingCart, Clock } from 'lucide-react';
import type { CartItem } from '@/stores/cart.store';
import type { HeldSale } from '@/api/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HeldSalesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetrieve: (items: CartItem[]) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}

function parseHeldItems(items: unknown): CartItem[] {
  // Backend may send items as already-parsed array or as JSON string
  if (Array.isArray(items)) return items;
  if (typeof items === 'string') {
    try { return JSON.parse(items); } catch { return []; }
  }
  return [];
}

// ---------------------------------------------------------------------------
// HeldSalesSheet
// ---------------------------------------------------------------------------

export function HeldSalesSheet({ open, onOpenChange, onRetrieve }: HeldSalesSheetProps) {
  const { t } = useTranslation();

  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // ---- Fetch held sales when opened ----
  const fetchHeldSales = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.held.getAll();
      setHeldSales(data);
    } catch {
      toast.error(t('Failed to load held sales'));
      setHeldSales([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      fetchHeldSales();
    }
  }, [open, fetchHeldSales]);

  // ---- Retrieve a held sale ----
  async function handleRetrieve(sale: HeldSale) {
    const items = parseHeldItems(sale.items);
    if (items.length === 0) {
      toast.error(t('No items in this held sale'));
      return;
    }
    // Delete from DB so it can't be retrieved again
    try {
      await api.held.delete(sale.id);
    } catch {
      // Non-critical — proceed with retrieval even if delete fails
    }
    onRetrieve(items);
    onOpenChange(false);
    toast.success(t('Sale retrieved'));
  }

  // ---- Delete a held sale ----
  async function handleDelete(id: number) {
    setDeletingId(id);
    try {
      await api.held.delete(id);
      setHeldSales((prev) => prev.filter((s) => s.id !== id));
      toast.success(t('Held sale deleted'));
    } catch {
      toast.error(t('Failed to delete held sale'));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <PauseCircle className="h-5 w-5" />
            {t('Held Sales')}
          </SheetTitle>
          <SheetDescription>
            {t('Parked sales waiting to be retrieved.')}
          </SheetDescription>
        </SheetHeader>

        <Separator className="my-2" />

        {/* ---- Loading state ---- */}
        {loading && (
          <div className="space-y-3 px-1">
            {[1, 2, 3].map((n) => (
              <div key={n} className="space-y-2 rounded-lg border p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        )}

        {/* ---- Empty state ---- */}
        {!loading && heldSales.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <ShoppingCart className="h-12 w-12 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">
              {t('No held sales')}
            </p>
            <p className="text-xs text-muted-foreground/70">
              {t('Parked sales will appear here.')}
            </p>
          </div>
        )}

        {/* ---- Held sales list ---- */}
        {!loading && heldSales.length > 0 && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="space-y-3 px-1 pb-2">
              {heldSales.map((sale) => {
                const items = parseHeldItems(sale.items);
                const itemCount = items.length;
                const isDeleting = deletingId === sale.id;

                return (
                  <div
                    key={sale.id}
                    className="rounded-lg border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30"
                  >
                    {/* ---- Top row: time + badge ---- */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5 shrink-0" />
                        <span>{formatTime(sale.created_at)}</span>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {itemCount} {itemCount === 1 ? t('item') : t('items')}
                      </Badge>
                    </div>

                    {/* ---- Customer note ---- */}
                    {sale.customer_note && (
                      <p className="mt-2 text-sm text-foreground">
                        {sale.customer_note}
                      </p>
                    )}

                    {/* ---- Item preview ---- */}
                    <div className="mt-2 space-y-0.5">
                      {items.slice(0, 3).map((item, idx) => (
                        <p key={idx} className="truncate text-xs text-muted-foreground">
                          {item.quantity}x {item.product_name}
                        </p>
                      ))}
                      {items.length > 3 && (
                        <p className="text-xs text-muted-foreground/70">
                          +{items.length - 3} {t('more')}...
                        </p>
                      )}
                    </div>

                    {/* ---- Total ---- */}
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-sm font-semibold tabular-nums">
                        {formatCurrency(sale.total_amount)}
                      </span>

                      {/* ---- Actions ---- */}
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={isDeleting}
                          onClick={() => handleDelete(sale.id)}
                          className="h-8 px-2"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="sr-only">{t('Delete')}</span>
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleRetrieve(sale)}
                          disabled={isDeleting}
                          className="h-8 gap-1.5"
                        >
                          <Play className="h-3.5 w-3.5" />
                          {t('Retrieve')}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
