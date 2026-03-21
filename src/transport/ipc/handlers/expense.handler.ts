import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CreateExpenseInput, CreateCashDropInput, ExpenseFilters } from '../../../core/types/models';

export function registerExpenseHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('expenses:getCategories', async (_user) => {
    return await services.expense.getCategories();
  }, { permission: 'finance.expenses.view' });

  router.handle('expenses:createCategory', async (user, name: string) => {
    return await services.expense.createCategory(name, user!.id);
  }, { permission: 'finance.expense_categories' });

  router.handle('expenses:getAll', async (_user, filters?: ExpenseFilters) => {
    return await services.expense.getAll(filters ?? {});
  }, { permission: 'finance.expenses.view' });

  router.handle('expenses:create', async (user, data: CreateExpenseInput) => {
    return await services.expense.create(data, user!.id);
  }, { permission: 'finance.expenses.manage' });

  router.handle('expenses:update', async (user, payload: { id: number; data: Partial<CreateExpenseInput> }) => {
    return await services.expense.update(payload.id, payload.data, user!.id);
  }, { permission: 'finance.expenses.manage' });

  router.handle('expenses:delete', async (user, id: number) => {
    await services.expense.delete(id, user!.id);
    return { success: true };
  }, { permission: 'finance.expenses.delete' });

  router.handle('expenses:updateCategory', async (user, payload: { id: number; name: string }) => {
    return await services.expense.updateCategory(payload.id, payload.name, user!.id);
  }, { permission: 'finance.expense_categories' });

  router.handle('expenses:deleteCategory', async (user, id: number) => {
    await services.expense.deleteCategory(id, user!.id);
    return { success: true };
  }, { permission: 'finance.expense_categories' });

  // Frontend uses 'cashDrops:create' (sends { amount, reason })
  router.handle('cashDrops:create', async (user, payload: { amount: number; reason?: string }) => {
    return await services.expense.createCashDrop({ amount: payload.amount, reason: payload.reason }, user!.id);
  }, { permission: 'finance.cash_drops.manage' });

  // Frontend uses 'cashDrops:getByShift'
  router.handle('cashDrops:getByShift', async (_user, shiftId: number) => {
    return await services.expense.getCashDrops(shiftId);
  }, { permission: 'finance.cash_drops.view' });
}
