import type { IpcRouter, IpcHandlerOptions } from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { PurchaseOrderFilters, PurchaseOrderInput } from '../../../core/services/purchase-order.service';

export function registerPurchaseOrderHandlers(router: IpcRouter, services: ServiceContainer): void {
  const canView = { anyPermission: ['purchases.view', 'purchases.manage'] } satisfies IpcHandlerOptions;
  const canManage = { permission: 'purchases.manage' } satisfies IpcHandlerOptions;

  router.handle('purchaseOrders:list', async (_user, filters?: PurchaseOrderFilters) => {
    return await services.purchaseOrder.list(filters ?? {});
  }, canView);

  router.handle('purchaseOrders:getById', async (_user, id: number) => {
    return await services.purchaseOrder.getById(id);
  }, canView);

  router.handle('purchaseOrders:create', async (user, input: PurchaseOrderInput) => {
    return await services.purchaseOrder.create(input, user!.id);
  }, canManage);

  router.handle('purchaseOrders:update', async (user, id: number, input: PurchaseOrderInput) => {
    return await services.purchaseOrder.update(id, input, user!.id);
  }, canManage);

  router.handle('purchaseOrders:send', async (user, id: number) => {
    return await services.purchaseOrder.send(id, user!.id);
  }, canManage);

  router.handle('purchaseOrders:shareText', async (_user, id: number) => {
    return await services.purchaseOrder.shareText(id);
  }, canView);

  router.handle('purchaseOrders:close', async (user, id: number, reason: string) => {
    return await services.purchaseOrder.close(id, reason, user!.id);
  }, canManage);

  router.handle('purchaseOrders:receivePrefill', async (_user, id: number) => {
    return await services.purchaseOrder.receivePrefill(id);
  }, canManage);
}
