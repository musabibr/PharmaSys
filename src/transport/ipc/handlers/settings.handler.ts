import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerSettingsHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('settings:getAll', async (_user) => {
    return await services.settings.getAll();
  });

  router.handle('settings:get', async (_user, key: string) => {
    return { key, value: await services.settings.get(key) };
  });

  router.handle('settings:set', async (user, payload: { key: string; value: string }) => {
    await services.settings.set(payload.key, payload.value, user!.id);
    return { success: true };
  }, { adminOnly: true });
}
