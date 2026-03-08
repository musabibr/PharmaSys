import { TransactionService } from '@core/services/transaction.service';
import { ValidationError, NotFoundError, ConflictError } from '@core/types/errors';
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
      // Already returned all 20 base units
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({ '1_parent': 20 });
      await expect(deps.svc.createReturn(returnInput, 1)).rejects.toThrow(ValidationError);
    });

    it('uses compound key batchId_unitType for returned quantities', async () => {
      const deps = createService();
      setupReturnScenario(deps);
      // 10 base units already returned under key '1_parent'; original was 1 parent = 20 base
      // remaining = 20 - 10 = 10 base; returning 1 parent = 20 base > 10 base → should throw
      deps.txnRepo.getReturnedQuantities.mockResolvedValue({ '1_parent': 10 });
      await expect(deps.svc.createReturn({
        ...returnInput,
        items: [{ batch_id: 1, unit_type: 'parent', quantity: 1 }],
      }, 1)).rejects.toThrow(ValidationError);
      expect(deps.batchRepo.updateQuantityOptimistic).not.toHaveBeenCalled();
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
    it('voids a sale and restores stock', async () => {
      const deps = createService();
      const txn = { ...sampleTransaction };
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
        .mockResolvedValueOnce(sampleTransaction)
        .mockResolvedValue({ ...sampleTransaction, is_voided: 1 });
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
        ...sampleTransaction, transaction_type: 'return' as const,
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
        ...sampleTransaction, transaction_type: 'return' as const,
      };
      deps.txnRepo.getById.mockResolvedValue(returnTxn);
      deps.batchRepo.getById.mockResolvedValue({ ...sampleBatch, quantity_base: 5 }); // only 5, need 20
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(ValidationError);
    });

    it('throws on already voided', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue({ ...sampleTransaction, is_voided: 1 });
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(ValidationError);
    });

    it('throws on not found', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue(undefined);
      await expect(deps.svc.voidTransaction(999, 'x', 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError on optimistic lock failure', async () => {
      const deps = createService();
      deps.txnRepo.getById.mockResolvedValue(sampleTransaction);
      deps.batchRepo.getById.mockResolvedValue(sampleBatch);
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(false);
      await expect(deps.svc.voidTransaction(1, 'x', 1)).rejects.toThrow(ConflictError);
    });

    it('emits entity:mutated on void', async () => {
      const deps = createService();
      deps.txnRepo.getById
        .mockResolvedValueOnce(sampleTransaction)
        .mockResolvedValue({ ...sampleTransaction, is_voided: 1 });
      deps.batchRepo.getById.mockResolvedValue(sampleBatch);
      deps.batchRepo.updateQuantityOptimistic.mockResolvedValue(true);
      await deps.svc.voidTransaction(1, 'mistake', 1);
      expect(deps.bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'VOID_TRANSACTION',
      }));
    });
  });
});
