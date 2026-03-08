import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type {
  CreateSupplierInput, UpdateSupplierInput,
  CreatePurchaseInput, PurchaseFilters,
  ExpensePaymentMethod,
} from '../../../core/types/models';

export function registerPurchaseHandlers(router: IpcRouter, services: ServiceContainer): void {
  // ─── Suppliers ─────────────────────────────────────────────────────────────

  router.handle('suppliers:getAll', async (_user, includeInactive?: boolean) => {
    return await services.purchase.getSuppliers(includeInactive);
  }, { permission: 'purchases.view' });

  router.handle('suppliers:getById', async (_user, id: number) => {
    return await services.purchase.getSupplierById(id);
  }, { permission: 'purchases.view' });

  router.handle('suppliers:create', async (user, data: CreateSupplierInput) => {
    return await services.purchase.createSupplier(data, user!.id);
  }, { permission: 'purchases.suppliers.manage' });

  router.handle('suppliers:update', async (user, id: number, data: UpdateSupplierInput) => {
    return await services.purchase.updateSupplier(id, data, user!.id);
  }, { permission: 'purchases.suppliers.manage' });

  // ─── Purchases ─────────────────────────────────────────────────────────────

  router.handle('purchases:getAll', async (_user, filters?: PurchaseFilters) => {
    return await services.purchase.getAll(filters ?? {});
  }, { permission: 'purchases.view' });

  router.handle('purchases:getById', async (_user, id: number) => {
    return await services.purchase.getById(id);
  }, { permission: 'purchases.view' });

  router.handle('purchases:getItems', async (_user, purchaseId: number) => {
    return await services.purchase.getItems(purchaseId);
  }, { permission: 'purchases.view' });

  router.handle('purchases:getPayments', async (_user, purchaseId: number) => {
    return await services.purchase.getPayments(purchaseId);
  }, { permission: 'purchases.view' });

  router.handle('purchases:create', async (user, data: CreatePurchaseInput) => {
    return await services.purchase.createPurchase(data, user!.id);
  }, { permission: 'purchases.manage' });

  router.handle('purchases:markPaymentPaid', async (user, paymentId: number, paymentMethod: ExpensePaymentMethod, referenceNumber?: string) => {
    return await services.purchase.markPaymentPaid(paymentId, paymentMethod, user!.id, referenceNumber);
  }, { permission: 'purchases.pay' });

  // ─── Aging & Summary ──────────────────────────────────────────────────────

  router.handle('purchases:getAgingPayments', async (_user) => {
    return await services.purchase.getAgingPayments();
  }, { permission: 'purchases.view' });

  router.handle('purchases:getOverdueSummary', async (_user) => {
    return await services.purchase.getOverdueSummary();
  }, { permission: 'purchases.view' });

  router.handle('purchases:getUpcomingPayments', async (_user) => {
    return await services.purchase.getUpcomingPayments();
  }, { permission: 'purchases.view' });

  router.handle('purchases:getUpcomingSummary', async (_user) => {
    return await services.purchase.getUpcomingSummary();
  }, { permission: 'purchases.view' });
}
