import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireAdmin, requireMicroPerm, requireAnyMicroPerm } from '../../middleware/auth.middleware';
import { handle }                        from '../../middleware/route-helpers';
import { resolvePermissions, hasPermission } from '../../../core/common/permissions';
import { PermissionError } from '../../../core/types/errors';

export function shiftRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/current', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.shift.getCurrent(req.user!.id) ?? null });
  }));

  router.get('/last-cash', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.shift.getLastClosedCash(req.user!.id) });
  }));

  // View shifts — view_own users see only their own
  router.get('/', requireAnyMicroPerm(['finance.shifts.view', 'finance.shifts.view_own']), handle(async (req, res) => {
    const user = req.user!;
    const perms = resolvePermissions(user);
    const canViewAll = hasPermission(user.role, perms, 'finance.shifts.view');
    const filters: any = { ...(req.query as any) };
    if (!canViewAll) {
      filters.user_id = user.id;
    }
    res.json({ data: await services.shift.getAll(filters) });
  }));

  router.get('/:id', requireAnyMicroPerm(['finance.shifts.view', 'finance.shifts.view_own']), handle(async (req, res) => {
    const user = req.user!;
    const perms = resolvePermissions(user);
    const canViewAll = hasPermission(user.role, perms, 'finance.shifts.view');
    const shift = await services.shift.getById(Number(req.params.id));
    if (!canViewAll && shift.user_id !== user.id) {
      throw new PermissionError('You can only view your own shifts.');
    }
    res.json({ data: shift });
  }));

  router.get('/:id/expected-cash', requireAnyMicroPerm(['finance.shifts.view', 'finance.shifts.view_own', 'finance.shifts.manage', 'finance.shifts.close', 'pos.sales']), handle(async (req, res) => {
    res.json({ data: await services.shift.getExpectedCash(Number(req.params.id)) });
  }));

  router.get('/:id/report', requireAnyMicroPerm(['finance.shifts.view', 'finance.shifts.view_own']), handle(async (req, res) => {
    const user = req.user!;
    const perms = resolvePermissions(user);
    const canViewAll = hasPermission(user.role, perms, 'finance.shifts.view');
    const report = await services.shift.getReport(Number(req.params.id));
    if (!canViewAll && report.shift && report.shift.user_id !== user.id) {
      throw new PermissionError('You can only view your own shift reports.');
    }
    res.json({ data: report });
  }));

  // Any POS user can open/close their own shift
  router.post('/open', requireAnyMicroPerm(['finance.shifts.manage', 'pos.sales']), handle(async (req, res) => {
    res.status(201).json({ data: await services.shift.open(req.user!.id, req.body.openingAmount ?? 0) });
  }));

  router.post('/:id/close', requireAnyMicroPerm(['finance.shifts.close', 'pos.sales']), handle(async (req, res) => {
    const { actualCash, notes } = req.body;
    res.json({ data: await services.shift.close(Number(req.params.id), actualCash, notes ?? null, req.user!.id) });
  }));

  // Admin-only: force-close any user's shift
  router.post('/:id/force-close', requireAdmin, handle(async (req, res) => {
    const { actualCash, notes } = req.body;
    res.json({ data: await services.shift.forceClose(Number(req.params.id), actualCash, notes ?? null, req.user!.id) });
  }));

  return router;
}
