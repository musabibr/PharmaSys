import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAnyMicroPerm, requireMicroPerm } from '../../middleware/auth.middleware';
import { handle } from '../../middleware/route-helpers';
import { resolvePermissions, hasPermission } from '../../../core/common/permissions';
import { PermissionError } from '../../../core/types/errors';

export function cashExchangeRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAnyMicroPerm(['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own']), handle(async (req, res) => {
    const perms = resolvePermissions(req.user!);
    const canViewAll = hasPermission(req.user!.role, perms, 'finance.cash_exchanges.view');
    const canViewOwn = hasPermission(req.user!.role, perms, 'finance.cash_exchanges.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission to view cash exchanges.');
    }

    const filters = { ...(req.query as any) };
    if (!canViewAll && canViewOwn) {
      filters.user_id = req.user!.id;
    }
    res.json({ data: await services.cashExchange.getAll(filters) });
  }));

  router.get('/settings/validation', requireAnyMicroPerm(['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own', 'finance.cash_exchanges.manage']), handle(async (req, res) => {
    res.json({ data: await services.cashExchange.getValidationSettings() });
  }));

  router.put('/settings/validation', requireMicroPerm('finance.cash_exchanges.manage'), handle(async (req, res) => {
    res.json({ data: await services.cashExchange.updateValidationSettings(req.body, req.user!.id) });
  }));

  router.post('/validate/cash-availability', requireAnyMicroPerm(['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own', 'finance.cash_exchanges.manage']), handle(async (req, res) => {
    res.json({ data: await services.cashExchange.validateCashAvailability(
      req.body.amount,
      req.body.shiftId,
      req.user!.role,
      req.body.adminOverride || false
    )});
  }));

  router.get('/:id', requireAnyMicroPerm(['finance.cash_exchanges.view', 'finance.cash_exchanges.view_own']), handle(async (req, res) => {
    const perms = resolvePermissions(req.user!);
    const canViewAll = hasPermission(req.user!.role, perms, 'finance.cash_exchanges.view');
    const canViewOwn = hasPermission(req.user!.role, perms, 'finance.cash_exchanges.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission to view cash exchanges.');
    }

    const exchange = await services.cashExchange.getById(Number(req.params.id));
    if (!canViewAll && canViewOwn) {
      if (exchange.user_id !== req.user!.id) {
        throw new PermissionError('You can only view your own cash exchanges.');
      }
    }
    res.json({ data: exchange });
  }));

  router.post('/', requireMicroPerm('finance.cash_exchanges.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.cashExchange.create(req.body, req.user!.id, req.user!.role) });
  }));

  return router;
}
