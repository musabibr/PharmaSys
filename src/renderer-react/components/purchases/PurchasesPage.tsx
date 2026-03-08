import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { List, PlusCircle, AlertTriangle, Building2 } from 'lucide-react';
import type { Purchase } from '@/api/types';
import { usePermission, useAnyPermission } from '@/hooks/usePermission';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PurchaseListTab } from './PurchaseListTab';
import { CreatePurchaseFlow } from './CreatePurchaseFlow';
import { AgingTab } from './AgingTab';
import { SupplierTab } from './SupplierTab';
import { PurchaseDetailDialog } from './PurchaseDetailDialog';

export default function PurchasesPage() {
  const { t } = useTranslation();
  const canView = useAnyPermission(['purchases.view', 'purchases.manage']);
  const canManage = usePermission('purchases.manage');

  const [tab, setTab] = useState(canManage ? 'list' : 'list');
  const [selectedPurchase, setSelectedPurchase] = useState<Purchase | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [listKey, setListKey] = useState(0);

  const handleSelect = useCallback((purchase: Purchase) => {
    setSelectedPurchase(purchase);
    setDetailOpen(true);
  }, []);

  const handlePaymentMade = useCallback(() => {
    // Refresh the list but keep the detail dialog open
    setListKey(k => k + 1);
  }, []);

  const handlePurchaseComplete = useCallback(() => {
    setListKey(k => k + 1);
    setTab('list');
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
          <TabsTrigger value="suppliers" className="gap-1.5">
            <Building2 className="h-4 w-4" />
            {t('By Supplier')}
          </TabsTrigger>
          <TabsTrigger value="aging" className="gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            {t('Aging')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="flex-1 overflow-hidden" data-tour="purchases-list">
          <PurchaseListTab key={listKey} onSelect={handleSelect} />
        </TabsContent>

        {canManage && (
          <TabsContent value="create" className="flex-1 overflow-hidden">
            <CreatePurchaseFlow onComplete={handlePurchaseComplete} />
          </TabsContent>
        )}

        <TabsContent value="suppliers" className="flex-1 overflow-hidden">
          <SupplierTab />
        </TabsContent>

        <TabsContent value="aging" className="flex-1 overflow-hidden">
          <AgingTab />
        </TabsContent>
      </Tabs>

      <PurchaseDetailDialog
        purchase={selectedPurchase}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onPaymentMade={handlePaymentMade}
      />
    </>
  );
}
