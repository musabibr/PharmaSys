import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type {
  CreateSupplierInput, UpdateSupplierInput,
  CreatePurchaseInput, CreatePurchaseItemInput, UpdatePurchaseInput, PurchaseFilters,
  ExpensePaymentMethod, PaymentAdjustmentStrategy,
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

  router.handle('purchases:update', async (user, id: number, data: UpdatePurchaseInput) => {
    return await services.purchase.updatePurchase(id, data, user!.id);
  }, { permission: 'purchases.edit' });

  router.handle('purchases:delete', async (user, id: number, force?: boolean) => {
    await services.purchase.deletePurchase(id, user!.id, force && user!.role === 'admin');
    return { ok: true };
  }, { permission: 'purchases.delete' });

  router.handle('purchases:addItems', async (user, purchaseId: number, data: { items: CreatePurchaseItemInput[] }) => {
    return await services.purchase.addItemsToPurchase(purchaseId, data.items, user!.id);
  }, { permission: 'purchases.manage' });

  router.handle('purchases:markPaymentPaid', async (user, paymentId: number, paymentMethod: ExpensePaymentMethod, referenceNumber?: string, paidAmount?: number, adjustmentStrategy?: PaymentAdjustmentStrategy) => {
    return await services.purchase.markPaymentPaid(paymentId, paymentMethod, user!.id, referenceNumber, paidAmount, adjustmentStrategy);
  }, { permission: 'purchases.pay' });

  router.handle('purchases:updateSchedule', async (user, purchaseId: number, payments: Array<{ id: number; amount: number; due_date: string }>) => {
    return await services.purchase.updatePaymentSchedule(purchaseId, payments, user!.id);
  }, { permission: 'purchases.edit' });

  router.handle('purchases:replaceUnpaidSchedule', async (user, purchaseId: number, payments: Array<{ amount: number; due_date: string }>) => {
    return await services.purchase.replaceUnpaidSchedule(purchaseId, payments, user!.id);
  }, { permission: 'purchases.edit' });

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

  // ─── Payment Editing ────────────────────────────────────────────────────────

  router.handle('purchases:updatePayment', async (user, payload: {
    paymentId: number;
    data: { amount?: number; due_date?: string; payment_method?: string; reference_number?: string | null };
  }) => {
    return await services.purchase.updatePayment(payload.paymentId, payload.data, user!.id);
  }, { permission: 'purchases.edit' });

  router.handle('purchases:unmarkPaymentPaid', async (user, paymentId: number) => {
    return await services.purchase.unmarkPaymentPaid(paymentId, user!.id);
  }, { permission: 'purchases.edit' });

  router.handle('purchases:deletePayment', async (user, paymentId: number) => {
    await services.purchase.deletePayment(paymentId, user!.id);
    return { ok: true };
  }, { permission: 'purchases.edit' });

  // ─── Item Editing ──────────────────────────────────────────────────────────

  router.handle('purchases:updateItem', async (user, payload: {
    itemId: number;
    data: { quantity_received?: number; cost_per_parent?: number; selling_price_parent?: number };
  }) => {
    return await services.purchase.updatePurchaseItem(payload.itemId, payload.data, user!.id);
  }, { permission: 'purchases.edit' });

  router.handle('purchases:deleteItem', async (user, itemId: number) => {
    await services.purchase.deletePurchaseItem(itemId, user!.id);
    return { ok: true };
  }, { permission: 'purchases.edit' });

  // ─── Pending Items ──────────────────────────────────────────────────────────

  router.handle('purchases:getPendingItems', async (_user, purchaseId: number) => {
    return await services.purchase.getPendingItems(purchaseId);
  }, { permission: 'purchases.view' });

  router.handle('purchases:completePendingItem', async (user, pendingItemId: number, itemData: CreatePurchaseItemInput) => {
    return await services.purchase.completePendingItem(pendingItemId, itemData, user!.id);
  }, { permission: 'purchases.manage' });

  router.handle('purchases:deletePendingItem', async (user, pendingItemId: number) => {
    await services.purchase.deletePendingItem(pendingItemId, user!.id);
    return { ok: true };
  }, { permission: 'purchases.manage' });

  router.handle('purchases:updatePendingItem', async (user, pendingItemId: number, rawData: string, notes?: string | null) => {
    return await services.purchase.updatePendingItem(pendingItemId, rawData, notes, user!.id);
  }, { permission: 'purchases.manage' });

  // ─── Merge Invoices ─────────────────────────────────────────────────────────

  router.handle('purchases:merge', async (user, targetId: number, sourceIds: number[]) => {
    return await services.purchase.mergePurchases(targetId, sourceIds, user!.id);
  }, { permission: 'purchases.manage' });

  // ─── All Pending Items (global) ──────────────────────────────────────────────

  router.handle('purchases:getAllPendingItems', async (_user, filters: unknown) => {
    return services.purchase.getAllPendingItems((filters ?? {}) as { search?: string; supplier_id?: number; page?: number; limit?: number });
  }, { permission: 'purchases.view' });
}
