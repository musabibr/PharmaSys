import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerHeldSaleHandlers(router: IpcRouter, services: ServiceContainer): void {
  // Frontend uses 'held:getAll' — admin sees all, non-admin sees own
  router.handle('held:getAll', async (user) => {
    if (user!.role === 'admin') {
      return await services.heldSale.getAll();
    }
    return await services.heldSale.getAll(user!.id);
  }, { anyPermission: ['pos.held_sales', 'pos.sales'] });

  // Frontend uses 'held:save' with { items, customerNote }
  router.handle('held:save', async (user, payload: {
    items: unknown[];
    customerNote?: string;
  }) => {
    return await services.heldSale.save(user!.id, payload.items, payload.customerNote);
  }, { anyPermission: ['pos.held_sales', 'pos.sales'] });

  // Frontend uses 'held:delete'
  router.handle('held:delete', async (user, id: number) => {
    await services.heldSale.delete(id, user!.id);
    return { success: true };
  }, { anyPermission: ['pos.held_sales', 'pos.sales'] });
}
