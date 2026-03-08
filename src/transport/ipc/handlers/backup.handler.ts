import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerBackupHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('backup:create', async (user, label?: string) => {
    const entry = await services.backup.create(user!.id, label);
    return { success: true, filename: entry.filename, path: entry.path };
  }, { adminOnly: true });

  router.handle('backup:list', async (_user) => {
    return await services.backup.list();
  }, { adminOnly: true });

  // Frontend sends { filename } (object, not direct string)
  router.handle('backup:restore', async (user, payload: { filename: string }) => {
    await services.backup.restore(payload.filename, user!.id);
    return { success: true, restartRequired: true };
  }, { adminOnly: true });
}
