/**
 * IPC Router — TypeScript equivalent of secureHandler() in main.js.
 *
 * Provides type-safe handler registration with auth/role/permission guards.
 * Used by platform/electron/main.ts to wire up the new service layer.
 */

import type { IpcMain } from 'electron';
import type { UserPublic } from '../../core/types/models';
import { safeIpc, toIpcError } from '../middleware/error-handler';
import { AuthenticationError, PermissionError } from '../../core/types/errors';
import { resolvePermissions, hasPermission, hasAnyPermission } from '../../core/common/permissions';
import type { PermissionKey } from '../../core/common/permissions';

export interface IpcHandlerOptions {
  /** If false, the handler runs without an authenticated user. Default: true */
  requireAuth?: boolean;
  /** Admin-only. If set, user role must be 'admin'. */
  adminOnly?: boolean;
  /** Legacy permission key that the user must have (admin bypasses). */
  requiredPermission?: 'perm_finance' | 'perm_inventory' | 'perm_reports';
  /** Micro-permission key that the user must have (admin bypasses). */
  permission?: PermissionKey;
  /** Any of these micro-permission keys — user needs at least one (admin bypasses). */
  anyPermission?: PermissionKey[];
}

type GetCurrentUser = () => UserPublic | null;

export class IpcRouter {
  constructor(
    private readonly ipcMain: IpcMain,
    private readonly getCurrentUser: GetCurrentUser
  ) {}

  /**
   * Register an IPC handler with auth guards.
   *
   * @param channel  IPC channel name (e.g., 'products:getAll')
   * @param handler  Function that receives the current user + payload args
   * @param options  Auth options
   */
  handle<TArgs extends unknown[], TResult>(
    channel: string,
    handler: (user: UserPublic | null, ...args: TArgs) => TResult | Promise<TResult>,
    options: IpcHandlerOptions = {}
  ): void {
    const {
      requireAuth = true,
      adminOnly = false,
      requiredPermission,
      permission,
      anyPermission,
    } = options;

    this.ipcMain.handle(channel, async (_event, ...args: TArgs) => {
      // Payload size guard (1 MB)
      try {
        const payloadSize = JSON.stringify(args).length;
        if (payloadSize > 1_048_576) {
          return { success: false, error: 'Request payload too large', code: 'PAYLOAD_TOO_LARGE', statusCode: 413 };
        }

        const user = this.getCurrentUser();

        if (requireAuth && !user) {
          return toIpcError(new AuthenticationError('Authentication required. Please log in.'));
        }

        if (adminOnly && user && user.role !== 'admin') {
          return toIpcError(new PermissionError('Admin access required.'));
        }

        // Legacy permission check (backward compat)
        if (requiredPermission && user && user.role !== 'admin' && !user[requiredPermission]) {
          return toIpcError(new PermissionError('You do not have permission for this action.'));
        }

        // Micro-permission check (single)
        if (permission && user) {
          const perms = resolvePermissions(user);
          if (!hasPermission(user.role, perms, permission)) {
            return toIpcError(new PermissionError('You do not have permission for this action.'));
          }
        }

        // Micro-permission check (any of)
        if (anyPermission && anyPermission.length > 0 && user) {
          const perms = resolvePermissions(user);
          if (!hasAnyPermission(user.role, perms, anyPermission)) {
            return toIpcError(new PermissionError('You do not have permission for this action.'));
          }
        }

        return await safeIpc(() => handler(user, ...args));
      } catch (err) {
        return toIpcError(err);
      }
    });
  }
}
