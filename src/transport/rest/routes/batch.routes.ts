import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireMicroPerm, requireAnyMicroPerm } from '../../middleware/auth.middleware';
import { handle }                        from '../../middleware/route-helpers';

export function batchRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireMicroPerm('inventory.batches.view'), handle(async (req, res) => {
    res.json({ data: await services.batch.getAll(req.query as any) });
  }));

  router.get('/available', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.batch.getAllAvailable(req.query as any) });
  }));

  router.get('/available/:productId', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.batch.getAvailable(Number(req.params.productId)) });
  }));

  router.get('/expiring', requireAnyMicroPerm(['inventory.batches.view', 'inventory.expiry_alerts']), handle(async (req, res) => {
    res.json({ data: await services.batch.getExpiring(Number(req.query.days ?? 30)) });
  }));

  router.get('/expired', requireAnyMicroPerm(['inventory.batches.view', 'inventory.expiry_alerts']), handle(async (req, res) => {
    res.json({ data: await services.batch.getExpired() });
  }));

  router.get('/by-product/:productId', requireMicroPerm('inventory.batches.view'), handle(async (req, res) => {
    res.json({ data: await services.batch.getByProduct(Number(req.params.productId)) });
  }));

  router.get('/adjustments', requireMicroPerm('inventory.batches.damage'), handle(async (req, res) => {
    res.json({ data: await services.batch.getAdjustments(req.query as any) });
  }));

  router.get('/:id', requireMicroPerm('inventory.batches.view'), handle(async (req, res) => {
    res.json({ data: await services.batch.getById(Number(req.params.id)) });
  }));

  router.post('/', requireMicroPerm('inventory.batches.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.batch.create(req.body, req.user!.id) });
  }));

  router.put('/:id', requireMicroPerm('inventory.batches.manage'), handle(async (req, res) => {
    res.json({ data: await services.batch.update(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.post('/:id/damage', requireMicroPerm('inventory.batches.damage'), handle(async (req, res) => {
    const { quantityBase, reason, type } = req.body;
    await services.batch.reportDamage(Number(req.params.id), quantityBase, reason ?? null, type, req.user!.id);
    res.json({ data: { ok: true } });
  }));

  return router;
}
