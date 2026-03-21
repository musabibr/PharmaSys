import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requireMicroPerm, requireAnyMicroPerm } from '../../middleware/auth.middleware';
import { handle }                        from '../../middleware/route-helpers';

export function reportRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/dashboard', requireMicroPerm('reports.dashboard'), handle(async (_req, res) => {
    res.json({ data: await services.dashboard.getStats() });
  }));

  router.get('/cash-flow', requireMicroPerm('reports.cash_flow'), handle(async (req, res) => {
    res.json({ data: await services.report.getCashFlow(
      String(req.query.startDate ?? ''), String(req.query.endDate ?? '')
    )});
  }));

  router.get('/profit-loss', requireMicroPerm('reports.profit_loss'), handle(async (req, res) => {
    res.json({ data: await services.report.getProfitLoss(
      String(req.query.startDate ?? ''), String(req.query.endDate ?? '')
    )});
  }));

  router.get('/reorder', requireAnyMicroPerm(['inventory.reorder', 'inventory.low_stock']), handle(async (_req, res) => {
    res.json({ data: await services.report.getReorderRecommendations() });
  }));

  router.get('/dead-capital', requireMicroPerm('inventory.dead_capital'), handle(async (_req, res) => {
    res.json({ data: await services.report.getDeadCapital() });
  }));

  router.get('/inventory-valuation', requireMicroPerm('inventory.valuation'), handle(async (req, res) => {
    res.json({ data: await services.report.getInventoryValuation(req.query as any) });
  }));

  router.get('/purchase-report', requireMicroPerm('purchases.view'), handle(async (req, res) => {
    res.json({ data: await services.report.getPurchaseReport({
      start_date: String(req.query.startDate ?? ''),
      end_date: String(req.query.endDate ?? ''),
      supplier_id: req.query.supplierId ? Number(req.query.supplierId) : undefined,
      payment_status: req.query.paymentStatus as any || undefined,
    })});
  }));

  return router;
}
