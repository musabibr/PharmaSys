import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CreateBatchInput, UpdateBatchInput, AdjustmentType, BatchFilters } from '../../../core/types/models';

export function registerBatchHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('batches:getByProduct', async (_user, productId: number) => {
    return await services.batch.getByProduct(productId);
  }, { permission: 'inventory.batches.view' });

  // Frontend uses batches:getAvailable (single product) and batches:getAllAvailable (all with filters)
  // Accessible to POS users (need available stock for sales) and inventory viewers
  router.handle('batches:getAvailable', async (_user, productId: number) => {
    return await services.batch.getAvailable(productId);
  }, { anyPermission: ['inventory.batches.view', 'pos.sales'] });

  router.handle('batches:getAllAvailable', async (_user, filters?: BatchFilters) => {
    return await services.batch.getAllAvailable(filters ?? {});
  }, { permission: 'inventory.batches.view' });

  router.handle('batches:create', async (user, data: CreateBatchInput) => {
    return await services.batch.create(data, user!.id);
  }, { permission: 'inventory.batches.manage' });

  router.handle('batches:update', async (user, payload: { id: number; data: Partial<UpdateBatchInput> }) => {
    return await services.batch.update(payload.id, payload.data, user!.id);
  }, { permission: 'inventory.batches.manage' });

  router.handle('batches:getExpiring', async (_user, days: number) => {
    return await services.batch.getExpiring(days);
  }, { anyPermission: ['inventory.batches.view', 'inventory.expiry_alerts'] });

  router.handle('batches:getExpired', async (_user) => {
    return await services.batch.getExpired();
  }, { anyPermission: ['inventory.batches.view', 'inventory.expiry_alerts'] });

  // Frontend uses inventory:reportDamage (not batches:reportDamage)
  // Payload: { batchId, quantity, reason, type }
  router.handle('inventory:reportDamage', async (user, payload: {
    batchId: number;
    quantity: number;
    reason?: string;
    type: AdjustmentType;
  }) => {
    await services.batch.reportDamage(payload.batchId, payload.quantity, payload.reason ?? null, payload.type, user!.id);
    return { success: true };
  }, { permission: 'inventory.batches.damage' });

  // Frontend uses inventory:getAdjustments (not batches:getAdjustments)
  router.handle('inventory:getAdjustments', async (_user, filters: any) => {
    return await services.batch.getAdjustments(filters ?? {});
  }, { permission: 'inventory.batches.damage' });

  router.handle('batches:getActiveBatchesForPriceUpdate', async (_user, productId: number) => {
    return await services.batch.getActiveBatchesForPriceUpdate(productId);
  }, { permission: 'inventory.batches.view' });

  router.handle('batches:updatePricesByProduct', async (user, payload: { productId: number; sellingPriceParent: number; sellingPriceChild?: number }) => {
    return await services.batch.updateSellingPricesByProduct(
      payload.productId, payload.sellingPriceParent, payload.sellingPriceChild ?? null, user!.id
    );
  }, { permission: 'inventory.batches.manage' });

  router.handle('batches:bulkDelete', async (user, ids: number[]) => {
    return await services.batch.bulkDeleteBatches(ids, user!.id);
  }, { adminOnly: true });

  router.handle('batches:getDeleteInfo', async (_user, id: number) => {
    return await services.batch.getBatchDeleteInfo(id);
  }, { adminOnly: true });
}
