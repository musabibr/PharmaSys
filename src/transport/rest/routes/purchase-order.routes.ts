import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import type { PurchaseOrderFilters } from '../../../core/services/purchase-order.service';
import { requireAnyMicroPerm, requireMicroPerm } from '../../middleware/auth.middleware';
import { handle } from '../../middleware/route-helpers';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (str(v) !== undefined ? Number(v) : undefined);

export function purchaseOrderRoutes(services: ServiceContainer): Router {
  const router = Router();
  const canView = requireAnyMicroPerm(['purchases.view', 'purchases.manage']);
  const canManage = requireMicroPerm('purchases.manage');

  router.get('/', canView, handle(async (req, res) => {
    const q = req.query;
    const filters: PurchaseOrderFilters = {
      supplier_id: num(q.supplier_id),
      status: str(q.status) as PurchaseOrderFilters['status'],
      search: str(q.search),
      page: num(q.page),
      limit: num(q.limit),
    };
    res.json({ data: await services.purchaseOrder.list(filters) });
  }));

  router.get('/:id', canView, handle(async (req, res) => {
    res.json({ data: await services.purchaseOrder.getById(Number(req.params.id)) });
  }));

  router.get('/:id/share-text', canView, handle(async (req, res) => {
    res.json({ data: await services.purchaseOrder.shareText(Number(req.params.id)) });
  }));

  router.get('/:id/receive-prefill', canManage, handle(async (req, res) => {
    res.json({ data: await services.purchaseOrder.receivePrefill(Number(req.params.id)) });
  }));

  router.post('/', canManage, handle(async (req, res) => {
    res.status(201).json({ data: await services.purchaseOrder.create(req.body, req.user!.id) });
  }));

  router.put('/:id', canManage, handle(async (req, res) => {
    res.json({ data: await services.purchaseOrder.update(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.post('/:id/send', canManage, handle(async (req, res) => {
    res.json({ data: await services.purchaseOrder.send(Number(req.params.id), req.user!.id) });
  }));

  router.post('/:id/close', canManage, handle(async (req, res) => {
    res.json({ data: await services.purchaseOrder.close(Number(req.params.id), req.body?.reason, req.user!.id) });
  }));

  return router;
}
