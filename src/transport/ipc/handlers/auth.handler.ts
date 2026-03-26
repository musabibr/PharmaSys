import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerAuthHandlers(
  router: IpcRouter,
  services: ServiceContainer,
  setCurrentUser: (u: import('../../../core/types/models').UserPublic | null) => void
): void {
  // Login — no auth required
  router.handle('auth:login', async (_user, payload: { username: string; password: string }) => {
    const result = await services.auth.login(payload.username, payload.password);
    setCurrentUser(result.user);
    return { success: true, user: result.user };
  }, { requireAuth: false });

  // Logout
  router.handle('auth:logout', async (user) => {
    setCurrentUser(null);
    return { success: true };
  }, { requireAuth: false });

  // Get current user
  router.handle('auth:getCurrentUser', async (user) => {
    if (!user) return { success: false, user: null };
    return { success: true, user };
  }, { requireAuth: false });

  // Session keep-alive — throttled to once per 60 s per user to prevent frontend spam
  const _activityTimestamps = new Map<number, number>();
  const ACTIVITY_INTERVAL_MS = 60_000;
  router.handle('session:activity', async (user) => {
    if (!user) return { success: true };
    const now = Date.now();
    const last = _activityTimestamps.get(user.id) ?? 0;
    if (now - last >= ACTIVITY_INTERVAL_MS) {
      _activityTimestamps.set(user.id, now);
    }
    return { success: true };
  }, { requireAuth: false });

  // Session extend
  router.handle('session:extend', async (_user) => {
    return { success: true };
  }, { requireAuth: false });

  // Change own password (must be logged in)
  router.handle('auth:changePassword', async (user, payload: {
    currentPassword: string;
    newPassword: string;
  }) => {
    await services.auth.changePassword(user!.id, payload.currentPassword, payload.newPassword);
    // Refresh in-memory currentUser so getCurrentUser returns updated must_change_password
    const updated = await services.user.getById(user!.id);
    setCurrentUser(updated);
    return { success: true };
  });

  // Get security question — no auth required
  // Frontend sends username directly (string), NOT { username }
  router.handle('auth:getSecurityQuestion', async (_user, username: string) => {
    return await services.auth.getSecurityQuestion(username);
  }, { requireAuth: false });

  // Reset password via security question — no auth required
  router.handle('auth:resetPasswordWithSecurityAnswer', async (_user, payload: {
    username: string;
    answer: string;
    newPassword: string;
  }) => {
    await services.auth.resetPasswordWithSecurityAnswer(
      payload.username, payload.answer, payload.newPassword
    );
    return { success: true };
  }, { requireAuth: false });

  // Set own security question (must be logged in)
  router.handle('auth:setSecurityQuestion', async (user, payload: {
    question: string;
    answer: string;
  }) => {
    await services.auth.setSecurityQuestion(user!.id, payload.question, payload.answer);
    // Refresh in-memory currentUser
    const updated = await services.user.getById(user!.id);
    setCurrentUser(updated);
    return { success: true };
  });

  // App info (version, isDev, isFirstLaunch)
  router.handle('app:info', async (_user) => {
    const pkg = require('../../../../package.json');
    return {
      version: pkg.version ?? '1.0.0',
      isDev: process.argv.includes('--dev') || !require('electron').app.isPackaged,
      isFirstLaunch: await services.auth.isFirstLaunch(),
    };
  }, { requireAuth: false });
}
