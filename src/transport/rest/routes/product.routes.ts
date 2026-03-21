import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireMicroPerm } from '../../middleware/auth.middleware';
import { handle }                        from '../../middleware/route-helpers';

export function productRoutes(services: ServiceContainer): Router {
  const router = Router();

  // Read-only — any authenticated user can browse products (needed for POS)
  router.get('/', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.product.getAll(req.query.search as string | undefined) });
  }));

  router.get('/list', requireAuth, handle(async (req, res) => {
    const filters = {
      search: req.query.search as string | undefined,
      category_id: req.query.category_id ? Number(req.query.category_id) : undefined,
      sort_by: req.query.sort_by as 'name' | 'created_at' | undefined,
      sort_dir: req.query.sort_dir as 'asc' | 'desc' | undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    };
    res.json({ data: await services.product.getList(filters) });
  }));

  router.get('/search', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.product.search(String(req.query.q ?? '')) });
  }));

  router.get('/barcode/:barcode', requireAuth, handle(async (req, res) => {
    const product = await services.product.findByBarcode(String(req.params.barcode));
    res.json({ data: product ?? null });
  }));

  router.get('/:id', requireAuth, handle(async (req, res) => {
    res.json({ data: await services.product.getById(Number(req.params.id)) });
  }));

  router.post('/', requireMicroPerm('inventory.products.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.product.create(req.body, req.user!.id) });
  }));

  router.put('/:id', requireMicroPerm('inventory.products.manage'), handle(async (req, res) => {
    res.json({ data: await services.product.update(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.delete('/:id', requireMicroPerm('inventory.products.delete'), handle(async (req, res) => {
    await services.product.delete(Number(req.params.id), req.user!.id);
    res.json({ data: { ok: true } });
  }));

  router.post('/bulk', requireMicroPerm('inventory.products.bulk_import'), handle(async (req, res) => {
    res.status(201).json({ data: await services.product.bulkCreate(req.body, req.user!.id) });
  }));

  return router;
}
