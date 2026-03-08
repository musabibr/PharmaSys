import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CreateProductInput, UpdateProductInput, BulkCreateProductInput, ProductFilters } from '../../../core/types/models';

export function registerProductHandlers(router: IpcRouter, services: ServiceContainer): void {
  // Read-only — any authenticated user can browse products (needed for POS)
  router.handle('products:getAll', async (_user, search?: string) => {
    return await services.product.getAll(search);
  });

  router.handle('products:getList', async (_user, filters?: ProductFilters) => {
    return await services.product.getList(filters ?? {});
  });

  router.handle('products:getById', async (_user, id: number) => {
    return await services.product.getById(id);
  });

  router.handle('products:search', async (_user, query: string) => {
    return await services.product.search(query);
  });

  router.handle('products:create', async (user, data: CreateProductInput) => {
    return await services.product.create(data, user!.id);
  }, { permission: 'inventory.products.manage' });

  router.handle('products:update', async (user, payload: { id: number; data: UpdateProductInput }) => {
    return await services.product.update(payload.id, payload.data, user!.id);
  }, { permission: 'inventory.products.manage' });

  router.handle('products:delete', async (user, id: number) => {
    await services.product.delete(id, user!.id);
    return { success: true };
  }, { permission: 'inventory.products.delete' });

  router.handle('products:bulkCreate', async (user, items: BulkCreateProductInput[]) => {
    return await services.product.bulkCreate(items, user!.id);
  }, { permission: 'inventory.products.bulk_import' });
}
