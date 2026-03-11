import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireMicroPerm } from '../../middleware/auth.middleware';
import { handle }          from '../../middleware/route-helpers';
import type { ExpensePaymentMethod } from '../../../core/types/models';

export function purchaseRoutes(services: ServiceContainer): Router {
  const router = Router();

  // ─── Suppliers ─────────────────────────────────────────────────────────────

  router.get('/suppliers', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    res.json({ data: await services.purchase.getSuppliers(includeInactive) });
  }));

  router.get('/suppliers/:id', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    res.json({ data: await services.purchase.getSupplierById(Number(req.params.id)) });
  }));

  router.post('/suppliers', requireMicroPerm('purchases.suppliers.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.purchase.createSupplier(req.body, req.user!.id) });
  }));

  router.put('/suppliers/:id', requireMicroPerm('purchases.suppliers.manage'), handle(async (req, res) => {
    res.json({ data: await services.purchase.updateSupplier(Number(req.params.id), req.body, req.user!.id) });
  }));

  // ─── Purchases ─────────────────────────────────────────────────────────────

  router.get('/', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    res.json({ data: await services.purchase.getAll(req.query as any) });
  }));

  router.get('/aging', requireMicroPerm('purchases.view'), handle(async (_req, res) => {
    res.json({ data: await services.purchase.getAgingPayments() });
  }));

  router.get('/overdue-summary', requireMicroPerm('purchases.view'), handle(async (_req, res) => {
    res.json({ data: await services.purchase.getOverdueSummary() });
  }));

  router.get('/upcoming-payments', requireMicroPerm('purchases.view'), handle(async (_req, res) => {
    res.json({ data: await services.purchase.getUpcomingPayments() });
  }));

  router.get('/upcoming-summary', requireMicroPerm('purchases.view'), handle(async (_req, res) => {
    res.json({ data: await services.purchase.getUpcomingSummary() });
  }));

  router.get('/:id', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    res.json({ data: await services.purchase.getById(Number(req.params.id)) });
  }));

  router.get('/:id/items', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    res.json({ data: await services.purchase.getItems(Number(req.params.id)) });
  }));

  router.get('/:id/payments', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    res.json({ data: await services.purchase.getPayments(Number(req.params.id)) });
  }));

  router.post('/', requireMicroPerm('purchases.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.purchase.createPurchase(req.body, req.user!.id) });
  }));

  router.put('/:id', requireMicroPerm('purchases.edit'), handle(async (req, res) => {
    res.json({ data: await services.purchase.updatePurchase(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.delete('/:id', requireMicroPerm('purchases.delete'), handle(async (req, res) => {
    await services.purchase.deletePurchase(Number(req.params.id), req.user!.id);
    res.json({ data: { ok: true } });
  }));

  router.post('/payments/:paymentId/pay', requireMicroPerm('purchases.pay'), handle(async (req, res) => {
    const paymentMethod = req.body.payment_method as ExpensePaymentMethod;
    res.json({
      data: await services.purchase.markPaymentPaid(
        Number(req.params.paymentId),
        paymentMethod,
        req.user!.id,
        req.body.reference_number,
      ),
    });
  }));

  return router;
}
