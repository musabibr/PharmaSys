import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireMicroPerm, requireAdmin } from '../../middleware/auth.middleware';
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

  // Products purchased from this supplier — smart inventory view
  router.get('/suppliers/:id/products', requireMicroPerm('inventory.products.view'), handle(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json({
      data: await services.purchase.getProductsBySupplier(Number(req.params.id), {
        start_date: q.start_date,
        end_date: q.end_date,
        search: q.search,
        stock_status: q.stock_status as any,
        preset: q.preset as any,
        min_cost: q.min_cost != null ? Number(q.min_cost) : undefined,
        max_cost: q.max_cost != null ? Number(q.max_cost) : undefined,
        include_inactive: q.include_inactive === 'true',
        sort_by: q.sort_by as any,
        page: q.page != null ? Number(q.page) : undefined,
        limit: q.limit != null ? Number(q.limit) : undefined,
      }),
    });
  }));

  // Reverse lookup: suppliers who have supplied a given product
  router.get('/products/:id/suppliers', requireMicroPerm('inventory.products.view'), handle(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json({
      data: await services.purchase.getSuppliersByProduct(
        Number(req.params.id),
        q.page != null ? Number(q.page) : undefined,
        q.limit != null ? Number(q.limit) : undefined,
      ),
    });
  }));

  router.post('/suppliers', requireMicroPerm('purchases.suppliers.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.purchase.createSupplier(req.body, req.user!.id) });
  }));

  router.put('/suppliers/:id', requireMicroPerm('purchases.suppliers.manage'), handle(async (req, res) => {
    res.json({ data: await services.purchase.updateSupplier(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.delete('/suppliers/:id', requireAdmin, handle(async (req, res) => {
    await services.purchase.deleteSupplier(Number(req.params.id), req.user!.id);
    res.json({ data: { ok: true } });
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

  router.post('/:id/items', requireMicroPerm('purchases.manage'), handle(async (req, res) => {
    res.status(201).json({
      data: await services.purchase.addItemsToPurchase(
        Number(req.params.id), req.body.items, req.user!.id
      ),
    });
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

  router.patch('/:id/schedule', requireMicroPerm('purchases.edit'), handle(async (req, res) => {
    res.json({
      data: await services.purchase.updatePaymentSchedule(
        Number(req.params.id), req.body.payments, req.user!.id
      ),
    });
  }));

  router.put('/:id/schedule', requireMicroPerm('purchases.edit'), handle(async (req, res) => {
    res.json({
      data: await services.purchase.replaceUnpaidSchedule(
        Number(req.params.id), req.body.payments, req.user!.id
      ),
    });
  }));

  router.post('/payments/:paymentId/pay', requireMicroPerm('purchases.pay'), handle(async (req, res) => {
    const paymentMethod = req.body.payment_method as ExpensePaymentMethod;
    res.json({
      data: await services.purchase.markPaymentPaid(
        Number(req.params.paymentId),
        paymentMethod,
        req.user!.id,
        req.body.reference_number,
        req.body.paid_amount != null ? Number(req.body.paid_amount) : undefined,
        req.body.adjustment_strategy,
      ),
    });
  }));

  return router;
}
