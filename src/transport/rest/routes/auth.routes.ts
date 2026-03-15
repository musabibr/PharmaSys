import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireAdmin, createSession, destroySession, destroySessionsByUserId } from '../../middleware/auth.middleware';
import { handle }                from '../../middleware/route-helpers';

export function authRoutes(services: ServiceContainer): Router {
  const router = Router();

  // POST /api/v1/auth/login
  router.post('/login', handle(async (req, res) => {
    const { username, password } = req.body;
    const result = await services.auth.login(username, password);
    const token  = createSession(result.user);
    res.json({ data: { user: result.user, mustChangePassword: result.mustChangePassword, token } });
  }));

  // POST /api/v1/auth/logout
  router.post('/logout', requireAuth, (req, res) => {
    const token = req.headers.authorization?.slice(7) ?? req.headers['x-session-token'] as string;
    destroySession(token);
    res.json({ data: { ok: true } });
  });

  // GET /api/v1/auth/me
  router.get('/me', requireAuth, (req, res) => {
    res.json({ data: req.user });
  });

  // POST /api/v1/auth/change-password
  router.post('/change-password', requireAuth, handle(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;
    // Keep the current session alive (this device stays logged in); kick all other devices
    const currentToken = (req.headers.authorization?.slice(7) ?? req.headers['x-session-token']) as string;
    await services.auth.changePassword(userId, currentPassword, newPassword);
    destroySessionsByUserId(userId, currentToken);
    res.json({ data: { ok: true } });
  }));

  // POST /api/v1/auth/admin-reset-password
  router.post('/admin-reset-password', requireAdmin, handle(async (req, res) => {
    const { targetUserId, newPassword, mustChange } = req.body;
    await services.auth.adminResetPassword(targetUserId, newPassword, req.user!.id, mustChange ?? true);
    // Invalidate the target user's sessions
    destroySessionsByUserId(Number(targetUserId));
    res.json({ data: { ok: true } });
  }));

  // GET /api/v1/auth/security-question?username=...
  router.get('/security-question', handle(async (req, res) => {
    const result = await services.auth.getSecurityQuestion(String(req.query.username ?? ''));
    res.json({ data: result });
  }));

  // POST /api/v1/auth/reset-password
  router.post('/reset-password', handle(async (req, res) => {
    const { username, answer, newPassword } = req.body;
    await services.auth.resetPasswordWithSecurityAnswer(username, answer, newPassword);
    res.json({ data: { ok: true } });
  }));

  // POST /api/v1/auth/security-question/set
  router.post('/security-question/set', requireAuth, handle(async (req, res) => {
    const { question, answer } = req.body;
    await services.auth.setSecurityQuestion(req.user!.id, question, answer);
    res.json({ data: { ok: true } });
  }));

  // POST /api/v1/auth/unlock/:userId
  router.post('/unlock/:userId', requireAdmin, handle(async (req, res) => {
    await services.auth.unlockAccount(Number(req.params.userId), req.user!.id);
    res.json({ data: { ok: true } });
  }));

  return router;
}
