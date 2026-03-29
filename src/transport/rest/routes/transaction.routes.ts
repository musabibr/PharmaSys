import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import type { ProductSaleFilters } from '../../../core/types/models';
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
    res.status(201).json({ data: await services.transaction.createSale(req.body, req.user!.id, req.user!.role) });
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
    res.status(201).json({ data: await services.transaction.createReturn(req.body, req.user!.id, req.user!.role) });
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

  router.get('/by-product', requireAuth, handle(async (req, res) => {
    const rawIds = req.query.product_ids ? String(req.query.product_ids) : undefined;
    const filters: ProductSaleFilters = {
      product_ids:      rawIds ? rawIds.split(',').map(Number).filter(Boolean) : undefined,
      batch_id:         req.query.batch_id          ? Number(req.query.batch_id)        : undefined,
      user_id:          req.query.user_id            ? Number(req.query.user_id)         : undefined,
      start_date:       req.query.start_date         ? String(req.query.start_date)     : undefined,
      end_date:         req.query.end_date           ? String(req.query.end_date)       : undefined,
      transaction_type: req.query.transaction_type  as 'sale' | 'return' | undefined,
      page:             req.query.page               ? Number(req.query.page)           : undefined,
      limit:            req.query.limit              ? Number(req.query.limit)          : undefined,
    };
    res.json({ data: await services.transaction.getSalesByProduct(filters) });
  }));

  return router;
}
