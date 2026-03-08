import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireMicroPerm, requireAnyMicroPerm } from '../../middleware/auth.middleware';
import { handle }          from '../../middleware/route-helpers';
import { resolvePermissions, hasPermission } from '../../../core/common/permissions';
import { PermissionError } from '../../../core/types/errors';

export function transactionRoutes(services: ServiceContainer): Router {
  const router = Router();

  // View transactions — view_own users see only their own
  router.get('/', requireAnyMicroPerm(['finance.transactions.view', 'finance.transactions.view_own']), handle(async (req, res) => {
    const user = req.user!;
    const perms = resolvePermissions(user);
    const canViewAll = hasPermission(user.role, perms, 'finance.transactions.view');
    const filters: any = { ...(req.query as any) };
    if (!canViewAll) {
      filters.user_id = user.id;
    }
    res.json({ data: await services.transaction.getAll(filters) });
  }));

  router.get('/:id', requireAnyMicroPerm(['finance.transactions.view', 'finance.transactions.view_own']), handle(async (req, res) => {
    const user = req.user!;
    const perms = resolvePermissions(user);
    const canViewAll = hasPermission(user.role, perms, 'finance.transactions.view');
    const txn = await services.transaction.getById(Number(req.params.id));
    if (!canViewAll && txn.user_id !== user.id) {
      throw new PermissionError('You can only view your own transactions.');
    }
    res.json({ data: txn });
  }));

  router.post('/sale', requireMicroPerm('pos.sales'), handle(async (req, res) => {
    res.status(201).json({ data: await services.transaction.createSale(req.body, req.user!.id) });
  }));

  // Return — return_own users can only return their own transactions
  router.post('/return', requireAnyMicroPerm(['finance.transactions.return', 'finance.transactions.return_own']), handle(async (req, res) => {
    const user = req.user!;
    const perms = resolvePermissions(user);
    const canReturnAll = hasPermission(user.role, perms, 'finance.transactions.return');
    if (!canReturnAll) {
      const origTxn = await services.transaction.getById(req.body.original_transaction_id);
      if (origTxn.user_id !== user.id) {
        throw new PermissionError('You can only return your own transactions.');
      }
    }
    res.status(201).json({ data: await services.transaction.createReturn(req.body, req.user!.id) });
  }));

  router.get('/:id/returned-qty', requireAnyMicroPerm([
    'finance.transactions.view', 'finance.transactions.view_own',
    'finance.transactions.return', 'finance.transactions.return_own',
  ]), handle(async (req, res) => {
    res.json({ data: await services.transaction.getReturnedQuantities(Number(req.params.id)) });
  }));

  router.post('/:id/void', requireMicroPerm('finance.transactions.void'), handle(async (req, res) => {
    res.json({ data: await services.transaction.voidTransaction(Number(req.params.id), req.body.reason, req.user!.id) });
  }));

  return router;
}
