import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShiftStore } from '@/stores/shift.store';
import { useCartStore, type CartItem } from '@/stores/cart.store';
import { api } from '@/api';
import type { Transaction } from '@/api/types';
import { ProductGrid } from './ProductGrid';
import { CartPanel } from './CartPanel';
import { AddToCartModal } from './AddToCartModal';
import { OpenShiftModal } from './OpenShiftModal';
import { CheckoutModal } from './CheckoutModal';
import { ReceiptModal } from './ReceiptModal';
import { HeldSalesSheet } from './HeldSalesSheet';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

export function POSPage() {
  const { t } = useTranslation();
  const currentShift = useShiftStore((s) => s.currentShift);
  const cartStore = useCartStore();

  const [shiftModalOpen, setShiftModalOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [addToCartOpen, setAddToCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [heldSalesOpen, setHeldSalesOpen] = useState(false);
  const [lastTransaction, setLastTransaction] = useState<Transaction | null>(null);
  const [productRefreshKey, setProductRefreshKey] = useState(0);

  const shiftOpen = currentShift != null;

  function handleProductSelect(productId: number) {
    setSelectedProductId(productId);
    setAddToCartOpen(true);
  }

  function handleCheckout() {
    if (!shiftOpen) {
      toast.error(t('You must open a shift before making sales.'));
      return;
    }
    if (cartStore.items.length === 0) return;
    setCheckoutOpen(true);
  }

  function handleCheckoutComplete(transaction: Transaction) {
    setCheckoutOpen(false);
    setLastTransaction(transaction);
    setReceiptOpen(true);
    setProductRefreshKey((k) => k + 1);
  }

  async function handleHold() {
    if (!shiftOpen) {
      toast.error(t('You must open a shift before holding sales.'));
      return;
    }
    if (cartStore.items.length === 0) return;
    try {
      // Spread items into plain objects to avoid IPC serialization issues
      // with reactive Zustand state proxies
      const plainItems = cartStore.items.map(item => ({ ...item }));
      // window.prompt may not work in all Electron sandbox configs,
      // so treat null/failure as "no note" rather than cancelling
      let note: string | undefined;
      try {
        const promptResult = window.prompt(t('Customer note (optional)'));
        if (promptResult === null) return; // user explicitly cancelled
        note = promptResult || undefined;
      } catch {
        // prompt unavailable — proceed without a note
      }
      await api.held.save(plainItems, note);
      cartStore.clear();
      toast.success(t('Sale held successfully'));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to hold sale'));
    }
  }

  function handleRetrieveHeld() {
    setHeldSalesOpen(true);
  }

  function handleRetrieveItems(items: CartItem[]) {
    if (cartStore.items.length > 0) {
      if (!window.confirm(t('Your current cart has items. Retrieving will replace them. Continue?'))) {
        return;
      }
    }
    cartStore.clear();
    items.forEach((item) => cartStore.addItem(item));
    setHeldSalesOpen(false);
  }

  return (
    <div className="flex h-full flex-col">
      {!currentShift && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/50">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="flex-1 text-sm font-medium text-amber-800 dark:text-amber-200">
            {t('No shift is currently open. You must open a shift before making sales.')}
          </p>
          <Button
            size="sm"
            variant="warning"
            onClick={() => setShiftModalOpen(true)}
          >
            {t('Open Shift')}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 pt-3">
        <div data-tour="pos-grid" className="min-h-0 flex-1">
          <ProductGrid onProductSelect={handleProductSelect} refreshKey={productRefreshKey} />
        </div>
        <div data-tour="pos-cart" className="w-[340px] min-h-0 2xl:w-[400px]">
          <CartPanel
            onCheckout={handleCheckout}
            onHold={handleHold}
            onRetrieveHeld={handleRetrieveHeld}
            shiftOpen={shiftOpen}
          />
        </div>
      </div>

      <OpenShiftModal open={shiftModalOpen} onOpenChange={setShiftModalOpen} />
      <AddToCartModal
        productId={selectedProductId}
        open={addToCartOpen}
        onOpenChange={setAddToCartOpen}
      />
      <CheckoutModal
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        onComplete={handleCheckoutComplete}
      />
      <ReceiptModal
        open={receiptOpen}
        onOpenChange={setReceiptOpen}
        transaction={lastTransaction}
      />
      <HeldSalesSheet
        open={heldSalesOpen}
        onOpenChange={setHeldSalesOpen}
        onRetrieve={handleRetrieveItems}
      />
    </div>
  );
}
