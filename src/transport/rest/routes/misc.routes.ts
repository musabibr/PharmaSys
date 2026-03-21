/**
 * Misc routes: categories, held-sales, audit, settings, backup
 */
import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireMicroPerm, requireAnyMicroPerm, requireAdmin } from '../../middleware/auth.middleware';
import { handle }                                       from '../../middleware/route-helpers';

export function categoryRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAuth, handle(async (_req, res) => {
    res.json({ data: await services.category.getAll() });
  }));

  router.post('/', requireMicroPerm('inventory.categories.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.category.create(req.body.name, req.user!.id) });
  }));

  router.put('/:id', requireMicroPerm('inventory.categories.manage'), handle(async (req, res) => {
    res.json({ data: await services.category.update(Number(req.params.id), req.body.name, req.user!.id) });
  }));

  return router;
}

export function heldSaleRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAnyMicroPerm(['pos.held_sales', 'pos.sales']), handle(async (req, res) => {
    res.json({ data: await services.heldSale.getAll(req.user!.id) });
  }));

  router.post('/', requireAnyMicroPerm(['pos.held_sales', 'pos.sales']), handle(async (req, res) => {
    const { items, customerNote } = req.body;
    res.status(201).json({ data: await services.heldSale.save(req.user!.id, items, customerNote) });
  }));

  router.delete('/:id', requireAnyMicroPerm(['pos.held_sales', 'pos.sales']), handle(async (req, res) => {
    await services.heldSale.delete(Number(req.params.id), req.user!.id);
    res.json({ data: { ok: true } });
  }));

  return router;
}

export function auditRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAdmin, handle(async (req, res) => {
    res.json({ data: await services.audit.getAll(req.query as any) });
  }));

  router.delete('/purge', requireAdmin, handle(async (req, res) => {
    await services.audit.purgeOlderThan(Number(req.body.olderThanDays ?? 90));
    res.json({ data: { ok: true } });
  }));

  return router;
}

export function settingsRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAuth, handle(async (_req, res) => {
    res.json({ data: await services.settings.getAll() });
  }));

  router.get('/:key', requireAuth, handle(async (req, res) => {
    const k = String(req.params['key']);
    res.json({ data: { key: k, value: await services.settings.get(k) } });
  }));

  router.put('/:key', requireAdmin, handle(async (req, res) => {
    await services.settings.set(String(req.params['key']), req.body.value, req.user!.id);
    res.json({ data: { ok: true } });
  }));

  return router;
}

export function appInfoRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', handle(async (_req, res) => {
    const pkg = require('../../../../package.json');
    const isDev = process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
    res.json({
      data: {
        version: pkg.version ?? '1.0.0',
        isDev,
        isFirstLaunch: await services.auth.isFirstLaunch(),
      },
    });
  }));

  return router;
}

export function backupRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAdmin, handle(async (_req, res) => {
    res.json({ data: await services.backup.list() });
  }));

  router.post('/', requireAdmin, handle(async (req, res) => {
    res.json({ data: await services.backup.create(req.user!.id, req.body.label) });
  }));

  router.post('/restore', requireAdmin, handle(async (req, res) => {
    await services.backup.restore(req.body.filename, req.user!.id);
    res.json({ data: { ok: true, restartRequired: true } });
  }));

  return router;
}
