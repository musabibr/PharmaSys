import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { List, PlusCircle, AlertTriangle, Building2, Users, PenLine, Archive, ClipboardList, PackageSearch, Loader2, FileText, PackageCheck } from 'lucide-react';
import { api } from '@/api';
import type { Purchase } from '@/api/types';
import { usePermission, useAnyPermission } from '@/hooks/usePermission';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PurchaseListTab } from './PurchaseListTab';
import { CreatePurchaseFlow } from './CreatePurchaseFlow';
import { AgingTab } from './AgingTab';
import { SupplierTab } from './SupplierTab';
import { PurchaseDetailDialog } from './PurchaseDetailDialog';
import { SupplierManagementTab } from './SupplierManagementTab';
import { InvoiceManagerTab } from './InvoiceManagerTab';
import { PurchaseOrdersTab, type ReceiveOrder } from './PurchaseOrdersTab';
import type { ReorderPrefill } from './ProductPurchasesTab';

// Charts make this tab heavy; load it only when opened.
const ProductPurchasesTab = lazy(() => import('./ProductPurchasesTab').then(m => ({ default: m.ProductPurchasesTab })));

export default function PurchasesPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const canView = useAnyPermission(['purchases.view', 'purchases.manage']);
  const canManage = usePermission('purchases.manage');
  const canManageSuppliers = usePermission('purchases.suppliers.manage');
  const canLookUp = usePermission('purchases.view');

  // Read initial tab + optional re-order pre-fill from route state
  // (e.g., navigate('/purchases', { state: { tab: 'manual', initialSupplierId, initialProductId } }))
  const routeState = location.state as {
    tab?: string;
    initialSupplierId?: number;
    initialProductId?: number;
    /** Product to open in the "By product" tab. */
    productId?: number;
  } | null;
  const stateTab = routeState?.tab;
  const [tab, setTab] = useState(stateTab || 'list');
  // Capture the pre-fill values once so subsequent tab switches don't keep re-injecting them
  const [reorderPrefill, setReorderPrefill] = useState<{ supplierId?: number; productId?: number; cost?: number; sellPrice?: number } | null>(
    routeState?.initialSupplierId || routeState?.initialProductId
      ? { supplierId: routeState.initialSupplierId, productId: routeState.initialProductId }
      : null
  );
  // Remounts the manual flow when a new pre-fill arrives from "By product".
  const [prefillKey, setPrefillKey] = useState(0);
  const [lookupProductId, setLookupProductId] = useState<number | null>(routeState?.productId ?? null);
  const [selectedPurchase, setSelectedPurchase] = useState<Purchase | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [listKey, setListKey] = useState(0);
  const [agingKey, setAgingKey] = useState(0);
  /** The order an invoice is being received against, while that tab is open. */
  const [orderReceipt, setOrderReceipt] = useState<Parameters<ReceiveOrder>[0] | null>(null);

  // When navigating back with a different state.tab, update the active tab
  useEffect(() => {
    if (stateTab) setTab(stateTab);
    if (routeState?.productId) setLookupProductId(routeState.productId);
  }, [stateTab, routeState?.productId]);

  const openInvoiceById = useCallback(async (purchaseId: number) => {
    try {
      setSelectedPurchase(await api.purchases.getById(purchaseId));
      setDetailOpen(true);
    } catch {
      // The invoice may have been deleted meanwhile; the list will show that on refresh.
    }
  }, []);

  const handleReorder = useCallback((prefill: ReorderPrefill) => {
    setReorderPrefill(prefill);
    setPrefillKey(k => k + 1);
    setTab('manual');
  }, []);

  const handleSelect = useCallback((purchase: Purchase) => {
    setSelectedPurchase(purchase);
    setDetailOpen(true);
  }, []);

  const handlePaymentMade = useCallback(() => {
    // Refresh both lists
    setListKey(k => k + 1);
    setAgingKey(k => k + 1);
  }, []);

  const handlePurchaseComplete = useCallback(() => {
    setListKey(k => k + 1);
    setTab('list');
  }, []);

  const handleReceiveOrder = useCallback<ReceiveOrder>((prefill) => {
    setOrderReceipt(prefill);
    setTab('receive-order');
  }, []);

  const handleOrderReceiptDone = useCallback(() => {
    setOrderReceipt(null);
    setListKey(k => k + 1);
    setTab('orders');
  }, []);

  const handleDeleted = useCallback(() => {
    setDetailOpen(false);
    setSelectedPurchase(null);
    setListKey(k => k + 1);
    setAgingKey(k => k + 1);
  }, []);

  // Called from AgingTab when user clicks Pay on a row
  const handleAgingPay = useCallback(async (purchaseId: number) => {
    try {
      const purchase = await api.purchases.getById(purchaseId);
      setSelectedPurchase(purchase);
      setDetailOpen(true);
    } catch {
      // If fetch fails, still try to open with minimal info
    }
  }, []);

  if (!canView) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t('You do not have permission to view purchases')}
      </div>
    );
  }

  return (
    <>
      <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
        <TabsList className="mx-4 mt-2 h-auto max-w-[calc(100%-2rem)] flex-wrap justify-start gap-1 self-start">
          <TabsTrigger value="list" className="gap-1.5">
            <List className="h-4 w-4" />
            {t('Purchases')}
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="create" className="gap-1.5" data-tour="purchases-add">
              <PlusCircle className="h-4 w-4" />
              {t('New Purchase')}
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger value="manual" className="gap-1.5">
              <PenLine className="h-4 w-4" />
              {t('Manual Invoice')}
            </TabsTrigger>
          )}
          {canLookUp && (
            <TabsTrigger value="by-product" className="gap-1.5">
              <PackageSearch className="h-4 w-4" />
              {t('By product')}
            </TabsTrigger>
          )}
          <TabsTrigger value="suppliers" className="gap-1.5">
            <Building2 className="h-4 w-4" />
            {t('Manage Purchases')}
          </TabsTrigger>
          <TabsTrigger value="aging" className="gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            {t('Aging')}
          </TabsTrigger>
          <TabsTrigger value="orders" className="gap-1.5">
            <FileText className="h-4 w-4" />
            {t('Orders')}
          </TabsTrigger>
          {canManage && orderReceipt && (
            <TabsTrigger value="receive-order" className="gap-1.5">
              <PackageCheck className="h-4 w-4" />
              {t('Receive {{number}}', { number: orderReceipt.po_number })}
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger value="manage" className="gap-1.5">
              <ClipboardList className="h-4 w-4" />
              {t('Manage Invoices')}
            </TabsTrigger>
          )}
          <TabsTrigger value="archive" className="gap-1.5">
            <Archive className="h-4 w-4" />
            {t('Archive')}
          </TabsTrigger>
          {canManageSuppliers && (
            <TabsTrigger value="manage-suppliers" className="gap-1.5">
              <Users className="h-4 w-4" />
              {t('Manage Suppliers')}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="list" className="flex-1 overflow-hidden" data-tour="purchases-list">
          <PurchaseListTab key={listKey} onSelect={handleSelect} excludePaid />
        </TabsContent>

        {canManage && (
          <TabsContent value="create" className="flex-1 overflow-hidden">
            <CreatePurchaseFlow onComplete={handlePurchaseComplete} />
          </TabsContent>
        )}

        {canManage && (
          <TabsContent value="manual" className="flex-1 overflow-hidden">
            <CreatePurchaseFlow
              key={prefillKey}
              onComplete={handlePurchaseComplete}
              startManual
              initialSupplierId={reorderPrefill?.supplierId}
              initialProductId={reorderPrefill?.productId}
              initialCost={reorderPrefill?.cost}
              initialSellPrice={reorderPrefill?.sellPrice}
            />
          </TabsContent>
        )}

        {canLookUp && (
          <TabsContent value="by-product" className="flex-1 overflow-hidden">
            {tab === 'by-product' && (
              <Suspense fallback={<div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
                <ProductPurchasesTab
                  initialProductId={lookupProductId}
                  onOpenInvoice={openInvoiceById}
                  onReorder={canManage ? handleReorder : undefined}
                />
              </Suspense>
            )}
          </TabsContent>
        )}

        <TabsContent value="suppliers" className="flex-1 overflow-hidden">
          <SupplierTab />
        </TabsContent>

        <TabsContent value="aging" className="flex-1 overflow-hidden">
          <AgingTab key={agingKey} onPayAction={handleAgingPay} />
        </TabsContent>

        <TabsContent value="orders" className="flex-1 overflow-hidden">
          {tab === 'orders' && <PurchaseOrdersTab onReceive={canManage ? handleReceiveOrder : undefined} onOpenInvoice={openInvoiceById} />}
        </TabsContent>

        {canManage && orderReceipt && (
          <TabsContent value="receive-order" className="flex-1 overflow-hidden">
            <CreatePurchaseFlow
              key={`order-${orderReceipt.purchase_order_id}`}
              onComplete={handleOrderReceiptDone}
              startManual
              purchaseOrder={{
                id: orderReceipt.purchase_order_id,
                po_number: orderReceipt.po_number,
                supplier_id: orderReceipt.supplier_id,
                supplier_name: orderReceipt.supplier_name,
                items: orderReceipt.items,
              }}
            />
          </TabsContent>
        )}

        {canManage && (
          <TabsContent value="manage" className="flex-1 min-h-0 overflow-hidden data-[state=active]:flex flex-col">
            <InvoiceManagerTab onRefreshList={handlePaymentMade} />
          </TabsContent>
        )}

        <TabsContent value="archive" className="flex-1 overflow-hidden">
          <PurchaseListTab key={listKey} onSelect={handleSelect} initialStatus="paid" hideStatusFilter />
        </TabsContent>

        {canManageSuppliers && (
          <TabsContent value="manage-suppliers" className="flex-1 overflow-hidden">
            <SupplierManagementTab />
          </TabsContent>
        )}
      </Tabs>

      <PurchaseDetailDialog
        purchase={selectedPurchase}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onPaymentMade={handlePaymentMade}
        onDeleted={handleDeleted}
      />
    </>
  );
}
