import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerCategoryHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('categories:getAll', async (_user) => {
    return await services.category.getAll();
  }, { requireAuth: false });

  // Frontend sends name directly (string), not { name }
  router.handle('categories:create', async (user, name: string) => {
    return await services.category.create(name, user!.id);
  }, { permission: 'inventory.categories.manage' });

  router.handle('categories:update', async (user, payload: { id: number; name: string }) => {
    return await services.category.update(payload.id, payload.name, user!.id);
  }, { permission: 'inventory.categories.manage' });
}
