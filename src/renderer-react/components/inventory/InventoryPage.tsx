import { useTranslation } from 'react-i18next';
import {
  Package,
  Layers,
  AlertTriangle,
  Calculator,
  TrendingUp,
  Skull,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ProductsTab } from './ProductsTab';
import { BatchesTab } from './BatchesTab';
import { ExpiryTab } from './ExpiryTab';
import { ValuationTab } from './ValuationTab';
import { ReorderTab } from './ReorderTab';
import { DeadCapitalTab } from './DeadCapitalTab';
import { useAnyPermission, usePermission } from '@/hooks/usePermission';

// ---------------------------------------------------------------------------
// InventoryPage — tab container for all inventory sub-views
// ---------------------------------------------------------------------------

export function InventoryPage() {
  const { t } = useTranslation();

  const canViewProducts   = usePermission('inventory.products.view');
  const canViewBatches    = usePermission('inventory.batches.view');
  const canViewExpiry     = useAnyPermission(['inventory.batches.view', 'inventory.expiry_alerts']);
  const canViewValuation  = usePermission('inventory.valuation');
  const canViewReorder    = useAnyPermission(['inventory.reorder', 'inventory.low_stock']);
  const canViewDeadCap    = usePermission('inventory.dead_capital');

  // Determine default tab: first visible tab
  const defaultTab =
    canViewProducts  ? 'products' :
    canViewBatches   ? 'batches' :
    canViewExpiry    ? 'expiry' :
    canViewValuation ? 'valuation' :
    canViewReorder   ? 'reorder' :
    canViewDeadCap   ? 'dead-capital' :
    'products';

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue={defaultTab} className="flex h-full flex-col">
        <TabsList data-tour="inv-tabs" className="w-full justify-start">
          {canViewProducts && (
            <TabsTrigger value="products" className="gap-1.5">
              <Package className="h-4 w-4" />
              {t('Products')}
            </TabsTrigger>
          )}
          {canViewBatches && (
            <TabsTrigger value="batches" className="gap-1.5">
              <Layers className="h-4 w-4" />
              {t('Batches')}
            </TabsTrigger>
          )}
          {canViewExpiry && (
            <TabsTrigger value="expiry" className="gap-1.5">
              <AlertTriangle className="h-4 w-4" />
              {t('Expiry')}
            </TabsTrigger>
          )}
          {canViewValuation && (
            <TabsTrigger value="valuation" className="gap-1.5">
              <Calculator className="h-4 w-4" />
              {t('Valuation')}
            </TabsTrigger>
          )}
          {canViewReorder && (
            <TabsTrigger value="reorder" className="gap-1.5">
              <TrendingUp className="h-4 w-4" />
              {t('Reorder')}
            </TabsTrigger>
          )}
          {canViewDeadCap && (
            <TabsTrigger value="dead-capital" className="gap-1.5">
              <Skull className="h-4 w-4" />
              {t('Dead Capital')}
            </TabsTrigger>
          )}
        </TabsList>

        {canViewProducts && (
          <TabsContent value="products" className="flex-1 overflow-hidden">
            <ProductsTab />
          </TabsContent>
        )}
        {canViewBatches && (
          <TabsContent value="batches" className="flex-1 overflow-hidden">
            <BatchesTab />
          </TabsContent>
        )}
        {canViewExpiry && (
          <TabsContent value="expiry" className="flex-1 overflow-hidden">
            <ExpiryTab />
          </TabsContent>
        )}
        {canViewValuation && (
          <TabsContent value="valuation" className="flex-1 overflow-hidden">
            <ValuationTab />
          </TabsContent>
        )}
        {canViewReorder && (
          <TabsContent value="reorder" className="flex-1 overflow-hidden">
            <ReorderTab />
          </TabsContent>
        )}
        {canViewDeadCap && (
          <TabsContent value="dead-capital" className="flex-1 overflow-hidden">
            <DeadCapitalTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
