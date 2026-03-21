import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAdmin }          from '../../middleware/auth.middleware';
import { handle }                from '../../middleware/route-helpers';

export function userRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/',           requireAdmin, handle(async (req, res) => {
    res.json({ data: await services.user.getAll() });
  }));

  router.get('/:id',        requireAdmin, handle(async (req, res) => {
    res.json({ data: await services.user.getById(Number(req.params.id)) });
  }));

  router.post('/',          requireAdmin, handle(async (req, res) => {
    res.status(201).json({ data: await services.user.create(req.body, req.user!.id) });
  }));

  router.put('/:id',        requireAdmin, handle(async (req, res) => {
    res.json({ data: await services.user.update(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.post('/:id/reset-password', requireAdmin, handle(async (req, res) => {
    await services.user.resetPassword(Number(req.params.id), req.body.newPassword, req.user!.id);
    res.json({ data: { ok: true } });
  }));

  router.post('/:id/unlock', requireAdmin, handle(async (req, res) => {
    await services.user.unlock(Number(req.params.id), req.user!.id);
    res.json({ data: { ok: true } });
  }));

  return router;
}
