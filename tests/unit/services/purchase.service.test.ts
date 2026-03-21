import { PurchaseService } from '@core/services/purchase.service';
import { ValidationError, NotFoundError, BusinessRuleError } from '@core/types/errors';
import type { Supplier, Purchase, PurchasePayment, CreatePurchaseInput } from '@core/types/models';
import {
  createMockPurchaseRepo, createMockSupplierRepo,
  createMockExpenseRepo, createMockShiftRepo, createMockBaseRepo,
  createMockBus, createMockProductRepo, createMockCategoryRepo,
  runResult, sampleShift,
} from '../../helpers/mocks';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sampleSupplier: Supplier = {
  id: 1, name: 'Al-Rahma Pharma', phone: '0912345678',
  address: 'Khartoum', notes: null, is_active: 1,
  created_at: '2026-01-01', updated_at: '2026-01-01',
};

const samplePurchase: Purchase = {
  id: 1, purchase_number: 'PUR-20260302-001',
  supplier_id: 1, invoice_reference: 'INV-123',
  purchase_date: '2026-03-02', total_amount: 10000,
  total_paid: 0, payment_status: 'unpaid',
  alert_days_before: 7,
  notes: null, user_id: 1,
  created_at: '2026-03-02', updated_at: '2026-03-02',
  supplier_name: 'Al-Rahma Pharma', username: 'admin',
  items: [], payments: [],
};

const samplePayment: PurchasePayment = {
  id: 1, purchase_id: 1, due_date: '2026-04-01',
  amount: 5000, is_paid: 0, paid_date: null, paid_amount: null,
  payment_method: null, reference_number: null, expense_id: null, paid_by_user_id: null,
  notes: null, created_at: '2026-03-02', updated_at: '2026-03-02',
  purchase_number: 'PUR-20260302-001', supplier_name: 'Al-Rahma Pharma',
};

// ─── Factory ─────────────────────────────────────────────────────────────────

function createService() {
  const purchaseRepo = createMockPurchaseRepo();
  const supplierRepo = createMockSupplierRepo();
  const expenseRepo  = createMockExpenseRepo();
  const shiftRepo    = createMockShiftRepo();
  const base         = createMockBaseRepo();
  const bus          = createMockBus();
  const productRepo  = createMockProductRepo();
  const categoryRepo = createMockCategoryRepo();

  const svc = new PurchaseService(
    purchaseRepo as any, supplierRepo as any,
    expenseRepo as any, shiftRepo as any,
    base as any, bus,
    productRepo as any, categoryRepo as any,
  );

  return { svc, purchaseRepo, supplierRepo, expenseRepo, shiftRepo, base, bus, productRepo, categoryRepo };
}

// ─── Valid purchase input (debt-tracking only, no items) ─────────────────────

function validPurchaseInput(overrides: Partial<CreatePurchaseInput> = {}): CreatePurchaseInput {
  return {
    supplier_id: 1,
    invoice_reference: 'INV-123',
    purchase_date: '2026-03-02',
    total_amount: 10000,
    alert_days_before: 7,
    payment_plan: { type: 'installments', installments: [
      { due_date: '2026-04-01', amount: 5000 },
      { due_date: '2026-05-01', amount: 5000 },
    ]},
    ...overrides,
  };
}

describe('PurchaseService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // Supplier CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getSuppliers', () => {
    it('returns all active suppliers by default', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getAll.mockResolvedValue([sampleSupplier]);
      const result = await svc.getSuppliers();
      expect(supplierRepo.getAll).toHaveBeenCalledWith(false);
      expect(result).toHaveLength(1);
    });

    it('passes includeInactive flag', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getAll.mockResolvedValue([]);
      await svc.getSuppliers(true);
      expect(supplierRepo.getAll).toHaveBeenCalledWith(true);
    });
  });

  describe('getSupplierById', () => {
    it('returns supplier when found', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getById.mockResolvedValue(sampleSupplier);
      const result = await svc.getSupplierById(1);
      expect(result.name).toBe('Al-Rahma Pharma');
    });

    it('throws NotFoundError when not found', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getSupplierById(99)).rejects.toThrow(NotFoundError);
    });
  });

  describe('createSupplier', () => {
    it('creates supplier and returns it', async () => {
      const { svc, supplierRepo, bus } = createService();
      supplierRepo.create.mockResolvedValue(runResult(1));
      supplierRepo.getById.mockResolvedValue(sampleSupplier);

      const result = await svc.createSupplier({ name: 'Al-Rahma Pharma' }, 1);
      expect(result.name).toBe('Al-Rahma Pharma');
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_SUPPLIER',
      }));
    });

    it('throws ValidationError for empty name', async () => {
      const { svc } = createService();
      await expect(svc.createSupplier({ name: '' }, 1)).rejects.toThrow(ValidationError);
    });
  });

  describe('updateSupplier', () => {
    it('updates supplier and returns it', async () => {
      const { svc, supplierRepo, bus } = createService();
      supplierRepo.getById.mockResolvedValue(sampleSupplier);

      const updated = { ...sampleSupplier, name: 'New Name' };
      // After update, getById returns the updated version
      supplierRepo.getById.mockResolvedValueOnce(sampleSupplier);
      supplierRepo.getById.mockResolvedValueOnce(updated);

      const result = await svc.updateSupplier(1, { name: 'New Name' }, 1);
      expect(result.name).toBe('New Name');
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_SUPPLIER',
      }));
    });

    it('throws NotFoundError for non-existent supplier', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getById.mockResolvedValue(undefined);
      await expect(svc.updateSupplier(99, { name: 'Test' }, 1)).rejects.toThrow(NotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Purchase Queries
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getAll', () => {
    it('delegates to purchaseRepo.getAll', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getAll.mockResolvedValue({ data: [samplePurchase], total: 1, page: 1, limit: 20, totalPages: 1 });
      const result = await svc.getAll({});
      expect(result.total).toBe(1);
    });
  });

  describe('getById', () => {
    it('returns purchase with items and payments', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getById.mockResolvedValue(samplePurchase);
      const result = await svc.getById(1);
      expect(result.purchase_number).toBe('PUR-20260302-001');
    });

    it('throws NotFoundError when not found', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(99)).rejects.toThrow(NotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Create Purchase (debt tracking only — no items)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('createPurchase', () => {
    it('creates purchase with installments', async () => {
      const { svc, purchaseRepo, supplierRepo, base, bus } = createService();

      supplierRepo.getById.mockResolvedValue(sampleSupplier);
      purchaseRepo.insert.mockResolvedValue(1);
      purchaseRepo.insertPayment.mockResolvedValue(1);
      purchaseRepo.getById.mockResolvedValue(samplePurchase);

      const input = validPurchaseInput();
      const result = await svc.createPurchase(input, 1);

      expect(result.purchase_number).toBe('PUR-20260302-001');
      expect(purchaseRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        alert_days_before: 7,
      }));
      expect(purchaseRepo.insertPayment).toHaveBeenCalledTimes(2);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_PURCHASE',
      }));
    });

    it('creates purchase paid in full with expense', async () => {
      const { svc, purchaseRepo, supplierRepo, expenseRepo, shiftRepo, base } = createService();

      supplierRepo.getById.mockResolvedValue(sampleSupplier);
      purchaseRepo.insert.mockResolvedValue(1);
      purchaseRepo.insertPayment.mockResolvedValue(1);
      purchaseRepo.getById.mockResolvedValue({ ...samplePurchase, payment_status: 'paid', total_paid: 10000 });
      expenseRepo.getCategories.mockResolvedValue([{ id: 5, name: 'Supplier Payment' }]);
      expenseRepo.create.mockResolvedValue(runResult(20));
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);

      const input = validPurchaseInput({
        payment_plan: { type: 'full', payment_method: 'cash' },
      });

      const result = await svc.createPurchase(input, 1);

      // Supplier payments should NOT create expenses (capital outflow, not operational expense)
      expect(expenseRepo.create).not.toHaveBeenCalled();
      expect(purchaseRepo.insertPayment).toHaveBeenCalledWith(expect.objectContaining({
        is_paid: 1,
        amount: 10000,
        expense_id: null,
      }));
    });

    it('allows empty items (debt tracking only)', async () => {
      const { svc, purchaseRepo, supplierRepo } = createService();

      supplierRepo.getById.mockResolvedValue(sampleSupplier);
      purchaseRepo.insert.mockResolvedValue(1);
      purchaseRepo.insertPayment.mockResolvedValue(1);
      purchaseRepo.getById.mockResolvedValue(samplePurchase);

      const input = validPurchaseInput({ items: [] });
      const result = await svc.createPurchase(input, 1);
      expect(result.purchase_number).toBe('PUR-20260302-001');
    });

    it('throws ValidationError when installment total does not match', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getById.mockResolvedValue(sampleSupplier);
      const input = validPurchaseInput({
        payment_plan: {
          type: 'installments',
          installments: [
            { due_date: '2026-04-01', amount: 3000 },
            { due_date: '2026-05-01', amount: 3000 },
          ],
        },
      });
      await expect(svc.createPurchase(input, 1)).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError for non-existent supplier', async () => {
      const { svc, supplierRepo } = createService();
      supplierRepo.getById.mockResolvedValue(undefined);
      const input = validPurchaseInput({ supplier_id: 999 });
      await expect(svc.createPurchase(input, 1)).rejects.toThrow(NotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Mark Payment Paid
  // ═══════════════════════════════════════════════════════════════════════════

  describe('markPaymentPaid', () => {
    it('marks payment as paid, creates expense, updates totals', async () => {
      const { svc, purchaseRepo, expenseRepo, shiftRepo, base, bus } = createService();

      purchaseRepo.getPaymentById.mockResolvedValue(samplePayment);
      purchaseRepo.getById.mockResolvedValue(samplePurchase);
      expenseRepo.getCategories.mockResolvedValue([{ id: 5, name: 'Supplier Payment' }]);
      expenseRepo.create.mockResolvedValue(runResult(20));
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      purchaseRepo.getPaidTotal.mockResolvedValue(5000);

      const updatedPayment = { ...samplePayment, is_paid: 1, paid_date: '2026-03-02' };
      purchaseRepo.getPaymentById
        .mockResolvedValueOnce(samplePayment) // first call: validation
        .mockResolvedValueOnce(updatedPayment); // second call: return

      await svc.markPaymentPaid(1, 'cash', 1);

      expect(purchaseRepo.markPaymentPaid).toHaveBeenCalled();
      expect(purchaseRepo.updateTotals).toHaveBeenCalledWith(1, 5000, 'partial');
      // Supplier payments should NOT create expenses (capital outflow, not operational expense)
      expect(expenseRepo.create).not.toHaveBeenCalled();
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'MARK_PAYMENT_PAID',
      }));
    });

    it('throws NotFoundError for non-existent payment', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getPaymentById.mockResolvedValue(undefined);
      await expect(svc.markPaymentPaid(99, 'cash', 1)).rejects.toThrow(NotFoundError);
    });

    it('throws BusinessRuleError for already paid payment', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getPaymentById.mockResolvedValue({ ...samplePayment, is_paid: 1 });
      await expect(svc.markPaymentPaid(1, 'cash', 1)).rejects.toThrow(BusinessRuleError);
    });

    it('throws ValidationError for invalid payment method', async () => {
      const { svc } = createService();
      await expect(svc.markPaymentPaid(1, 'bitcoin' as any, 1)).rejects.toThrow(ValidationError);
    });

    it('sets status to paid when total_paid >= total_amount', async () => {
      const { svc, purchaseRepo, expenseRepo, shiftRepo } = createService();

      purchaseRepo.getPaymentById.mockResolvedValue(samplePayment);
      purchaseRepo.getById.mockResolvedValue({ ...samplePurchase, total_amount: 5000 });
      expenseRepo.getCategories.mockResolvedValue([{ id: 5, name: 'Supplier Payment' }]);
      expenseRepo.create.mockResolvedValue(runResult(20));
      shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      purchaseRepo.getPaidTotal.mockResolvedValue(5000); // equals total_amount

      const updatedPayment = { ...samplePayment, is_paid: 1 };
      purchaseRepo.getPaymentById
        .mockResolvedValueOnce(samplePayment)
        .mockResolvedValueOnce(updatedPayment);

      await svc.markPaymentPaid(1, 'cash', 1);

      expect(purchaseRepo.updateTotals).toHaveBeenCalledWith(
        expect.any(Number), 5000, 'paid',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Aging, Upcoming & Summary
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getAgingPayments', () => {
    it('delegates to purchaseRepo', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getAgingPayments.mockResolvedValue([]);
      const result = await svc.getAgingPayments();
      expect(result).toEqual([]);
    });
  });

  describe('getOverdueSummary', () => {
    it('returns count and total', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getOverdueSummary.mockResolvedValue({ count: 3, total: 15000 });
      const result = await svc.getOverdueSummary();
      expect(result.count).toBe(3);
      expect(result.total).toBe(15000);
    });
  });

  describe('getUpcomingPayments', () => {
    it('delegates to purchaseRepo', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getUpcomingPayments.mockResolvedValue([]);
      const result = await svc.getUpcomingPayments();
      expect(result).toEqual([]);
    });
  });

  describe('getUpcomingSummary', () => {
    it('returns count and total', async () => {
      const { svc, purchaseRepo } = createService();
      purchaseRepo.getUpcomingSummary.mockResolvedValue({ count: 2, total: 8000 });
      const result = await svc.getUpcomingSummary();
      expect(result.count).toBe(2);
      expect(result.total).toBe(8000);
    });
  });
});
