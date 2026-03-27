/**
 * Registers all IPC handlers with the Electron ipcMain.
 * Called once from platform/electron/main.ts after the DB and services are ready.
 */

import type { IpcMain }          from 'electron';
import type { ServiceContainer } from '../../core/services/index';
import type { UserPublic }       from '../../core/types/models';
import { IpcRouter }             from './ipc-router';

import { registerAuthHandlers }        from './handlers/auth.handler';
import { registerUserHandlers }        from './handlers/user.handler';
import { registerCategoryHandlers }    from './handlers/category.handler';
import { registerProductHandlers }     from './handlers/product.handler';
import { registerBatchHandlers }       from './handlers/batch.handler';
import { registerTransactionHandlers } from './handlers/transaction.handler';
import { registerShiftHandlers }       from './handlers/shift.handler';
import { registerExpenseHandlers }     from './handlers/expense.handler';
import { registerHeldSaleHandlers }    from './handlers/held-sale.handler';
import { registerReportHandlers }      from './handlers/report.handler';
import { registerAuditHandlers }       from './handlers/audit.handler';
import { registerSettingsHandlers }    from './handlers/settings.handler';
import { registerBackupHandlers }      from './handlers/backup.handler';
import { registerPurchaseHandlers }          from './handlers/purchase.handler';
import { registerRecurringExpenseHandlers }  from './handlers/recurring-expense.handler';

export function registerAllHandlers(
  ipcMain: IpcMain,
  services: ServiceContainer,
  getCurrentUser: () => UserPublic | null,
  setCurrentUser: (user: UserPublic | null) => void
): void {
  const router = new IpcRouter(ipcMain, getCurrentUser);

  registerAuthHandlers(router, services, setCurrentUser);
  registerUserHandlers(router, services, getCurrentUser, setCurrentUser);
  registerCategoryHandlers(router, services);
  registerProductHandlers(router, services);
  registerBatchHandlers(router, services);
  registerTransactionHandlers(router, services);
  registerShiftHandlers(router, services);
  registerExpenseHandlers(router, services);
  registerHeldSaleHandlers(router, services);
  registerReportHandlers(router, services);
  registerAuditHandlers(router, services);
  registerSettingsHandlers(router, services);
  registerBackupHandlers(router, services);
  registerPurchaseHandlers(router, services);
  registerRecurringExpenseHandlers(router, services);
}
