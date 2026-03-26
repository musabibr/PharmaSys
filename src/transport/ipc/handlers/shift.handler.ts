import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { ShiftFilters }     from '../../../core/types/models';
import { resolvePermissions, hasPermission } from '../../../core/common/permissions';
import { PermissionError } from '../../../core/types/errors';

export function registerShiftHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('shifts:getCurrent', async (user) => {
    return (await services.shift.getCurrent(user!.id)) ?? null;
  });

  // View shifts — view_own users see only their own
  router.handle('shifts:getAll', async (user, filters?: ShiftFilters) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.shifts.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.shifts.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission for this action.');
    }

    const appliedFilters: ShiftFilters = { ...(filters ?? {}) };
    if (!canViewAll && canViewOwn) {
      appliedFilters.user_id = user!.id;
    }
    return await services.shift.getAll(appliedFilters);
  });

  // Any POS user can open/close their own shift
  router.handle('shifts:open', async (user, payload: { openingAmount: number }) => {
    const shift = await services.shift.open(user!.id, payload.openingAmount ?? 0);
    return { success: true, shift };
  }, { anyPermission: ['finance.shifts.manage', 'pos.sales'] });

  router.handle('shifts:close', async (user, payload: {
    shiftId: number;
    actualCash: number;
    notes?: string;
  }) => {
    const shift = await services.shift.close(payload.shiftId, payload.actualCash, payload.notes ?? null, user!.id);
    // Frontend reads result.variance & result.variance_type at top level
    return { success: true, ...shift };
  }, { anyPermission: ['finance.shifts.close', 'pos.sales'] });

  // Edit opening amount — shift owner or admin
  router.handle('shifts:updateOpeningAmount', async (user, payload: { shiftId: number; openingAmount: number; reason?: string }) => {
    return await services.shift.updateOpeningAmount(payload.shiftId, payload.openingAmount, user!.id, user!.role, payload.reason);
  }, { anyPermission: ['finance.shifts.manage', 'pos.sales'] });

  // Expected cash — accessible to any POS user (needed to close their own shift)
  router.handle('shifts:getExpectedCash', async (user, shiftId: number) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.shifts.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.shifts.view_own');
    const canManage = hasPermission(user!.role, perms, 'finance.shifts.manage');
    const canClose = hasPermission(user!.role, perms, 'finance.shifts.close');
    const canPOS = hasPermission(user!.role, perms, 'pos.sales');

    if (!canViewAll && !canViewOwn && !canManage && !canClose && !canPOS) {
      throw new PermissionError('You do not have permission for this action.');
    }

    return await services.shift.getExpectedCash(shiftId);
  });

  // Shift report — view_own users can only see their own shift reports
  router.handle('shifts:getReport', async (user, shiftId: number) => {
    const perms = resolvePermissions(user!);
    const canViewAll = hasPermission(user!.role, perms, 'finance.shifts.view');
    const canViewOwn = hasPermission(user!.role, perms, 'finance.shifts.view_own');

    if (!canViewAll && !canViewOwn) {
      throw new PermissionError('You do not have permission for this action.');
    }

    const report = await services.shift.getReport(shiftId);
    // If view_own only, verify the shift belongs to this user
    if (!canViewAll && canViewOwn && report.shift && report.shift.user_id !== user!.id) {
      throw new PermissionError('You can only view your own shift reports.');
    }
    return report;
  });

  // Frontend uses 'shifts:getLastCash' (not 'shifts:getLastClosedCash')
  router.handle('shifts:getLastCash', async (user) => {
    return await services.shift.getLastClosedCash(user!.id);
  });

  // Admin-only: force-close any user's shift
  router.handle('shifts:forceClose', async (user, payload: {
    shiftId: number;
    actualCash: number;
    notes?: string;
  }) => {
    const shift = await services.shift.forceClose(
      payload.shiftId, payload.actualCash, payload.notes ?? null, user!.id
    );
    return { success: true, ...shift };
  }, { adminOnly: true });
}
