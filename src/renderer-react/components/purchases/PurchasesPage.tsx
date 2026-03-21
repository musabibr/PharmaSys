import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { List, PlusCircle, AlertTriangle, Building2, Users, PenLine, Archive, ClipboardList } from 'lucide-react';
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

export default function PurchasesPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const canView = useAnyPermission(['purchases.view', 'purchases.manage']);
  const canManage = usePermission('purchases.manage');
  const canManageSuppliers = usePermission('purchases.suppliers.manage');

  // Read initial tab from route state (e.g., navigate('/purchases', { state: { tab: 'aging' } }))
  const stateTab = (location.state as { tab?: string } | null)?.tab;
  const [tab, setTab] = useState(stateTab || 'list');
  const [selectedPurchase, setSelectedPurchase] = useState<Purchase | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [listKey, setListKey] = useState(0);
  const [agingKey, setAgingKey] = useState(0);

  // When navigating back with a different state.tab, update the active tab
  useEffect(() => {
    if (stateTab) setTab(stateTab);
  }, [stateTab]);

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
        <TabsList className="mx-4 mt-2 w-fit">
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
          <TabsTrigger value="suppliers" className="gap-1.5">
            <Building2 className="h-4 w-4" />
            {t('Manage Purchases')}
          </TabsTrigger>
          <TabsTrigger value="aging" className="gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            {t('Aging')}
          </TabsTrigger>
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
            <CreatePurchaseFlow onComplete={handlePurchaseComplete} startManual />
          </TabsContent>
        )}

        <TabsContent value="suppliers" className="flex-1 overflow-hidden">
          <SupplierTab />
        </TabsContent>

        <TabsContent value="aging" className="flex-1 overflow-hidden">
          <AgingTab key={agingKey} onPayAction={handleAgingPay} />
        </TabsContent>

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
