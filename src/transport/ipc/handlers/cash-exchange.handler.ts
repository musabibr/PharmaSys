import type { IpcRouter } from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CashExchangeFilters, CreateCashExchangeInput, CashExchangeValidationSettings } from '../../../core/types/models';
import { resolvePermissions, hasPermission } from '../../../core/common/permissions';
import { PermissionError } from '../../../core/types/errors';

export function registerCashExchangeHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('cashExchanges:getAll', async (user, filters?: CashExchangeFilters) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.cash_exchanges.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.cash_exchanges.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission to view cash exchanges.');
    }

    const appliedFilters: CashExchangeFilters = { ...(filters ?? {}) };
    if (!canViewAll && canViewOwn) {
      appliedFilters.user_id = user!.id;
    }
    return await services.cashExchange.getAll(appliedFilters);
  }, { anyPermission: ['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own'] });

  router.handle('cashExchanges:getById', async (user, id: number) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.cash_exchanges.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.cash_exchanges.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission to view cash exchanges.');
    }

    const exchange = await services.cashExchange.getById(id);
    if (!canViewAll && canViewOwn) {
      if (exchange.user_id !== user!.id) {
        throw new PermissionError('You can only view your own cash exchanges.');
      }
    }
    return exchange;
  }, { anyPermission: ['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own'] });

  router.handle('cashExchanges:create', async (user, data: CreateCashExchangeInput) => {
    return await services.cashExchange.create(data, user!.id, user!.role);
  }, { permission: 'finance.cash_exchanges.manage' });

  router.handle('cashExchanges:getValidationSettings', async () => {
    return await services.cashExchange.getValidationSettings();
  }, { anyPermission: ['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own', 'finance.cash_exchanges.manage'] });

  router.handle('cashExchanges:updateValidationSettings', async (user, settings: Partial<CashExchangeValidationSettings>) => {
    return await services.cashExchange.updateValidationSettings(settings, user!.id);
  }, { permission: 'finance.cash_exchanges.manage' });

  router.handle('cashExchanges:validateCashAvailability', async (user, data: { amount: number; shiftId: number | null; adminOverride?: boolean }) => {
    return await services.cashExchange.validateCashAvailability(
      data.amount,
      data.shiftId,
      user!.role,
      data.adminOverride || false
    );
  }, { anyPermission: ['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own', 'finance.cash_exchanges.manage'] });
}
