import type { IpcRouter } from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerCycleCountHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('cycleCounts:getAll', async () => {
    return await services.cycleCount.getAll();
  }, { permission: 'inventory.batches.view' });

  router.handle('cycleCounts:getById', async (_user, id: number) => {
    return await services.cycleCount.getById(id);
  }, { permission: 'inventory.batches.view' });

  router.handle('cycleCounts:create', async (user, payload: { name: string; assigned_to?: number; notes?: string }) => {
    return await services.cycleCount.create(payload, user!.id);
  }, { permission: 'inventory.batches.manage' });

  router.handle('cycleCounts:start', async (user, id: number, productIds?: number[]) => {
    return await services.cycleCount.start(id, user!.id, productIds);
  }, { permission: 'inventory.batches.manage' });

  router.handle('cycleCounts:recordCount', async (user, payload: { itemId: number; counted_quantity: number }) => {
    await services.cycleCount.recordCount(payload.itemId, payload.counted_quantity, user!.id);
    return { success: true };
  }, { permission: 'inventory.batches.manage' });

  router.handle('cycleCounts:complete', async (user, payload: { id: number; applyAdjustments: boolean }) => {
    return await services.cycleCount.complete(payload.id, payload.applyAdjustments, user!.id);
  }, { permission: 'inventory.batches.manage' });
}
