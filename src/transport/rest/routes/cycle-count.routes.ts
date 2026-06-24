import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireMicroPerm } from '../../middleware/auth.middleware';
import { handle }           from '../../middleware/route-helpers';

export function createCycleCountRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireMicroPerm('inventory.batches.view'), handle(async (req, res) => {
    const counts = await services.cycleCount.getAll();
    res.json({ success: true, data: counts });
  }));

  router.get('/:id', requireMicroPerm('inventory.batches.view'), handle(async (req, res) => {
    const count = await services.cycleCount.getById(Number(req.params.id));
    res.json({ success: true, data: count });
  }));

  router.post('/', requireMicroPerm('inventory.batches.manage'), handle(async (req, res) => {
    const count = await services.cycleCount.create(req.body, req.user!.id);
    res.status(201).json({ success: true, data: count });
  }));

  router.post('/:id/start', requireMicroPerm('inventory.batches.manage'), handle(async (req, res) => {
    const count = await services.cycleCount.start(Number(req.params.id), req.user!.id, req.body?.productIds);
    res.json({ success: true, data: count });
  }));

  // Path matches preload-rest.js client contract (POST /items/:itemId)
  router.post('/items/:itemId', requireMicroPerm('inventory.batches.manage'), handle(async (req, res) => {
    await services.cycleCount.recordCount(Number(req.params.itemId), req.body.counted_quantity, req.user!.id);
    res.json({ success: true });
  }));

  router.post('/:id/complete', requireMicroPerm('inventory.batches.manage'), handle(async (req, res) => {
    const count = await services.cycleCount.complete(Number(req.params.id), req.body.applyAdjustments, req.user!.id);
    res.json({ success: true, data: count });
  }));

  return router;
}
