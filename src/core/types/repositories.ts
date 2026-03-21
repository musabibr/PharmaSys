/**
 * Repository interfaces — one per domain.
 * Repositories are pure data access: SQL in, typed objects out.
 * No business logic, no cross-domain calls, no event emission.
 *
 * All methods are async (Promise-returning) to support both synchronous
 * backends (sql.js) and asynchronous backends (PostgreSQL).
 */

import type {
  User, UserPublic, Category, Product, Batch, BatchStatus,
  Transaction, TransactionItem, TransactionFilters,
  Shift, ShiftFilters, ShiftExpectedCash, ShiftReport,
  Expense, ExpenseCategory, CashDrop, ExpenseFilters,
  HeldSale, InventoryAdjustment, AdjustmentFilters, AdjustmentType,
  AuditLog, AuditLogFilters, Setting,
  CashFlowReport, ProfitLossReport,
  ReorderRecommendation, DeadCapitalItem,
  InventoryValuationResult, InventoryValuationFilters,
  DashboardStats, ReturnedQuantityMap,
  BatchFilters, ProductFilters, PaginatedResult,
  CreateUserInput, UpdateUserInput,
  CreateProductInput, UpdateProductInput,
  CreateBatchInput, UpdateBatchInput,
  CreateExpenseInput, CreateCashDropInput,
  BulkCreateProductInput,
  Supplier, CreateSupplierInput, UpdateSupplierInput,
  Purchase, PurchaseItem, PurchasePayment, PurchaseFilters,
  PurchasePaymentStatus, AgingPayment, UpcomingPayment,
  UpdatePurchaseInput,
} from './models';

// ─── Run result (mirrors sql.js semantics) ───

export interface RunResult {
  lastInsertRowid: number;
  changes: number;
}

// ─── Base ───

export interface IBaseRepository {
  getOne<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  runImmediate(sql: string, params?: unknown[]): Promise<RunResult>;
  inTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Run an INSERT and return the new row's ID. Abstracts last_insert_rowid(). */
  runReturningId(sql: string, params?: unknown[]): Promise<number>;
  /** Run an UPDATE/DELETE and return the number of affected rows. Abstracts changes(). */
  runAndGetChanges(sql: string, params?: unknown[]): Promise<number>;
}

// ─── Auth ───

export interface AuthenticateResult {
  success: boolean;
  user?: UserPublic & { must_change_password: number };
  error?: string;
  locked?: boolean;
  lockedUntil?: string;
}

export interface IAuthRepository {
  findByUsername(username: string): Promise<User | undefined>;
  incrementFailedAttempts(userId: number, newCount: number): Promise<void>;
  lockAccount(userId: number, lockedUntil: string, attempts: number): Promise<void>;
  resetFailedAttempts(userId: number): Promise<void>;
  updatePassword(userId: number, hash: string, mustChange?: boolean): Promise<void>;
  isFirstLaunch(): Promise<boolean>;
  getSecurityQuestion(username: string): Promise<{ question: string | null }>;
  findForSecurityReset(username: string): Promise<User | undefined>;
  updateSecurityAnswerAttempts(userId: number, attempts: number, lockedUntil?: string | null): Promise<void>;
  setSecurityQuestion(userId: number, question: string, answerHash: string): Promise<void>;
  clearSecurityAnswerLock(userId: number): Promise<void>;
  unlockAccount(userId: number): Promise<void>;
}

// ─── User ───

export interface IUserRepository {
  getAll(): Promise<UserPublic[]>;
  getById(id: number): Promise<UserPublic | undefined>;
  getFullById(id: number): Promise<User | undefined>;
  create(data: CreateUserInput & { password_hash: string }): Promise<RunResult>;
  update(id: number, data: UpdateUserInput & { password_hash?: string }): Promise<void>;
  resetPassword(userId: number, hash: string): Promise<void>;
  unlock(userId: number): Promise<void>;
  findByUsername(username: string): Promise<User | undefined>;
}

// ─── Category ───

export interface ICategoryRepository {
  getAll(): Promise<Category[]>;
  getById(id: number): Promise<Category | undefined>;
  findByName(name: string): Promise<Category | undefined>;
  create(name: string): Promise<RunResult>;
  update(id: number, name: string): Promise<void>;
}

// ─── Product ───

export interface IProductRepository {
  getAll(search?: string): Promise<Product[]>;
  getList(filters: ProductFilters): Promise<PaginatedResult<Product>>;
  getById(id: number): Promise<Product | undefined>;
  search(query: string): Promise<Product[]>;
  findByName(name: string): Promise<Product | undefined>;
  findByBarcode(barcode: string): Promise<Product | undefined>;
  create(data: CreateProductInput, categoryId: number | null): Promise<RunResult>;
  update(id: number, data: UpdateProductInput): Promise<void>;
  softDelete(id: number): Promise<void>;
  hasActiveBatches(id: number): Promise<boolean>;
  bulkCreate(items: BulkCreateProductInput[]): Promise<Array<{ success: boolean; name: string; error?: string }>>;
}

// ─── Batch ───

export interface IFIFOBatch {
  id: number;
  product_id: number;
  quantity_base: number;
  expiry_date: string;
  cost_per_parent: number;
  cost_per_child: number | null;
  cost_per_child_override: number;
  selling_price_parent: number;
  selling_price_child: number | null;
  selling_price_child_override: number;
  selling_price_parent_override: number;
  status: BatchStatus;
  version: number;
  conversion_factor: number;
}

export interface IBatchRepository {
  getByProduct(productId: number): Promise<Batch[]>;
  getById(id: number): Promise<Batch | undefined>;
  getAvailableByProduct(productId: number): Promise<IFIFOBatch[]>;
  getAll(filters?: BatchFilters): Promise<Batch[]>;
  create(data: CreateBatchInput): Promise<RunResult>;
  update(id: number, data: Partial<UpdateBatchInput>): Promise<void>;
  updateQuantityOptimistic(
    id: number,
    newQuantityBase: number,
    newStatus: BatchStatus,
    expectedVersion: number
  ): Promise<boolean>; // false = optimistic lock conflict
  getExpiring(days: number): Promise<Batch[]>;
  getExpired(): Promise<Batch[]>;
  insertAdjustment(data: {
    product_id: number;
    batch_id: number;
    quantity_base: number;
    reason: string | null;
    type: AdjustmentType;
    user_id: number;
  }): Promise<RunResult>;
  getAdjustments(filters?: AdjustmentFilters): Promise<InventoryAdjustment[]>;
}

// ─── Transaction ───

export interface ITransactionInsertData {
  transaction_number: string;
  user_id: number;
  shift_id: number | null;
  transaction_type: string;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  payment_method: string;
  bank_name: string | null;
  reference_number: string | null;
  cash_tendered: number;
  payment: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  notes: string | null;
  parent_transaction_id: number | null;
}

export interface ITransactionItemInsertData {
  transaction_id: number;
  product_id: number;
  batch_id: number;
  quantity_base: number;
  unit_type: string;
  unit_price: number;
  cost_price: number;
  discount_percent: number;
  line_total: number;
  gross_profit: number;
  conversion_factor_snapshot: number;
}

export interface ITransactionRepository {
  getAll(filters: TransactionFilters): Promise<PaginatedResult<Transaction>>;
  getById(id: number): Promise<Transaction | undefined>;
  getItems(transactionId: number): Promise<TransactionItem[]>;
  insert(data: ITransactionInsertData): Promise<number>; // returns new transaction id
  insertItem(data: ITransactionItemInsertData): Promise<void>;
  markVoided(id: number, reason: string, voidedBy: number): Promise<void>;
  getReturnedQuantities(originalTransactionId: number): Promise<ReturnedQuantityMap>;
  getNextNumber(prefix: string): Promise<string>;
}

// ─── Shift ───

export interface IShiftRepository {
  getCurrent(userId: number): Promise<Shift | undefined>;
  getById(id: number): Promise<Shift | undefined>;
  getAll(filters: ShiftFilters): Promise<PaginatedResult<Shift>>;
  open(userId: number, openingAmount: number): Promise<RunResult>;
  close(id: number, data: {
    expected_cash: number;
    actual_cash: number;
    variance: number;
    variance_type: string;
    notes: string | null;
  }): Promise<void>;
  getExpectedCash(shiftId: number): Promise<ShiftExpectedCash>;
  getReport(shiftId: number): Promise<ShiftReport | undefined>;
  getLastClosedCash(userId: number): Promise<number>;
  findOpenByUser(userId: number): Promise<Shift | undefined>;
}

// ─── Expense ───

export interface IExpenseRepository {
  getCategories(): Promise<ExpenseCategory[]>;
  getCategoryById(id: number): Promise<ExpenseCategory | undefined>;
  createCategory(name: string): Promise<RunResult>;
  getById(id: number): Promise<Expense | undefined>;
  getAll(filters: ExpenseFilters): Promise<PaginatedResult<Expense>>;
  create(data: CreateExpenseInput, userId: number, shiftId: number | null): Promise<RunResult>;
  delete(id: number): Promise<void>;
  getCashDropById(id: number): Promise<CashDrop | undefined>;
  createCashDrop(data: CreateCashDropInput, userId: number, shiftId: number): Promise<RunResult>;
  getCashDrops(shiftId: number): Promise<CashDrop[]>;
}

// ─── Held Sale ───

export interface IHeldSaleRepository {
  getAll(userId: number): Promise<HeldSale[]>;
  save(data: { user_id: number; customer_note: string | null; items_json: string; total_amount: number }): Promise<RunResult>;
  delete(id: number): Promise<void>;
}

// ─── Report ───

export interface IReportRepository {
  getCashFlow(startDate: string, endDate: string): Promise<CashFlowReport>;
  getProfitLoss(startDate: string, endDate: string): Promise<ProfitLossReport>;
  getReorderRecommendations(): Promise<ReorderRecommendation[]>;
  getDeadCapital(daysThreshold: number): Promise<DeadCapitalItem[]>;
  getInventoryValuation(filters: InventoryValuationFilters): Promise<InventoryValuationResult>;
  getDashboardStats(): Promise<DashboardStats>;
}

// ─── Audit ───

export interface IAuditRepository {
  log(
    userId: number | null,
    action: string,
    tableName: string | null,
    recordId: number | null,
    oldValues?: Record<string, unknown> | null,
    newValues?: Record<string, unknown> | null
  ): Promise<void>;
  getAll(filters: AuditLogFilters): Promise<PaginatedResult<AuditLog>>;
  purgeOlderThan(days: number): Promise<number>;
}

// ─── Settings ───

export interface ISettingsRepository {
  get(key: string): Promise<string | null>;
  getAll(): Promise<Setting[]>;
  set(key: string, value: string): Promise<void>;
}

// ─── Backup ───

export interface BackupEntry {
  filename: string;
  path: string;
  size: number;
  created_at: string;
}

export interface IBackupRepository {
  create(label?: string): Promise<BackupEntry>;
  list(): Promise<BackupEntry[]>;
  restore(filename: string): Promise<void>;
}

// ─── Supplier ───

export interface ISupplierRepository {
  getAll(includeInactive?: boolean): Promise<Supplier[]>;
  getById(id: number): Promise<Supplier | undefined>;
  create(data: CreateSupplierInput): Promise<RunResult>;
  update(id: number, data: UpdateSupplierInput): Promise<void>;
}

// ─── Purchase ───

export interface IPurchaseRepository {
  getAll(filters: PurchaseFilters): Promise<PaginatedResult<Purchase>>;
  getById(id: number): Promise<Purchase | undefined>;
  getItems(purchaseId: number): Promise<PurchaseItem[]>;
  getPayments(purchaseId: number): Promise<PurchasePayment[]>;
  insert(data: {
    purchase_number: string;
    supplier_id: number | null;
    invoice_reference: string | null;
    purchase_date: string;
    total_amount: number;
    total_paid: number;
    payment_status: PurchasePaymentStatus;
    alert_days_before: number;
    notes: string | null;
    user_id: number;
  }): Promise<number>;
  insertItem(data: {
    purchase_id: number;
    product_id: number;
    batch_id: number | null;
    quantity_received: number;
    cost_per_parent: number;
    selling_price_parent: number;
    line_total: number;
    expiry_date: string | null;
    batch_number: string | null;
  }): Promise<number>;
  insertPayment(data: {
    purchase_id: number;
    due_date: string;
    amount: number;
    is_paid: number;
    paid_date: string | null;
    payment_method: string | null;
    expense_id: number | null;
    paid_by_user_id: number | null;
  }): Promise<number>;
  markPaymentPaid(
    paymentId: number,
    paidDate: string,
    paymentMethod: string,
    expenseId: number,
    userId: number,
  ): Promise<void>;
  updateTotals(
    purchaseId: number,
    totalPaid: number,
    status: PurchasePaymentStatus,
  ): Promise<void>;
  getPaymentById(paymentId: number): Promise<PurchasePayment | undefined>;
  getPaidTotal(purchaseId: number): Promise<number>;
  getNextNumber(datePrefix: string): Promise<string>;
  update(id: number, data: UpdatePurchaseInput): Promise<void>;
  delete(id: number): Promise<void>;
  hasPaidPayments(id: number): Promise<boolean>;
  getAgingPayments(): Promise<AgingPayment[]>;
  getOverdueSummary(): Promise<{ count: number; total: number }>;
  getUpcomingPayments(): Promise<UpcomingPayment[]>;
  getUpcomingSummary(): Promise<{ count: number; total: number }>;
}
