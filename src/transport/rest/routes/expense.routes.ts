import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireMicroPerm } from '../../middleware/auth.middleware';
import { handle }          from '../../middleware/route-helpers';

export function expenseRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/categories', requireMicroPerm('finance.expenses.view'), handle(async (_req, res) => {
    res.json({ data: await services.expense.getCategories() });
  }));

  router.post('/categories', requireMicroPerm('finance.expense_categories'), handle(async (req, res) => {
    res.status(201).json({ data: await services.expense.createCategory(req.body.name, req.user!.id) });
  }));

  router.get('/', requireMicroPerm('finance.expenses.view'), handle(async (req, res) => {
    res.json({ data: await services.expense.getAll(req.query as any) });
  }));

  router.post('/', requireMicroPerm('finance.expenses.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.expense.create(req.body, req.user!.id) });
  }));

  router.delete('/:id', requireMicroPerm('finance.expenses.delete'), handle(async (req, res) => {
    await services.expense.delete(Number(req.params.id), req.user!.id);
    res.json({ data: { ok: true } });
  }));

  router.get('/cash-drops', requireMicroPerm('finance.cash_drops.view'), handle(async (req, res) => {
    res.json({ data: await services.expense.getCashDrops(Number(req.query.shiftId)) });
  }));

  router.post('/cash-drops', requireMicroPerm('finance.cash_drops.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.expense.createCashDrop(req.body, req.user!.id) });
  }));

  return router;
}
