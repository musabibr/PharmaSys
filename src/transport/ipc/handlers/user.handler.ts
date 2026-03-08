import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';
import type { CreateUserInput, UpdateUserInput, UserPublic } from '../../../core/types/models';

export function registerUserHandlers(
  router: IpcRouter,
  services: ServiceContainer,
  getCurrentUser: () => UserPublic | null,
  setCurrentUser: (u: UserPublic | null) => void
): void {
  router.handle('users:getAll', async (_user) => {
    return await services.user.getAll();
  }, { adminOnly: true });

  router.handle('users:getById', async (_user, id: number) => {
    return await services.user.getById(id);
  }, { adminOnly: true });

  router.handle('users:create', async (user, data: CreateUserInput) => {
    return await services.user.create(data, user!.id);
  }, { adminOnly: true });

  router.handle('users:update', async (user, payload: { id: number; data: UpdateUserInput & { password?: string } }) => {
    const updated = await services.user.update(payload.id, payload.data, user!.id);

    // If we just updated the currently logged-in user, refresh their session
    // so permission changes take effect immediately without re-login
    const current = getCurrentUser();
    if (current && current.id === payload.id) {
      setCurrentUser(updated);
    }
    return updated;
  }, { adminOnly: true });

  router.handle('users:resetPassword', async (user, payload: { userId: number; newPassword: string }) => {
    await services.user.resetPassword(payload.userId, payload.newPassword, user!.id);
    return { success: true };
  }, { adminOnly: true });

  // Frontend sends userId directly (not { userId })
  router.handle('users:unlockAccount', async (user, userId: number) => {
    await services.user.unlock(userId, user!.id);
    return { success: true };
  }, { adminOnly: true });
}
