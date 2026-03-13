/**
 * Shared mock factories for service unit tests.
 * Each factory returns a mocked repository/dependency with jest.fn() stubs.
 *
 * All mock methods use mockResolvedValue() since repository methods are now async.
 */

import { EventBus } from '@core/events/event-bus';
import type { UserPublic, User, Category, Product, Batch, Transaction, TransactionItem, Shift, Expense, ExpenseCategory, CashDrop, HeldSale, ShiftExpectedCash, ShiftReport, PaginatedResult, ReturnedQuantityMap, Setting, AuditLog } from '@core/types/models';
import type { IFIFOBatch, RunResult, BackupEntry } from '@core/types/repositories';

// ─── Event Bus ────────────────────────────────────────────────────────────────

export function createMockBus(): EventBus {
  const bus = new EventBus();
  // Spy on emit for assertions
  jest.spyOn(bus, 'emit');
  return bus;
}

// ─── Run result helper ────────────────────────────────────────────────────────

export function runResult(lastId = 1): RunResult {
  return { changes: 1, lastInsertRowid: lastId };
}

// ─── User fixtures ────────────────────────────────────────────────────────────

export const adminUserPublic: UserPublic = {
  id: 1, username: 'admin', full_name: 'Admin', role: 'admin',
  perm_finance: 1, perm_inventory: 1, perm_reports: 1,
  permissions_json: null,
  is_active: 1, must_change_password: 0,
  created_at: '2026-01-01', updated_at: '2026-01-01',
};

// Hashed with scrypt: 'admin123' → salt:hash
// For tests, we create a real hash
import * as crypto from 'crypto';
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('admin123', salt, 64).toString('hex');
export const admin123Hash = `${salt}:${hash}`;

const secureSalt = crypto.randomBytes(16).toString('hex');
const secureHash = crypto.scryptSync('newPass123', secureSalt, 64).toString('hex');
export const newPass123Hash = `${secureSalt}:${secureHash}`;

// Full user record
export const adminUser: User = {
  ...adminUserPublic,
  password_hash: admin123Hash,
  failed_login_attempts: 0,
  locked_until: null,
  security_question: null,
  security_answer_hash: null,
  security_answer_failed_attempts: 0,
  security_answer_locked_until: null,
};

export const lockedUser: User = {
  ...adminUser,
  id: 2, username: 'locked_user',
  locked_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  failed_login_attempts: 5,
};

const secAnswerSalt = crypto.randomBytes(16).toString('hex');
const secAnswerHash = crypto.scryptSync('fluffy', secAnswerSalt, 64).toString('hex');
export const securityUser: User = {
  ...adminUser,
  id: 3, username: 'sec_user',
  security_question: "What is your pet's name?",
  security_answer_hash: `${secAnswerSalt}:${secAnswerHash}`,
};

// ─── Mock Auth Repository ─────────────────────────────────────────────────────

export function createMockAuthRepo() {
  return {
    findByUsername: jest.fn().mockResolvedValue(undefined),
    incrementFailedAttempts: jest.fn().mockResolvedValue(undefined),
    lockAccount: jest.fn().mockResolvedValue(undefined),
    resetFailedAttempts: jest.fn().mockResolvedValue(undefined),
    updatePassword: jest.fn().mockResolvedValue(undefined),
    isFirstLaunch: jest.fn().mockResolvedValue(false),
    getSecurityQuestion: jest.fn().mockResolvedValue({ question: null }),
    findForSecurityReset: jest.fn().mockResolvedValue(undefined),
    updateSecurityAnswerAttempts: jest.fn().mockResolvedValue(undefined),
    setSecurityQuestion: jest.fn().mockResolvedValue(undefined),
    clearSecurityAnswerLock: jest.fn().mockResolvedValue(undefined),
    unlockAccount: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock User Repository ─────────────────────────────────────────────────────

export function createMockUserRepo() {
  return {
    getAll: jest.fn().mockResolvedValue([adminUserPublic]),
    getById: jest.fn().mockResolvedValue(adminUserPublic),
    getFullById: jest.fn().mockResolvedValue(undefined),
    findByUsername: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(runResult(10)),
    update: jest.fn().mockResolvedValue(undefined),
    resetPassword: jest.fn().mockResolvedValue(undefined),
    unlock: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Category Repository ─────────────────────────────────────────────────

export function createMockCategoryRepo() {
  return {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(undefined),
    findByName: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(runResult(1)),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Product Repository ──────────────────────────────────────────────────

export function createMockProductRepo() {
  return {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    findByName: jest.fn().mockResolvedValue(undefined),
    findByBarcode: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(runResult(1)),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    getList: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
    bulkCreate: jest.fn().mockResolvedValue([]),
    hasActiveBatches: jest.fn().mockResolvedValue(false),
    softDelete: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Batch Repository ────────────────────────────────────────────────────

export function createMockBatchRepo() {
  return {
    getByProduct: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(undefined),
    getAvailableByProduct: jest.fn().mockResolvedValue([]),
    getAll: jest.fn().mockResolvedValue([]),
    getAllAvailable: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(runResult(1)),
    update: jest.fn().mockResolvedValue(undefined),
    updateQuantityOptimistic: jest.fn().mockResolvedValue(true),
    getExpiring: jest.fn().mockResolvedValue([]),
    getExpired: jest.fn().mockResolvedValue([]),
    insertAdjustment: jest.fn().mockResolvedValue(runResult(1)),
    getAdjustments: jest.fn().mockResolvedValue([]),
  };
}

// ─── Mock Transaction Repository ──────────────────────────────────────────────

export function createMockTransactionRepo() {
  return {
    getAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getById: jest.fn().mockResolvedValue(undefined),
    getItems: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(1),
    insertItem: jest.fn().mockResolvedValue(undefined),
    markVoided: jest.fn().mockResolvedValue(undefined),
    getReturnedQuantities: jest.fn().mockResolvedValue({}),
    getNextNumber: jest.fn().mockResolvedValue('TXN-20260225-0001'),
  };
}

// ─── Mock Shift Repository ────────────────────────────────────────────────────

export function createMockShiftRepo() {
  return {
    getCurrent: jest.fn().mockResolvedValue(undefined),
    findOpenByUser: jest.fn().mockResolvedValue(undefined),
    getById: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
    open: jest.fn().mockResolvedValue(runResult(1)),
    close: jest.fn().mockResolvedValue(undefined),
    getExpectedCash: jest.fn().mockResolvedValue({
      opening_amount: 0, total_cash_sales: 0, total_cash_returns: 0,
      total_cash_expenses: 0, total_cash_drops: 0, expected_cash: 0,
    } as ShiftExpectedCash),
    getReport: jest.fn().mockResolvedValue(undefined),
    getLastClosedCash: jest.fn().mockResolvedValue(0),
    getLastNShiftIds: jest.fn().mockResolvedValue([1, 2]),
  };
}

// ─── Mock Expense Repository ──────────────────────────────────────────────────

export function createMockExpenseRepo() {
  return {
    getCategories: jest.fn().mockResolvedValue([]),
    createCategory: jest.fn().mockResolvedValue(runResult(1)),
    getAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
    getById: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(runResult(1)),
    delete: jest.fn().mockResolvedValue(undefined),
    getCashDrops: jest.fn().mockResolvedValue([]),
    getCashDropById: jest.fn().mockResolvedValue(undefined),
    createCashDrop: jest.fn().mockResolvedValue(runResult(1)),
    getCategoryById: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Held Sale Repository ────────────────────────────────────────────────

export function createMockHeldSaleRepo() {
  return {
    getAll: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(runResult(1)),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Report Repository ──────────────────────────────────────────────────

export function createMockReportRepo() {
  return {
    getCashFlow: jest.fn().mockResolvedValue(undefined),
    getProfitLoss: jest.fn().mockResolvedValue(undefined),
    getReorderRecommendations: jest.fn().mockResolvedValue([]),
    getDeadCapital: jest.fn().mockResolvedValue([]),
    getInventoryValuation: jest.fn().mockResolvedValue(undefined),
    getDashboardStats: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Audit Repository ────────────────────────────────────────────────────

export function createMockAuditRepo() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
    purgeOlderThan: jest.fn().mockResolvedValue(0),
  };
}

// ─── Mock Settings Repository ─────────────────────────────────────────────────

export function createMockSettingsRepo() {
  return {
    get: jest.fn().mockResolvedValue(null),
    getAll: jest.fn().mockResolvedValue([]),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Backup Repository ──────────────────────────────────────────────────

export function createMockBackupRepo() {
  return {
    create: jest.fn().mockResolvedValue({ filename: 'backup-2026.db', size: 1024, createdAt: '2026-01-01' }),
    list: jest.fn().mockResolvedValue([]),
    restore: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Base Repository ─────────────────────────────────────────────────────

export function createMockBaseRepo() {
  return {
    getOne: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(runResult()),
    runImmediate: jest.fn().mockResolvedValue(runResult()),
    rawRun: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(),
    db: { run: jest.fn(), exec: jest.fn().mockReturnValue([]) },
    inTransaction: jest.fn().mockImplementation(async (fn: () => Promise<any>) => fn()),
  };
}

// ─── Mock Supplier Repository ────────────────────────────────────────────────

export function createMockSupplierRepo() {
  return {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(runResult(1)),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Purchase Repository ────────────────────────────────────────────────

export function createMockPurchaseRepo() {
  return {
    getAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getById: jest.fn().mockResolvedValue(undefined),
    getItems: jest.fn().mockResolvedValue([]),
    getPayments: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(1),
    insertItem: jest.fn().mockResolvedValue(1),
    insertPayment: jest.fn().mockResolvedValue(1),
    markPaymentPaid: jest.fn().mockResolvedValue(undefined),
    updateTotals: jest.fn().mockResolvedValue(undefined),
    getPaymentById: jest.fn().mockResolvedValue(undefined),
    getPaidTotal: jest.fn().mockResolvedValue(0),
    getNextNumber: jest.fn().mockResolvedValue('PUR-20260302-001'),
    getAgingPayments: jest.fn().mockResolvedValue([]),
    getOverdueSummary: jest.fn().mockResolvedValue({ count: 0, total: 0 }),
    getUpcomingPayments: jest.fn().mockResolvedValue([]),
    getUpcomingSummary: jest.fn().mockResolvedValue({ count: 0, total: 0 }),
    getUnpaidPayments: jest.fn().mockResolvedValue([]),
    updatePaymentAmount: jest.fn().mockResolvedValue(undefined),
    updateTotalAmount: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Product fixture ──────────────────────────────────────────────────────────

export const sampleProduct: Product = {
  id: 1, name: 'Paracetamol', generic_name: 'Acetaminophen',
  usage_instructions: null,
  category_id: 1, category_name: 'Painkillers',
  barcode: '1234567890', parent_unit: 'Box', child_unit: 'Tablet',
  conversion_factor: 20, min_stock_level: 10, is_active: 1,
  created_at: '2026-01-01', updated_at: '2026-01-01',
};

// ─── Batch fixture ────────────────────────────────────────────────────────────

export const sampleBatch: Batch = {
  id: 1, product_id: 1, batch_number: 'B001',
  expiry_date: '2027-12-31', quantity_base: 200,
  cost_per_parent: 500, cost_per_child: 25,
  cost_per_child_override: 25,
  selling_price_parent: 800, selling_price_child: 40,
  selling_price_parent_override: 800,
  selling_price_child_override: 40,
  status: 'active', version: 1,
  created_at: '2026-01-01', updated_at: '2026-01-01',
  product_name: 'Paracetamol', parent_unit: 'Box', child_unit: 'Tablet',
  conversion_factor: 20,
};

export const sampleFIFOBatch: IFIFOBatch = {
  id: 1, product_id: 1, quantity_base: 200,
  expiry_date: '2027-12-31',
  cost_per_parent: 500, cost_per_child: 25,
  cost_per_child_override: 25,
  selling_price_parent: 800, selling_price_child: 40,
  selling_price_parent_override: 800,
  selling_price_child_override: 40,
  status: 'active', version: 1,
  conversion_factor: 20,
};

// ─── Transaction fixture ──────────────────────────────────────────────────────

export const sampleTransaction: Transaction = {
  id: 1, transaction_number: 'TXN-20260225-0001',
  user_id: 1, shift_id: 1, transaction_type: 'sale',
  subtotal: 800, discount_amount: 0, tax_amount: 0, total_amount: 800,
  payment_method: 'cash', bank_name: null, reference_number: null,
  cash_tendered: 1000, payment: null,
  customer_name: null, customer_phone: null, notes: null,
  is_voided: 0, void_reason: null, voided_by: null, voided_at: null,
  parent_transaction_id: null,
  created_at: '2026-02-25 10:00:00',
  items: [{
    id: 1, transaction_id: 1, product_id: 1, batch_id: 1,
    quantity_base: 20, unit_type: 'parent', unit_price: 800,
    cost_price: 500, discount_percent: 0,
    line_total: 800, gross_profit: 300,
    conversion_factor_snapshot: 20, created_at: '2026-02-25',
    product_name: 'Paracetamol', batch_number: 'B001',
  }],
};

export const sampleShift: Shift = {
  id: 1, user_id: 1, opened_at: '2026-02-25 08:00:00',
  closed_at: null, opening_amount: 500,
  expected_cash: null, actual_cash: null,
  variance: null, variance_type: null, notes: null,
  status: 'open', username: 'admin',
};
