import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CreateRecurringExpenseInput } from '../../../core/types/models';

export function registerRecurringExpenseHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('recurringExpenses:getAll', async (_user) => {
    return await services.recurringExpense.getAll();
  }, { permission: 'finance.expenses.view' });

  router.handle('recurringExpenses:create', async (user, data: CreateRecurringExpenseInput) => {
    return await services.recurringExpense.create(data, user!.id);
  }, { permission: 'finance.expenses.manage' });

  router.handle('recurringExpenses:update', async (user, payload: { id: number; data: CreateRecurringExpenseInput }) => {
    return await services.recurringExpense.update(payload.id, payload.data, user!.id);
  }, { permission: 'finance.expenses.manage' });

  router.handle('recurringExpenses:delete', async (user, id: number) => {
    await services.recurringExpense.delete(id, user!.id);
    return { success: true };
  }, { permission: 'finance.expenses.manage' });

  router.handle('recurringExpenses:toggleActive', async (user, id: number) => {
    return await services.recurringExpense.toggleActive(id, user!.id);
  }, { permission: 'finance.expenses.manage' });

  router.handle('recurringExpenses:preview', async (_user) => {
    return await services.recurringExpense.previewGeneration();
  }, { permission: 'finance.expenses.view' });

  router.handle('recurringExpenses:generate', async (user, itemIds?: number[]) => {
    const count = await services.recurringExpense.generateForMissedDays(user!.id, itemIds);
    return { count };
  }, { permission: 'finance.expenses.manage' });
}
