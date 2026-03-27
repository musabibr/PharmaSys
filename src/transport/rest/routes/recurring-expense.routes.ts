import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireMicroPerm } from '../../middleware/auth.middleware';
import { handle }          from '../../middleware/route-helpers';

export function recurringExpenseRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireMicroPerm('finance.expenses.view'), handle(async (_req, res) => {
    res.json({ data: await services.recurringExpense.getAll() });
  }));

  router.post('/', requireMicroPerm('finance.expenses.manage'), handle(async (req, res) => {
    res.status(201).json({ data: await services.recurringExpense.create(req.body, req.user!.id) });
  }));

  router.put('/:id', requireMicroPerm('finance.expenses.manage'), handle(async (req, res) => {
    res.json({ data: await services.recurringExpense.update(Number(req.params.id), req.body, req.user!.id) });
  }));

  router.delete('/:id', requireMicroPerm('finance.expenses.manage'), handle(async (req, res) => {
    await services.recurringExpense.delete(Number(req.params.id), req.user!.id);
    res.json({ data: { success: true } });
  }));

  router.patch('/:id/toggle', requireMicroPerm('finance.expenses.manage'), handle(async (req, res) => {
    res.json({ data: await services.recurringExpense.toggleActive(Number(req.params.id), req.user!.id) });
  }));

  router.post('/generate', requireMicroPerm('finance.expenses.manage'), handle(async (req, res) => {
    const count = await services.recurringExpense.generateForMissedDays(req.user!.id);
    res.json({ data: { count } });
  }));

  return router;
}
