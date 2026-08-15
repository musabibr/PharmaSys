import { TransactionService } from '@core/services/transaction.service';
import { ValidationError, NotFoundError, ConflictError, BusinessRuleError } from '@core/types/errors';
import { todayLocalISO } from '@core/common/expiry';
import {
  createMockTransactionRepo, createMockBatchRepo, createMockShiftRepo,
  createMockProductRepo, createMockBaseRepo, createMockBus,
  sampleProduct, sampleBatch, sampleFIFOBatch, sampleTransaction, sampleShift,
} from '../../helpers/mocks';

function createService() {
  const txnRepo     = createMockTransactionRepo();
  const batchRepo   = createMockBatchRepo();
  const shiftRepo   = createMockShiftRepo();
  const productRepo = createMockProductRepo();
  const baseRepo    = createMockBaseRepo();
  const bus         = createMockBus();

  const svc = new TransactionService(
    txnRepo as any, batchRepo as any, shiftRepo as any,
    productRepo as any, baseRepo as any, bus
  );
  return { svc, txnRepo, batchRepo, shiftRepo, productRepo, baseRepo, bus };
}

// Helper to set up a standard sale scenario
function setupSaleScenario(deps: ReturnType<typeof createService>) {
  deps.shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
  deps.productRepo.getById.mockResolvedValue(sampleProduct);
  deps.batchRepo.getAvailableByProduct.mockResolvedValue([sampleFIFOBatch]);
  deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
  deps.txnRepo.insert.mockResolvedValue(1);
  deps.txnRepo.getById.mockResolvedValue(sampleTransaction);
}

const saleInput = {
  transaction_type: 'sale' as const,
  subtotal: 8000,
  total_amount: 8000,
  payment_method: 'cash' as const,
  cash_tendered: 10000,
  items: [{
    product_id: 1, quantity: 1, unit_type: 'parent' as const,
    unit_price: 8000,
  }],
};

describe('TransactionService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getAll / getById
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('delegates to repo', async () => {
      const { svc, txnRepo } = createService();
      await svc.getAll({});
      expect(txnRepo.getAll).toHaveBeenCalledWith({});
    });
  });

  describe('getById', () => {
    it('returns transaction with items', async () => {
      const { svc, txnRepo } = createService();
      txnRepo.getById.mockResolvedValue(sampleTransaction);
      const result = await svc.getById(1);
      expect(result.transaction_number).toBe('TXN-20260225-0001');
    });

    it('throws NotFoundError when missing', async () => {
      const { svc, txnRepo } = createService();
      txnRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(999)).rejects.toThrow(NotFoundError);
    });

    it('throws on invalid id', async () => {
      const { svc } = createService();
      await expect(svc.getById(0)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createSale
  // ═══════════════════════════════════════════════════════════════════════════
  describe('createSale', () => {
    it('creates sale successfully', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      const result = await deps.svc.createSale(saleInput, 1);
      expect(result.id).toBe(1);
      expect(deps.txnRepo.insert).toHaveBeenCalled();
      expect(deps.txnRepo.insertItem).toHaveBeenCalled();
    });

    it('clamps stored cash_tendered to the total and keeps the raw amount as cash_received (A1)', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // saleInput: total 8000, cash_tendered (amount handed over) 10000 → 2000 change
      await deps.svc.createSale(saleInput, 1);
      expect(deps.txnRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        cash_tendered: 8000,
        cash_received: 10000,
      }));
    });

    it('does not set cash_received for non-cash payments', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await deps.svc.createSale({ ...saleInput, payment_method: 'bank_transfer', cash_tendered: 0, bank_name: 'Bank of Khartoum', reference_number: 'REF1' } as any, 1);
      expect(deps.txnRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        cash_received: null,
      }));
    });

    it('emits transaction:created and entity:mutated', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await deps.svc.createSale(saleInput, 1);
      expect(deps.bus.emit).toHaveBeenCalledWith('transaction:created', expect.objectContaining({
        transactionId: 1, transactionType: 'sale',
      }));
      expect(deps.bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_SALE',
      }));
    });

    it('throws when no items', async () => {
      const deps = createService();
      await expect(deps.svc.createSale({ ...saleInput, items: [] }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws when no open shift', async () => {
      const deps = createService();
      deps.shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      await expect(deps.svc.createSale(saleInput, 1)).rejects.toThrow(ValidationError);
    });

    // ─── Payment validation ────────────────────────────────────────────────
    it('throws when cash_tendered < total for cash payment', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await expect(deps.svc.createSale({
        ...saleInput, cash_tendered: 100, total_amount: 8000,
      }, 1)).rejects.toThrow(ValidationError);
    });

    it('allows bank_transfer without reference', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // Should NOT throw — bank ref is optional
      await deps.svc.createSale({
        ...saleInput, payment_method: 'bank_transfer', cash_tendered: 0,
      }, 1);
      expect(deps.txnRepo.insert).toHaveBeenCalled();
    });

    it('throws on invalid payment method', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await expect(deps.svc.createSale({
        ...saleInput, payment_method: 'bitcoin' as any,
      }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws on mixed payment without breakdown', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await expect(deps.svc.createSale({
        ...saleInput, payment_method: 'mixed', payment: undefined,
      }, 1)).rejects.toThrow(ValidationError);
    });

    it('accepts valid mixed payment', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await deps.svc.createSale({
        ...saleInput,
        payment_method: 'mixed',
        payment: JSON.stringify({ cash: 5000, bank: 3000 }),
      }, 1);
      expect(deps.txnRepo.insert).toHaveBeenCalled();
    });

    // ─── C4: mixed payment must be re-validated against the SERVER total ───
    it('rejects a mixed payment whose breakdown no longer matches the total computed after FIFO (C4)', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // Client validated cash(5000) + bank(3000) = 8000 against its own
      // total_amount (8000) before FIFO ran. The batch's real price is 8500
      // (no item.unit_price override, so FIFO uses the batch price) — the
      // server-computed total is 8500, which the breakdown no longer covers.
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, selling_price_parent_override: 8500 },
      ]);
      await expect(deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, quantity: 1, unit_type: 'parent' } as any], // no unit_price override
        payment_method: 'mixed',
        payment: JSON.stringify({ cash: 5000, bank: 3000 }),
      }, 1)).rejects.toThrow(ValidationError);
      // Stock must not have been committed — the failure is inside the same
      // transaction as the FIFO deduction, so it rolls back.
      expect(deps.txnRepo.insert).not.toHaveBeenCalled();
    });

    it('throws on mixed payment where parts < total', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await expect(deps.svc.createSale({
        ...saleInput,
        payment_method: 'mixed',
        payment: JSON.stringify({ cash: 1000, bank: 1000 }),
        total_amount: 8000,
      }, 1)).rejects.toThrow(ValidationError);
    });

    // ─── Stock / FIFO ──────────────────────────────────────────────────────
    it('deducts stock from batch via optimistic locking', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      await deps.svc.createSale(saleInput, 1);
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1,           // batch id
        180,         // 200 - 20 (1 parent × 20 cf)
        'active',    // not sold out
        1            // version
      );
    });

    it('marks batch as sold_out when fully deducted', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // Batch has exactly 20 base units, buying 1 parent (20 base)
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, quantity_base: 20 },
      ]);
      await deps.svc.createSale(saleInput, 1);
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 0, 'sold_out', 1
      );
    });

    it('splits across multiple FIFO batches', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // Two batches: first has 10 units, second has 100. Need 20.
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, id: 1, quantity_base: 10, version: 1 },
        { ...sampleFIFOBatch, id: 2, quantity_base: 100, version: 1 },
      ]);
      await deps.svc.createSale(saleInput, 1);
      // First batch fully depleted
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(1, 0, 'sold_out', 1);
      // Second batch partially used
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(2, 90, 'active', 1);
    });

    // ─── C3: FIFO split must not over/under-charge vs the quoted price ───
    it('rounds a same-price multi-batch split once on the combined total, not per fragment (C3)', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // cf 10, price 101/box, 3 boxes requested = 30 base units, split 25 + 5
      // across two batches. round(101*25/10) + round(101*5/10) = 253 + 51 =
      // 304 under the old independent-per-fragment rounding — 1 SDG more
      // than 3 * 101 = 303, the price actually quoted for the line.
      deps.productRepo.getById.mockResolvedValue({ ...sampleProduct, conversion_factor: 10 });
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, id: 1, quantity_base: 25, conversion_factor: 10, version: 1 },
        { ...sampleFIFOBatch, id: 2, quantity_base: 100, conversion_factor: 10, version: 1 },
      ]);

      await deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, quantity: 3, unit_type: 'parent', unit_price: 101 }],
      }, 1);

      const insertedLines = deps.txnRepo.insertItem.mock.calls.map((c: any[]) => c[0]);
      expect(insertedLines).toHaveLength(2);
      const total = insertedLines.reduce((s: number, l: any) => s + l.line_total, 0);
      expect(total).toBe(303); // 3 * 101 — must match the quoted price exactly
      expect(insertedLines[0].line_total).toBe(253); // round(101*25/10)
      expect(insertedLines[1].line_total).toBe(50);   // remainder, not round(101*5/10)=51
    });

    it('rounds each fragment independently when batches genuinely have different prices', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      // No item.unit_price override, and the two batches disagree on price —
      // there's no single "quoted" total to reconcile against, so each
      // fragment keeps its own independently-rounded total (old behavior).
      deps.productRepo.getById.mockResolvedValue({ ...sampleProduct, conversion_factor: 10 });
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, id: 1, quantity_base: 25, conversion_factor: 10, selling_price_parent_override: 101, version: 1 },
        { ...sampleFIFOBatch, id: 2, quantity_base: 100, conversion_factor: 10, selling_price_parent_override: 120, version: 1 },
      ]);

      await deps.svc.createSale({
        ...saleInput,
        // No unit_price override — runtime callers (IPC/REST) can omit it
        // despite the strict type, in which case each fragment falls back to
        // its own batch price.
        items: [{ product_id: 1, quantity: 3, unit_type: 'parent' } as any],
      }, 1);

      const insertedLines = deps.txnRepo.insertItem.mock.calls.map((c: any[]) => c[0]);
      expect(insertedLines).toHaveLength(2);
      expect(insertedLines[0].line_total).toBe(253); // round(101*25/10)
      expect(insertedLines[1].line_total).toBe(60);   // round(120*5/10) — independent, not remainder-based
    });

    it('throws ConflictError on optimistic lock failure', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(false);
      await expect(deps.svc.createSale(saleInput, 1)).rejects.toThrow(ConflictError);
    });

    it('throws when no stock available', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([]);
      await expect(deps.svc.createSale(saleInput, 1)).rejects.toThrow(ValidationError);
    });

    it('throws when insufficient total stock', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, quantity_base: 5 }, // only 5, need 20
      ]);
      await expect(deps.svc.createSale(saleInput, 1)).rejects.toThrow(ValidationError);
    });

    it('throws when product not found', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.productRepo.getById.mockResolvedValue(undefined);
      await expect(deps.svc.createSale(saleInput, 1)).rejects.toThrow(NotFoundError);
    });

    it('uses specific batch when batch_id provided', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleFIFOBatch, quantity_base: 200 });
      await deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, batch_id: 5, quantity: 1, unit_type: 'parent', unit_price: 8000 }],
      }, 1);
      expect(deps.batchRepo.getById).toHaveBeenCalledWith(5);
    });

    it('throws when the given batch_id belongs to a different product (B3)', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleFIFOBatch, id: 5, product_id: 99 });
      await expect(deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, batch_id: 5, quantity: 1, unit_type: 'parent', unit_price: 8000 }],
      }, 1)).rejects.toThrow(ValidationError);
      expect(deps.batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the given batch_id does not exist (B3)', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getById.mockResolvedValue(undefined);
      await expect(deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, batch_id: 999, quantity: 1, unit_type: 'parent', unit_price: 8000 }],
      }, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws when the given batch_id is expired (B3)', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleFIFOBatch, id: 5, expiry_date: '2020-01-01' });
      await expect(deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, batch_id: 5, quantity: 1, unit_type: 'parent', unit_price: 8000 }],
      }, 1)).rejects.toThrow(ValidationError);
      expect(deps.batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    });

    it('handles child unit sales', async () => {
      const deps = createService();
      setupSaleScenario(deps);
      deps.batchRepo.getAvailableByProduct.mockResolvedValue([
        { ...sampleFIFOBatch, quantity_base: 200 },
      ]);
      await deps.svc.createSale({
        ...saleInput,
        items: [{ product_id: 1, quantity: 5, unit_type: 'child', unit_price: 400 }],
      }, 1);
      // child: 5 base units deducted (200-5=195)
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 195, 'active', 1
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createReturn
  // ═══════════════════════════════════════════════════════════════════════════
  describe('createReturn', () => {
    const returnInput = {
      original_transaction_id: 1,
      items: [{ batch_id: 1, unit_type: 'parent' as const, quantity: 1 }],
      notes: 'defective',
    };

    function setupReturnScenario(deps: ReturnType<typeof createService>) {
      deps.txnRepo.getById
        .mockResolvedValueOnce(sampleTransaction) // original lookup
        .mockResolvedValue({ ...sampleTransaction, id: 2, transaction_type: 'return', transaction_number: 'RTN-20260225-0001' }); // return result
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({});
      deps.shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 180 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      deps.txnRepo.insert.mockResolvedValue(2);
      deps.txnRepo.getNextNumber.mockResolvedValue('RTN-20260225-0001');
    }

    it('creates return successfully', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      const result = await deps.svc.createReturn(returnInput, 1);
      expect(result.transaction_type).toBe('return');
    });

    it('attributes the return to the CURRENT open shift, not the original sale\'s shift (A2)', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      // Original sale's shift_id is 1 (sampleTransaction); the user's
      // currently open shift is a different one (99) — the return must use
      // the current shift so a same-day refund lands in today's drawer,
      // not a past (possibly closed) shift.
      deps.shiftRepo.findOpenByUser.mockResolvedValue({ ...sampleShift, id: 99 });
      await deps.svc.createReturn(returnInput, 1);
      expect(deps.txnRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ shift_id: 99 }));
    });

    it('does not backdate the return to the original sale\'s created_at (A2)', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      await deps.svc.createReturn(returnInput, 1);
      // sampleTransaction.created_at is '2026-02-25 10:00:00' — the return
      // must NOT carry that forward; it should let the DB default apply
      // (created_at omitted from the insert payload).
      const insertedData = deps.txnRepo.insert.mock.calls[0][0];
      expect(insertedData.created_at).not.toBe('2026-02-25 10:00:00');
    });

    it('throws when the returning user has no open shift (shifts enabled, non-admin)', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      deps.shiftRepo.findOpenByUser.mockResolvedValue(undefined);
      await expect(deps.svc.createReturn(returnInput, 1)).rejects.toThrow(ValidationError);
    });

    it('uses original sale prices for return items', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      await deps.svc.createReturn(returnInput, 1);
      // insertItem should receive original unit_price (800) from the sale
      expect(deps.txnRepo.insertItem).toHaveBeenCalledWith(
        expect.objectContaining({ unit_price: 800, cost_price: 500 })
      );
    });

    it('restores stock to batch', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      await deps.svc.createReturn(returnInput, 1);
      // batch had 180, returning 20 (1 parent × cf 20) → 200
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 200, 'active', 1
      );
    });

    it('un-sold-out batch becomes active', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 0, status: 'sold_out' });
      await deps.svc.createReturn(returnInput, 1);
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 20, 'active', 1
      );
    });

    it('quarantine batch stays quarantine', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 50, status: 'quarantine' });
      await deps.svc.createReturn(returnInput, 1);
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 70, 'quarantine', 1
      );
    });

    it('throws when original is not a sale', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue({ ...sampleTransaction, transaction_type: 'return' });
      await expect(deps.svc.createReturn(returnInput, 1)).rejects.toThrow(ValidationError);
    });

    it('throws when original is voided', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue({ ...sampleTransaction, is_voided: 1 });
      await expect(deps.svc.createReturn(returnInput, 1)).rejects.toThrow(ValidationError);
    });

    it('throws when returning more than remaining qty', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      // Already returned all 20 base units (key is batch_id only)
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({ '1': 20 });
      await expect(deps.svc.createReturn(returnInput, 1)).rejects.toThrow(ValidationError);
    });

    it('uses batch_id key for returned quantities (cross-unit safe)', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      // 10 base units already returned under key '1'; original was 1 parent = 20 base
      // remaining = 20 - 10 = 10 base; returning 1 parent = 20 base > 10 base → should throw
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({ '1': 10 });
      await expect(deps.svc.createReturn({
        ...returnInput,
        items: [{ batch_id: 1, unit_type: 'parent', quantity: 1 }],
      }, 1)).rejects.toThrow(ValidationError);
      expect(deps.batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
    });

    // ─── C1: same batch sold across two lines in one sale ────────────────
    it('aggregates sold quantity across multiple lines on the same batch when checking the return limit (C1)', async () => {
      const deps = createService();
      // Batch 1 sold twice in the same sale: 1 parent (20 base, cf 20) + a
      // child line (15 base) = 195 base total on batch 1. Nothing returned
      // yet. Returning 190 base (via the child line) exceeds that child
      // line's OWN quantity_base (15) but is well within the batch's
      // aggregate remaining pool (195) — must succeed, not be rejected.
      const twoLineSale = {
        ...sampleTransaction,
        items: [
          { ...sampleTransaction.items![0], id: 1, batch_id: 1, unit_type: 'parent' as const, quantity_base: 180 },
          { ...sampleTransaction.items![0], id: 2, batch_id: 1, unit_type: 'child' as const, quantity_base: 15 },
        ],
      };
      deps.txnRepo.getById
        .mockResolvedValueOnce(twoLineSale)
        .mockResolvedValue({ ...twoLineSale, id: 2, transaction_type: 'return', transaction_number: 'RTN-20260225-0001' });
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({});
      deps.shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 5 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      deps.txnRepo.insert.mockResolvedValue(2);
      deps.txnRepo.getNextNumber.mockResolvedValue('RTN-20260225-0001');

      await expect(deps.svc.createReturn({
        original_transaction_id: 1,
        items: [{ batch_id: 1, unit_type: 'child', quantity: 190 }],
        notes: 'partial return across split lines',
      }, 1)).resolves.toBeDefined();
    });

    it('still rejects a return exceeding the combined total across all lines on the batch (C1)', async () => {
      const deps = createService();
      const twoLineSale = {
        ...sampleTransaction,
        items: [
          { ...sampleTransaction.items![0], id: 1, batch_id: 1, unit_type: 'parent' as const, quantity_base: 180 },
          { ...sampleTransaction.items![0], id: 2, batch_id: 1, unit_type: 'child' as const, quantity_base: 15 },
        ],
      };
      deps.txnRepo.getById.mockResolvedValue(twoLineSale);
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({});
      deps.shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 5 });

      // 180 + 15 = 195 sold total on batch 1 — requesting 196 must fail.
      await expect(deps.svc.createReturn({
        original_transaction_id: 1,
        items: [{ batch_id: 1, unit_type: 'child', quantity: 196 }],
        notes: 'over the combined limit',
      }, 1)).rejects.toThrow(ValidationError);
    });

    // ─── C1 (money): each unit refunds at the price the line it came from
    // sold it, so a batch split across lines can't pay out more than it took.
    function splitPriceSale() {
      // Batch 1 sold as 1 box @800 (cf 10 => 10 base) AND 3 loose strips @90.
      // Collected = 800 + 270 = 1070 for 13 base units.
      return {
        ...sampleTransaction,
        items: [
          { ...sampleTransaction.items![0], id: 1, batch_id: 1, unit_type: 'parent' as const,
            quantity_base: 10, unit_price: 800, cost_price: 500, discount_percent: 0,
            conversion_factor_snapshot: 10, checkout_discount_allocation: 0 },
          { ...sampleTransaction.items![0], id: 2, batch_id: 1, unit_type: 'child' as const,
            quantity_base: 3, unit_price: 90, cost_price: 50, discount_percent: 0,
            conversion_factor_snapshot: 10, checkout_discount_allocation: 0 },
        ],
      };
    }

    function setupSplitPriceReturn(deps: ReturnType<typeof createService>, sale: any, returned = {}) {
      deps.txnRepo.getById
        .mockResolvedValueOnce(sale)
        .mockResolvedValue({ ...sale, id: 2, transaction_type: 'return' });
      deps.txnRepo.getReturnedQuantities.mockResolvedValue(returned);
      deps.shiftRepo.findOpenByUser.mockResolvedValue(sampleShift);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 5 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      deps.txnRepo.insert.mockResolvedValue(2);
      deps.txnRepo.getNextNumber.mockResolvedValue('RTN-20260225-0001');
    }

    it('never refunds more than was collected when one batch spans differently-priced lines (C1)', async () => {
      const deps = createService();
      setupSplitPriceReturn(deps, splitPriceSale());

      await deps.svc.createReturn({
        original_transaction_id: 1,
        items: [{ batch_id: 1, unit_type: 'child', quantity: 13 }],
      }, 1);

      // Was 1170 (all 13 priced at the strip line's 90) against 1070 collected.
      expect(deps.txnRepo.insert.mock.calls[0][0].total_amount).toBe(1070);
    });

    it('splits one requested return across the source lines it draws from (C1)', async () => {
      const deps = createService();
      setupSplitPriceReturn(deps, splitPriceSale());

      await deps.svc.createReturn({
        original_transaction_id: 1,
        items: [{ batch_id: 1, unit_type: 'child', quantity: 13 }],
      }, 1);

      // 10 base from the box line, 3 from the strip line — two ledger rows.
      const inserted = deps.txnRepo.insertItem.mock.calls.map((c: any[]) => c[0]);
      expect(inserted).toHaveLength(2);
      expect(inserted.map((l: any) => l.quantity_base).sort((a: number, b: number) => a - b))
        .toEqual([3, 10]);
    });

    it('picks up where a previous partial return left off, so the two never overlap (C1)', async () => {
      const deps = createService();
      // 5 base already returned — those came off the box line, leaving 5 more
      // box-priced units then the 3 strip-priced ones.
      setupSplitPriceReturn(deps, splitPriceSale(), { '1': 5 });

      await deps.svc.createReturn({
        original_transaction_id: 1,
        items: [{ batch_id: 1, unit_type: 'child', quantity: 8 }],
      }, 1);

      // 5 remaining box-line strips @ floor(800/10)=80 => 400, plus 3 @ 90 => 270.
      expect(deps.txnRepo.insert.mock.calls[0][0].total_amount).toBe(670);
    });

    // ─── C5: restoring a hard-deleted batch must not fabricate a far-future expiry ───
    it('falls back to today\'s date (not 2099-12-31) when a deleted batch\'s original expiry cannot be recovered (C5)', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      // Batch was hard-deleted — getById returns undefined, forcing the
      // reconstruct-from-audit-log path. No matching DELETE_BATCH audit row
      // exists (base.getOne default mock resolves undefined), so
      // getDeletedBatchExpiry can't recover the real expiry.
      deps.batchRepo.getById.mockResolvedValue(undefined);

      await deps.svc.createReturn(returnInput, 1);

      expect(deps.batchRepo.restoreDeletedBatch).toHaveBeenCalledWith(
        expect.objectContaining({ expiry_date: todayLocalISO() })
      );
      expect(deps.batchRepo.restoreDeletedBatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ expiry_date: '2099-12-31' })
      );
    });

    it('throws on optimistic lock failure during return', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(false);
      await expect(deps.svc.createReturn(returnInput, 1)).rejects.toThrow(ConflictError);
    });

    it('uses payment_method cash for returns', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      await deps.svc.createReturn(returnInput, 1);
      expect(deps.txnRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ payment_method: 'cash' })
      );
    });

    it('emits transaction:created for return', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      await deps.svc.createReturn(returnInput, 1);
      expect(deps.bus.emit).toHaveBeenCalledWith('transaction:created', expect.objectContaining({
        transactionType: 'return',
      }));
    });

    it('throws when no items in return', async () => {
      const deps = createService();
      await expect(deps.svc.createReturn({
        original_transaction_id: 1, items: [],
      }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws when item not found in original transaction', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      await expect(deps.svc.createReturn({
        original_transaction_id: 1,
        items: [{ batch_id: 999, unit_type: 'parent', quantity: 1 }],
      }, 1)).rejects.toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // voidTransaction
  // ═══════════════════════════════════════════════════════════════════════════
  describe('voidTransaction', () => {
    // sampleTransaction.created_at is a fixed fixture date, long outside any
    // void window relative to the real clock — these tests aren't about the
    // window check, so they use a transaction created "just now".
    const recentTxn = { ...sampleTransaction, created_at: new Date().toISOString() };

    it('voids a sale and restores stock', async () => {
      const deps = createService();
      const txn = { ...recentTxn };
      deps.txnRepo.getById
        .mockResolvedValueOnce(txn)
        .mockResolvedValue({ ...txn, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 180 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      const result = await deps.svc.voidTransaction(1, 'wrong sale', 1);
      // 180 + 20 = 200 restored
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 200, 'active', 1
      );
      expect(deps.txnRepo.markVoided).toHaveBeenCalledWith(1, 'wrong sale', 1);
    });

    it('voids a sale and un-sold_out batch', async () => {
      const deps = createService();
      deps.txnRepo.getById
        .mockResolvedValueOnce(recentTxn)
        .mockResolvedValue({ ...recentTxn, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 0, status: 'sold_out' });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'error', 1);
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 20, 'active', 1
      );
    });

    it('voids a return and re-deducts stock', async () => {
      const deps = createService();
      const returnTxn = {
        ...recentTxn, transaction_type: 'return' as const,
        items: [{ ...sampleTransaction.items![0] }],
      };
      deps.txnRepo.getById
        .mockResolvedValueOnce(returnTxn)
        .mockResolvedValue({ ...returnTxn, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 200 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'return error', 1);
      // 200 - 20 = 180
      expect(deps.batchRepo.updateQuantityOptimistic).toHaveBeenCalledWith(
        1, 180, expect.any(String), 1
      );
    });

    it('throws when return void has insufficient stock', async () => {
      const deps = createService();
      const returnTxn = {
        ...recentTxn, transaction_type: 'return' as const,
      };
      deps.txnRepo.getById.mockResolvedValue(returnTxn);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 5 }); // only 5, need 20
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(ValidationError);
    });

    it('throws on already voided', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue({ ...recentTxn, is_voided: 1 });
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(ValidationError);
    });

    it('throws on not found', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue(undefined);
      await expect(deps.svc.voidTransaction(999, 'x', 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError on optimistic lock failure', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue(recentTxn);
      deps.batchRepo.getById.mockResolvedValue(sampleBatch);
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(false);
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(ConflictError);
    });

    it('emits entity:mutated on void', async () => {
      const deps = createService();
      deps.txnRepo.getById
        .mockResolvedValueOnce(recentTxn)
        .mockResolvedValue({ ...recentTxn, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue(sampleBatch);
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'mistake', 1);
      expect(deps.bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'VOID_TRANSACTION',
      }));
    });

    // ─── C2: refuse to void a sale with live returns ────────────────────
    it('refuses to void a sale that has active returns (C2)', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue({
        ...recentTxn,
        returns: [{ ...sampleTransaction, id: 2, transaction_number: 'RTN-001', transaction_type: 'return' }],
      });
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(BusinessRuleError);
      expect(deps.txnRepo.markVoided).not.toHaveBeenCalled();
    });

    it('allows voiding a sale whose only returns are already voided', async () => {
      const deps = createService();
      deps.txnRepo.getById
        .mockResolvedValueOnce({ ...recentTxn, returns: [] })
        .mockResolvedValue({ ...recentTxn, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 180 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'x', 1);
      expect(deps.txnRepo.markVoided).toHaveBeenCalled();
    });

    // ─── A4: closed-shift write protection ──────────────────────────────
    it('blocks voiding a transaction from a closed shift for a non-admin (A4)', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue(recentTxn); // shift_id: 1
      deps.shiftRepo.getById.mockResolvedValue({ ...sampleShift, status: 'closed' });
      await expect(deps.svc.voidTransaction(1, 'x', 1, false, 'cashier')).rejects.toThrow(BusinessRuleError);
      expect(deps.txnRepo.markVoided).not.toHaveBeenCalled();
    });

    it('allows an admin to void a transaction from a closed shift, flagging the override', async () => {
      const deps = createService();
      deps.txnRepo.getById
        .mockResolvedValueOnce(recentTxn)
        .mockResolvedValue({ ...recentTxn, is_voided: 1 });
      deps.shiftRepo.getById.mockResolvedValue({ ...sampleShift, status: 'closed' });
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 180 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'correction', 1, false, 'admin');
      expect(deps.txnRepo.markVoided).toHaveBeenCalled();
      expect(deps.bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'VOID_TRANSACTION',
        newValues: expect.objectContaining({ closedShiftOverride: true }),
      }));
    });

    // ─── Void time window ─────────────────────────────────────────────
    it('blocks voiding a transaction outside the void window for a non-admin', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue(sampleTransaction); // old fixture date
      await expect(deps.svc.voidTransaction(1, 'x', 1, false, 'cashier')).rejects.toThrow(ValidationError);
      expect(deps.txnRepo.markVoided).not.toHaveBeenCalled();
    });

    it('allows an admin to void a transaction outside the void window, flagging the override', async () => {
      const deps = createService();
      deps.txnRepo.getById
        .mockResolvedValueOnce(sampleTransaction) // old fixture date
        .mockResolvedValue({ ...sampleTransaction, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 180 });
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'late correction', 1, false, 'admin');
      expect(deps.txnRepo.markVoided).toHaveBeenCalled();
      expect(deps.bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'VOID_TRANSACTION',
        newValues: expect.objectContaining({ windowOverride: true }),
      }));
    });
  });
});
