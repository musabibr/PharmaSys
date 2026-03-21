// ─── Domain types (public-facing subset from core/types/models.ts) ──────────
// These are duplicated from the backend to decouple the Vite build pipeline.

export type UserRole = 'admin' | 'pharmacist' | 'cashier';
export type BatchStatus = 'active' | 'quarantine' | 'sold_out';
export type TransactionType = 'sale' | 'return' | 'void';
export type PaymentMethod = 'cash' | 'bank_transfer' | 'mixed';
export type ShiftStatus = 'open' | 'closed';
export type AdjustmentType = 'damage' | 'expiry' | 'correction';

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  perm_finance: number;
  perm_inventory: number;
  perm_reports: number;
  permissions_json: string | null;
  is_active: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
}

export interface Product {
  id: number;
  name: string;
  generic_name: string | null;
  category_id: number;
  category_name?: string;
  barcode: string | null;
  parent_unit: string;
  child_unit: string;
  conversion_factor: number;
  min_stock_level: number;
  usage_instructions: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  total_stock_base?: number;
  /** Effective parent selling price from FIFO batch (override > base) */
  selling_price?: number;
  /** Effective child selling price from FIFO batch (override > base) */
  selling_price_child?: number;
}

export interface Batch {
  id: number;
  product_id: number;
  product_name?: string;
  batch_number: string | null;
  expiry_date: string;
  quantity_base: number;
  cost_per_parent: number;
  cost_per_child: number | null;
  cost_per_child_override: number;
  selling_price_parent: number | null;
  selling_price_child: number | null;
  selling_price_parent_override: number;
  selling_price_child_override: number;
  status: BatchStatus;
  version: number;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: number;
  transaction_number: string;
  user_id: number;
  username?: string;
  shift_id: number | null;
  transaction_type: TransactionType;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  payment_method: PaymentMethod | null;
  bank_name: string | null;
  reference_number: string | null;
  cash_tendered: number;
  customer_name: string | null;
  customer_phone: string | null;
  notes: string | null;
  parent_transaction_id: number | null;
  is_voided: number;
  voided_at: string | null;
  voided_by: number | null;
  void_reason: string | null;
  created_at: string;
  items?: TransactionItem[];
}

export interface TransactionItem {
  id: number;
  transaction_id: number;
  product_id: number;
  product_name?: string;
  batch_id: number;
  batch_number?: string;
  quantity_base: number;
  unit_type: 'parent' | 'child';
  unit_price: number;
  cost_price: number;
  discount_percent: number;
  line_total: number;
  gross_profit: number;
  parent_unit?: string;
  child_unit?: string;
  /** From product join in getItems() query */
  conversion_factor?: number;
  conversion_factor_snapshot?: number;
}

export interface Shift {
  id: number;
  user_id: number;
  username?: string;
  opening_amount: number;
  actual_cash: number | null;
  expected_cash: number | null;
  variance: number | null;
  variance_type: string | null;
  notes: string | null;
  status: ShiftStatus;
  opened_at: string;
  closed_at: string | null;
}

export interface Expense {
  id: number;
  category_id: number;
  category_name?: string;
  amount: number;
  description: string | null;
  payment_method: string | null;
  expense_date: string;
  user_id: number;
  username?: string;
  shift_id: number | null;
  created_at: string;
}

export interface ExpenseCategory {
  id: number;
  name: string;
}

export interface HeldSale {
  id: number;
  user_id: number;
  username?: string;
  items: unknown; // Parsed array from backend, or JSON string
  customer_note: string | null;
  total_amount: number;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  user_id: number;
  username?: string;
  action: string;
  table_name: string | null;
  record_id: number | null;
  old_values: string | null;
  new_values: string | null;
  created_at: string;
}

// ─── Report types ───────────────────────────────────────────────────────────

export interface CashFlowReport {
  total_sales: number;
  total_returns: number;
  net_sales: number;
  cost_of_goods_sold: number;
  gross_profit: number;
  gross_margin: number;
  operational_expenses: number;
  supplier_payments: number;
  net_profit: number;
  net_margin: number;
  cash_sales: number;
  bank_sales: number;
  cash_returns: number;
  cash_expenses: number;
  bank_expenses: number;
  sales_by_payment: Array<{ payment_method: string; total: number; count: number }>;
}

export interface ProfitLossReport {
  dailyData: Array<{
    date: string;
    sales: number;
    returns: number;
    profit: number;
  }>;
  expensesByCategory: Array<{ category: string; total: number }>;
  topProducts: Array<{ name: string; total_sold: number; revenue: number; profit: number }>;
}

export interface DashboardStats {
  today_sales: number;
  today_returns: number;
  today_net_sales: number;
  today_transactions: number;
  month_sales: number;
  month_returns: number;
  month_net_sales: number;
  month_transactions: number;
  inventory_cost_value: number;
  inventory_retail_value: number;
  low_stock_count: number;
  expiring_soon_count: number;
  expired_count: number;
  open_shifts: number;
}

export interface ReorderRecommendation {
  id: number;
  name: string;
  parent_unit: string;
  child_unit: string;
  conversion_factor: number;
  min_stock_level: number;
  current_stock_base: number;
  daily_velocity_base: number;
  recommended_order: number;
}

export interface DeadCapitalItem {
  id: number;
  name: string;
  parent_unit: string;
  child_unit: string;
  conversion_factor: number;
  last_sold: string | null;
  days_since_sale: number;
  stock_value: number;
  stock_quantity: number;
  oldest_batch_date: string | null;
  days_in_inventory: number;
}

export interface InventoryValuationItem {
  product_id: number;
  name: string;
  category_id: number | null;
  category_name: string | null;
  parent_unit: string;
  child_unit: string;
  conversion_factor: number;
  total_stock_base: number;
  cost_value: number;
  retail_value: number;
  batch_count: number;
}

export interface InventoryValuationResult {
  data: InventoryValuationItem[];
  total: number;
  page: number;
  limit: number;
  total_cost: number;
  total_retail: number;
}

export interface ShiftExpectedCash {
  opening_amount: number;
  total_cash_sales: number;
  total_cash_returns: number;
  total_cash_expenses: number;
  total_cash_drops: number;
  expected_cash: number;
}

export interface AppInfo {
  isDev: boolean;
  isFirstLaunch: boolean;
  version?: string;
  platform?: string;
  arch?: string;
  electronVersion?: string;
  nodeVersion?: string;
}

// ─── Purchase Management ─────────────────────────────────────────────────────

export type PurchasePaymentStatus = 'unpaid' | 'partial' | 'paid';
export type ExpensePaymentMethod = 'cash' | 'bank_transfer';

export interface Supplier {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Purchase {
  id: number;
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
  created_at: string;
  updated_at: string;
  supplier_name?: string;
  username?: string;
  items?: PurchaseItem[];
  payments?: PurchasePayment[];
  pending_items_count?: number;
}

export interface PurchaseItem {
  id: number;
  purchase_id: number;
  product_id: number;
  batch_id: number | null;
  quantity_received: number;
  cost_per_parent: number;
  selling_price_parent: number;
  line_total: number;
  expiry_date: string | null;
  batch_number: string | null;
  notes: string | null;
  created_at: string;
  product_name?: string;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
}

export type PaymentAdjustmentStrategy = 'next' | 'spread' | 'new_installment';

export interface PurchasePayment {
  id: number;
  purchase_id: number;
  due_date: string;
  amount: number;
  paid_amount: number | null;
  is_paid: number;
  paid_date: string | null;
  payment_method: ExpensePaymentMethod | null;
  expense_id: number | null;
  paid_by_user_id: number | null;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  purchase_number?: string;
  supplier_name?: string;
  paid_by_username?: string;
}

export interface CreatePurchaseItemInput {
  product_id?: number;
  new_product?: {
    name: string;
    generic_name?: string;
    usage_instructions?: string;
    category_name?: string;
    barcode?: string;
    parent_unit?: string;
    child_unit?: string;
    conversion_factor?: number;
    min_stock_level?: number;
  };
  quantity: number;
  cost_per_parent: number;
  selling_price_parent: number;
  selling_price_child?: number;
  expiry_date: string;
  batch_number?: string;
}

export interface PurchasePendingItem {
  id: number;
  purchase_id: number;
  raw_data: string;
  notes: string | null;
  created_at: string;
}

export interface EnrichedPendingItem extends PurchasePendingItem {
  purchase_number: string;
  invoice_reference: string | null;
  supplier_name: string | null;
  supplier_id: number | null;
}

export interface CreatePurchaseInput {
  purchase_date: string;
  supplier_id?: number | null;
  invoice_reference?: string | null;
  total_amount: number;
  alert_days_before?: number;
  notes?: string | null;
  items?: CreatePurchaseItemInput[];
  payment_plan: {
    type: 'full' | 'installments';
    payment_method?: ExpensePaymentMethod;
    reference_number?: string;
    installments?: Array<{ due_date: string; amount: number }>;
  };
  initial_payment?: {
    amount: number;
    payment_method: ExpensePaymentMethod;
    reference_number?: string;
  };
  pending_items?: Array<{ raw_data: string; notes?: string }>;
}

export interface PurchaseReport {
  total_purchases: number;
  total_amount: number;
  total_paid: number;
  total_outstanding: number;
  paid_count: number;
  partial_count: number;
  unpaid_count: number;
  purchases: Array<{
    id: number;
    purchase_number: string;
    purchase_date: string;
    supplier_name: string | null;
    invoice_reference: string | null;
    total_amount: number;
    total_paid: number;
    payment_status: string;
    item_count: number;
    created_by: string;
  }>;
}

export interface UpcomingPayment {
  payment_id: number;
  purchase_id: number;
  purchase_number: string;
  supplier_name: string | null;
  invoice_reference: string | null;
  due_date: string;
  amount: number;
  days_until_due: number;
}

export interface AgingPayment {
  payment_id: number;
  purchase_id: number;
  purchase_number: string;
  supplier_name: string | null;
  invoice_reference: string | null;
  due_date: string;
  amount: number;
  days_overdue: number;
  purchase_date: string;
}

export interface ProductMatchResult {
  importedName: string;
  status: 'matched' | 'candidates' | 'new';
  product?: Product;
  candidates?: Product[];
}

// ─── Python PDF parser result ────────────────────────────────────────────────

export interface PythonPdfParsedRow {
  row_number: number;
  name: string;
  generic_name: string;
  code: string;
  expiry_date: string;
  parent_unit: string;
  child_unit: string;
  conversion_factor: number;
  quantity: number;
  cost_per_parent: number;
  line_total: number;
  validation_error: boolean;
}

// ─── API interface matching preload.js exactly ──────────────────────────────

export interface PharmaSysApi {
  auth: {
    login(username: string, password: string): Promise<User | { error: string }>;
    logout(): Promise<void>;
    getCurrentUser(): Promise<(User & { must_change_password: number }) | null>;
    changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }>;
    getSecurityQuestion(username: string): Promise<{ question: string } | null>;
    resetPasswordWithSecurityAnswer(username: string, answer: string, newPassword: string): Promise<{ success: boolean; error?: string }>;
    setSecurityQuestion(question: string, answer: string): Promise<{ success: boolean; error?: string }>;
    onSessionExpired(callback: (data: { reason?: string }) => void): () => void;
  };

  session: {
    trackActivity(): Promise<void>;
    extend(): Promise<void>;
    onWarning(callback: (data: unknown) => void): () => void;
    onExpired(callback: (data: unknown) => void): () => void;
  };

  users: {
    getAll(): Promise<User[]>;
    getById(id: number): Promise<User>;
    create(userData: Partial<User> & { password: string }): Promise<User>;
    update(id: number, data: Partial<User>): Promise<User>;
    resetPassword(userId: number, newPassword: string): Promise<{ success: boolean }>;
    unlockAccount(userId: number): Promise<{ success: boolean }>;
  };

  categories: {
    getAll(): Promise<Category[]>;
    create(name: string): Promise<Category>;
    update(id: number, name: string): Promise<Category>;
  };

  products: {
    getAll(): Promise<Product[]>;
    getList(filters?: ProductFilters): Promise<PaginatedResult<Product>>;
    getById(id: number): Promise<Product>;
    create(productData: Partial<Product>): Promise<Product>;
    update(id: number, data: Partial<Product>): Promise<Product>;
    delete(id: number): Promise<{ success: boolean }>;
    search(query: string): Promise<Product[]>;
    findByBarcode(barcode: string): Promise<Product | null>;
    bulkCreate(items: unknown[]): Promise<{ success: boolean; created: number; errors: unknown[] }>;
  };

  batches: {
    getByProduct(productId: number): Promise<Batch[]>;
    getAvailable(productId: number): Promise<Batch[]>;
    getAllAvailable(filters?: unknown): Promise<Batch[]>;
    create(batchData: Partial<Batch>): Promise<Batch>;
    update(id: number, data: Partial<Batch>): Promise<Batch>;
    getExpiring(days: number): Promise<(Batch & { product_name: string; parent_unit: string; child_unit: string; conversion_factor: number })[]>;
    getExpired(): Promise<Batch[]>;
  };

  inventory: {
    reportDamage(batchId: number, quantity: number, reason: string, type: AdjustmentType): Promise<{ success: boolean }>;
    getAdjustments(filters?: unknown): Promise<unknown[]>;
  };

  cashDrops: {
    create(amount: number, reason: string): Promise<{ success: boolean }>;
    getByShift(shiftId: number): Promise<unknown[]>;
  };

  transactions: {
    create(transactionData: unknown): Promise<Transaction>;
    getAll(filters?: unknown): Promise<PaginatedResult<Transaction>>;
    getById(id: number): Promise<Transaction>;
    void(id: number, reason: string, force?: boolean): Promise<{ success: boolean }>;
    getReturnedQty(originalTxnId: number): Promise<Record<string, number>>;
    createReturn(returnData: unknown): Promise<Transaction>;
  };

  expenses: {
    getCategories(): Promise<ExpenseCategory[]>;
    createCategory(name: string): Promise<ExpenseCategory>;
    updateCategory(id: number, name: string): Promise<ExpenseCategory>;
    deleteCategory(id: number): Promise<{ success: boolean }>;
    getAll(filters?: unknown): Promise<PaginatedResult<Expense>>;
    create(expenseData: Partial<Expense>): Promise<Expense>;
    update(id: number, data: Partial<Expense>): Promise<Expense>;
    delete(id: number): Promise<{ success: boolean }>;
  };

  shifts: {
    open(openingAmount: number): Promise<Shift>;
    getLastCash(): Promise<number | null>;
    getExpectedCash(shiftId: number): Promise<ShiftExpectedCash>;
    close(shiftId: number, actualCash: number, notes?: string): Promise<Shift & { success: boolean }>;
    getCurrent(): Promise<Shift | null>;
    getReport(shiftId: number): Promise<unknown>;
    getAll(filters?: unknown): Promise<PaginatedResult<Shift>>;
    forceClose(shiftId: number, actualCash: number, notes?: string): Promise<Shift & { success: boolean }>;
  };

  held: {
    save(items: unknown[], customerNote?: string): Promise<{ success: boolean }>;
    getAll(): Promise<HeldSale[]>;
    delete(id: number): Promise<{ success: boolean }>;
  };

  reports: {
    cashFlow(startDate: string, endDate: string): Promise<CashFlowReport>;
    profitLoss(startDate: string, endDate: string): Promise<ProfitLossReport>;
    reorderRecommendations(): Promise<ReorderRecommendation[]>;
    deadCapital(days: number): Promise<DeadCapitalItem[]>;
    inventoryValuation(filters?: unknown): Promise<InventoryValuationResult>;
    purchaseReport(startDate: string, endDate: string, supplierId?: number, paymentStatus?: string): Promise<PurchaseReport>;
  };

  dashboard: {
    stats(): Promise<DashboardStats>;
  };

  audit: {
    getAll(filters?: unknown): Promise<PaginatedResult<AuditEntry>>;
  };

  settings: {
    get(key: string): Promise<string | null>;
    getAll(): Promise<Record<string, string>>;
    set(key: string, value: string): Promise<{ success: boolean }>;
  };

  backup: {
    create(): Promise<{ success: boolean; filename: string; path: string }>;
    list(): Promise<Array<{ filename: string; size: number; created_at: string }>>;
    restore(filename: string): Promise<{ success: boolean }>;
    saveAs(sourcePath: string): Promise<{ success: boolean; savedPath?: string }>;
    restoreFromFile(): Promise<{ success: boolean; restartRequired?: boolean; error?: string }>;
    restartAutoBackupTimer(): void;
  };

  suppliers: {
    getAll(includeInactive?: boolean): Promise<Supplier[]>;
    getById(id: number): Promise<Supplier>;
    create(data: Partial<Supplier>): Promise<Supplier>;
    update(id: number, data: Partial<Supplier>): Promise<Supplier>;
  };

  purchases: {
    getAll(filters?: unknown): Promise<PaginatedResult<Purchase>>;
    getById(id: number): Promise<Purchase>;
    getItems(purchaseId: number): Promise<PurchaseItem[]>;
    getPayments(purchaseId: number): Promise<PurchasePayment[]>;
    create(data: CreatePurchaseInput): Promise<Purchase>;
    update(id: number, data: {
      supplier_id?: number | null;
      invoice_reference?: string | null;
      purchase_date?: string;
      notes?: string | null;
      alert_days_before?: number;
    }): Promise<Purchase>;
    delete(id: number, force?: boolean): Promise<{ ok: boolean }>;
    addItems(purchaseId: number, data: { items: CreatePurchaseItemInput[] }): Promise<Purchase>;
    unmarkPaymentPaid(paymentId: number): Promise<PurchasePayment>;
    markPaymentPaid(paymentId: number, paymentMethod: ExpensePaymentMethod, referenceNumber?: string, paidAmount?: number, adjustmentStrategy?: PaymentAdjustmentStrategy): Promise<PurchasePayment>;
    updatePaymentSchedule(purchaseId: number, payments: Array<{ id: number; amount: number; due_date: string }>): Promise<Purchase>;
    replaceUnpaidSchedule(purchaseId: number, payments: Array<{ amount: number; due_date: string }>): Promise<Purchase>;
    getAgingPayments(): Promise<AgingPayment[]>;
    getOverdueSummary(): Promise<{ count: number; total: number }>;
    getUpcomingPayments(): Promise<UpcomingPayment[]>;
    getUpcomingSummary(): Promise<{ count: number; total: number }>;
    getPendingItems(purchaseId: number): Promise<PurchasePendingItem[]>;
    completePendingItem(pendingItemId: number, itemData: CreatePurchaseItemInput): Promise<Purchase>;
    deletePendingItem(pendingItemId: number): Promise<{ ok: boolean }>;
    updatePendingItem(pendingItemId: number, rawData: string, notes?: string | null): Promise<PurchasePendingItem>;
    updatePayment(paymentId: number, data: { amount?: number; due_date?: string; payment_method?: string; reference_number?: string | null }): Promise<PurchasePayment>;
    deletePayment(paymentId: number): Promise<{ ok: boolean }>;
    updateItem(itemId: number, data: { quantity_received?: number; cost_per_parent?: number; selling_price_parent?: number }): Promise<PurchaseItem>;
    deleteItem(itemId: number): Promise<{ ok: boolean }>;
    merge(targetId: number, sourceIds: number[]): Promise<Purchase>;
    getAllPendingItems(filters?: { search?: string; supplier_id?: number; page?: number; limit?: number }): Promise<PaginatedResult<EnrichedPendingItem>>;
  };

  pdf: {
    parsePython(buffer: ArrayBuffer): Promise<PythonPdfParsedRow[]>;
  };

  app: {
    info(): Promise<AppInfo>;
    restart(): Promise<void>;
  };

  device: {
    getConfig(): Promise<DeviceConfig>;
    saveConfig(config: Omit<DeviceConfig, 'lanIp'>): Promise<{ success: boolean; restartRequired: boolean }>;
  };

  discovery: {
    scan(): Promise<DiscoveredServer[]>;
  };
}

export interface DiscoveredServer {
  app: string;
  ip: string;
  port: number;
  name: string;
  version: string;
}

export type DeviceMode = 'standalone' | 'server' | 'client';

export interface DeviceConfig {
  mode: DeviceMode;
  serverHost: string;
  serverPort: number;
  lanIp: string;
  allLanIps?: Array<{ name: string; address: string }>;
}

// ─── Filter types ────────────────────────────────────────────────────────────

export interface ProductFilters {
  search?: string;
  category_id?: number;
  sort_by?: 'name' | 'created_at';
  sort_dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// ─── Paginated result wrapper ────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── Global declaration ─────────────────────────────────────────────────────

declare global {
  interface Window {
    api: PharmaSysApi;
  }
}
