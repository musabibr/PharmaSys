import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CreateTransactionInput, CreateReturnInput, TransactionFilters } from '../../../core/types/models';
import { resolvePermissions, hasPermission } from '../../../core/common/permissions';
import { PermissionError } from '../../../core/types/errors';

export function registerTransactionHandlers(router: IpcRouter, services: ServiceContainer): void {
  // View transactions — view_own users see only their own
  router.handle('transactions:getAll', async (user, filters?: TransactionFilters) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.transactions.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.transactions.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission for this action.');
    }

    const appliedFilters: TransactionFilters = { ...(filters ?? {}) };
    if (!canViewAll && canViewOwn) {
      appliedFilters.user_id = user!.id;
    }
    return await services.transaction.getAll(appliedFilters);
  });

  router.handle('transactions:getById', async (user, id: number) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.transactions.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.transactions.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission for this action.');
    }

    const txn = await services.transaction.getById(id);
    if (!canViewAll && canViewOwn && txn.user_id !== user!.id) {
      throw new PermissionError('You can only view your own transactions.');
    }
    return txn;
  });

  // Frontend uses 'transactions:create' (not 'transactions:createSale')
  router.handle('transactions:create', async (user, data: CreateTransactionInput) => {
    return await services.transaction.createSale(data, user!.id);
  }, { permission: 'pos.sales' });

  // Return — return_own users can only return their own transactions
  router.handle('transactions:return', async (user, data: CreateReturnInput) => {
    const perms = resolvePermissions(user!);
    const canReturnAll = hasPermission(user!.role, perms, 'finance.transactions.return');
    const canReturnOwn = hasPermission(user!.role, perms, 'finance.transactions.return_own');

    if (!canReturnAll && !canReturnOwn) {
      throw new PermissionError('You do not have permission for this action.');
    }

    // If user can only return own, verify ownership of original transaction
    if (!canReturnAll && canReturnOwn) {
      const origTxn = await services.transaction.getById(data.original_transaction_id);
      if (origTxn.user_id !== user!.id) {
        throw new PermissionError('You can only return your own transactions.');
      }
    }

    return await services.transaction.createReturn(data, user!.id);
  });

  // Frontend sends { id, reason, force }
  router.handle('transactions:void', async (user, payload: { id: number; reason: string; force?: boolean }) => {
    const txn = await services.transaction.voidTransaction(payload.id, payload.reason, user!.id, payload.force);
    return { success: true, restored_items: txn.items?.length ?? 0 };
  }, { permission: 'finance.transactions.void' });

  // Frontend uses this to get returned quantities map for a given original transaction
  router.handle('transactions:getReturnedQty', async (user, originalTxnId: number) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.transactions.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.transactions.view_own');
    const canReturnAll = hasPermission(user!.role, perms, 'finance.transactions.return');
    const canReturnOwn = hasPermission(user!.role, perms, 'finance.transactions.return_own');

    if (!canViewAll && !canViewOwn && !canReturnAll && !canReturnOwn) {
      throw new PermissionError('You do not have permission for this action.');
    }

    return await services.transaction.getReturnedQuantities(originalTxnId);
  });
}
