import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { InventoryValuationFilters, PurchaseReportFilters } from '../../../core/types/models';

export function registerReportHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('reports:cashFlow', async (_user, payload: { startDate: string; endDate: string }) => {
    return await services.report.getCashFlow(payload.startDate, payload.endDate);
  }, { permission: 'reports.cash_flow' });

  router.handle('reports:profitLoss', async (_user, payload: { startDate: string; endDate: string }) => {
    return await services.report.getProfitLoss(payload.startDate, payload.endDate);
  }, { permission: 'reports.profit_loss' });

  router.handle('reports:reorderRecommendations', async (_user) => {
    return await services.report.getReorderRecommendations();
  }, { anyPermission: ['inventory.reorder', 'inventory.low_stock'] });

  // Frontend sends days param
  router.handle('reports:deadCapital', async (_user, days?: number) => {
    return await services.report.getDeadCapital(days);
  }, { permission: 'inventory.dead_capital' });

  router.handle('reports:inventoryValuation', async (_user, filters?: InventoryValuationFilters) => {
    return await services.report.getInventoryValuation(filters ?? {});
  }, { permission: 'inventory.valuation' });

  router.handle('reports:purchaseReport', async (_user, filters: PurchaseReportFilters) => {
    return await services.report.getPurchaseReport(filters);
  }, { permission: 'purchases.view' });

  // Frontend uses 'dashboard:stats' (not 'reports:dashboard')
  router.handle('dashboard:stats', async (_user) => {
    return await services.dashboard.getStats();
  }, { permission: 'reports.dashboard' });
}
