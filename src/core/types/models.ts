/**
 * Domain model interfaces — derived from the database schema.
 * All money values are INTEGER whole SDG (SDG has no minor units).
 * All quantities are INTEGER base units (smallest unit).
 */

import type { PermissionKey } from '../common/permissions';

// ─── Enums ───

export type UserRole = 'admin' | 'pharmacist' | 'cashier';

export type BatchStatus = 'active' | 'quarantine' | 'sold_out';

export type TransactionType = 'sale' | 'return' | 'void';

export type PaymentMethod = 'cash' | 'bank_transfer' | 'mixed';

export type ExpensePaymentMethod = 'cash' | 'bank_transfer';

export type UnitType = 'parent' | 'child';

export type ShiftStatus = 'open' | 'closed';

export type VarianceType = 'shortage' | 'overage' | 'balanced';

export type AdjustmentType = 'damage' | 'expiry' | 'correction';

// ─── Auth Context ───

export interface UserPermissions {
  perm_finance: boolean;
  perm_inventory: boolean;
  perm_reports: boolean;
}

export interface AuthContext {
  userId: number;
  username: string;
  role: UserRole;
  permissions: UserPermissions;
  tenantId?: string; // Multi-tenancy prep
}

// ─── User ───

export interface User {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  perm_finance: number;
  perm_inventory: number;
  perm_reports: number;
  permissions_json: string | null;
  is_active: number;
  must_change_password: number;
  failed_login_attempts: number;
  locked_until: string | null;
  security_question: string | null;
  security_answer_hash: string | null;
  security_answer_failed_attempts: number;
  security_answer_locked_until: string | null;
  created_at: string;
  updated_at: string;
}

/** User as returned to the client (no password hash) */
export interface UserPublic {
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

// ─── Category ───

export interface Category {
  id: number;
  name: string;
  created_at: string;
}

// ─── Product ───

export interface Product {
  id: number;
  name: string;
  generic_name: string | null;
  usage_instructions: string | null;
  category_id: number | null;
  category_name?: string; // Joined from categories table
  barcode: string | null;
  parent_unit: string;
  child_unit: string;
  conversion_factor: number;
  min_stock_level: number;
  is_active: number;
  total_stock_base?: number;   // Aggregated from active batches
  selling_price?: number;      // Effective price of FIFO batch (parent unit), for display
  selling_price_child?: number; // Effective price of FIFO batch (child unit), for display
  created_at: string;
  updated_at: string;
}

// ─── Batch ───

export interface Batch {
  id: number;
  product_id: number;
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
  created_at: string;
  updated_at: string;
  // Joined fields
  product_name?: string;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
}

// ─── Transaction ───

export interface Transaction {
  id: number;
  transaction_number: string;
  user_id: number;
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
  payment: string | null; // JSON
  customer_name: string | null;
  customer_phone: string | null;
  notes: string | null;
  is_voided: number;
  void_reason: string | null;
  voided_by: number | null;
  voided_at: string | null;
  parent_transaction_id: number | null;
  created_at: string;
  // Joined fields
  username?: string;
  items?: TransactionItem[];
}

export interface TransactionItem {
  id: number;
  transaction_id: number;
  product_id: number;
  batch_id: number;
  quantity_base: number;
  unit_type: UnitType;
  unit_price: number;
  cost_price: number;
  discount_percent: number;
  line_total: number;
  gross_profit: number;
  conversion_factor_snapshot: number;
  created_at: string;
  // Joined fields
  product_name?: string;
  batch_number?: string;
}

// ─── Shift ───

export interface Shift {
  id: number;
  user_id: number;
  opened_at: string;
  closed_at: string | null;
  opening_amount: number;
  expected_cash: number | null;
  actual_cash: number | null;
  variance: number | null;
  variance_type: VarianceType | null;
  notes: string | null;
  status: ShiftStatus;
  // Joined fields
  username?: string;
}

// ─── Expense ───

export interface ExpenseCategory {
  id: number;
  name: string;
}

export interface Expense {
  id: number;
  category_id: number;
  amount: number;
  description: string | null;
  expense_date: string;
  payment_method: ExpensePaymentMethod;
  user_id: number;
  shift_id: number | null;
  created_at: string;
  // Joined fields
  category_name?: string;
  username?: string;
}

// ─── Cash Drop ───

export interface CashDrop {
  id: number;
  shift_id: number;
  amount: number;
  reason: string | null;
  user_id: number;
  created_at: string;
  // Joined fields
  username?: string;
}

// ─── Held Sale ───

export interface HeldSale {
  id: number;
  user_id: number;
  customer_note: string | null;
  items_json: string;
  total_amount: number;
  created_at: string;
  // Parsed field
  items?: unknown[];
}

// ─── Inventory Adjustment ───

export interface InventoryAdjustment {
  id: number;
  product_id: number;
  batch_id: number;
  quantity_base: number;
  reason: string | null;
  type: AdjustmentType;
  user_id: number;
  created_at: string;
  // Joined fields
  product_name?: string;
  batch_number?: string;
  username?: string;
}

// ─── Audit Log ───

export interface AuditLog {
  id: number;
  user_id: number | null;
  action: string;
  table_name: string | null;
  record_id: number | null;
  old_values: string | null; // JSON
  new_values: string | null; // JSON
  ip_address: string | null;
  created_at: string;
  // Joined fields
  username?: string;
}

// ─── Settings ───

export interface Setting {
  key: string;
  value: string | null;
  updated_at: string;
}

// ─── Input Types (for create/update operations) ───

export interface CreateUserInput {
  username: string;
  password: string;
  full_name: string;
  role: UserRole;
  perm_finance?: boolean;
  perm_inventory?: boolean;
  perm_reports?: boolean;
  permissions?: PermissionKey[];
}

export interface UpdateUserInput {
  full_name?: string;
  role?: UserRole;
  perm_finance?: boolean;
  perm_inventory?: boolean;
  perm_reports?: boolean;
  permissions?: PermissionKey[];
  is_active?: boolean;
}

export interface CreateProductInput {
  name: string;
  generic_name?: string;
  usage_instructions?: string;
  category_id?: number;
  barcode?: string;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
  min_stock_level?: number;
}

export interface UpdateProductInput {
  name?: string;
  generic_name?: string;
  usage_instructions?: string;
  category_id?: number;
  barcode?: string;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
  min_stock_level?: number;
  is_active?: boolean;
}

export interface CreateBatchInput {
  product_id: number;
  batch_number?: string;
  expiry_date: string;
  quantity_base: number;
  cost_per_parent: number;
  selling_price_parent: number;
  cost_per_child_override?: number;
  selling_price_child_override?: number;
}

export interface UpdateBatchInput {
  batch_number?: string;
  expiry_date?: string;
  quantity_base?: number;
  cost_per_parent?: number;
  selling_price_parent?: number;
  cost_per_child_override?: number;
  selling_price_child_override?: number;
  status?: BatchStatus;
  version: number; // Required for optimistic locking
}

export interface CreateTransactionInput {
  transaction_type: TransactionType;
  subtotal: number;
  discount_amount?: number;
  tax_amount?: number;
  total_amount: number;
  payment_method: PaymentMethod;
  bank_name?: string;
  reference_number?: string;
  cash_tendered?: number;
  payment?: string | Record<string, number>; // JSON string or object for mixed payments
  customer_name?: string;
  customer_phone?: string;
  notes?: string;
  items: CreateTransactionItemInput[];
}

export interface CreateTransactionItemInput {
  product_id: number;
  batch_id?: number; // Optional — FIFO auto-selects if not provided
  quantity: number; // Display units (not base)
  unit_type: UnitType;
  unit_price: number;
  discount_percent?: number;
}

export interface CreateReturnInput {
  original_transaction_id: number;
  items: CreateReturnItemInput[];
  notes?: string;
}

export interface CreateReturnItemInput {
  batch_id: number;
  unit_type: UnitType;
  quantity: number; // Display units
}

export interface CreateExpenseInput {
  category_id: number;
  amount: number; // Minor units
  description?: string;
  expense_date: string;
  payment_method?: ExpensePaymentMethod;
}

export interface CreateCashDropInput {
  amount: number; // Minor units
  reason?: string;
}

export interface BulkCreateProductInput {
  name: string;
  generic_name?: string;
  category_name?: string;
  barcode?: string;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
  min_stock_level?: number;
  batch_number?: string;
  expiry_date: string;
  quantity_base: number;
  cost_per_parent: number;
  selling_price_parent: number;
}

// ─── Filter Types ───

export interface TransactionFilters {
  start_date?: string;
  end_date?: string;
  transaction_type?: TransactionType;
  payment_method?: PaymentMethod;
  is_voided?: boolean;
  user_id?: number;
  shift_id?: number;
  search?: string;
  min_amount?: number;
  max_amount?: number;
  page?: number;
  limit?: number;
}

export interface ShiftFilters {
  start_date?: string;
  end_date?: string;
  user_id?: number;
  status?: ShiftStatus;
  page?: number;
  limit?: number;
}

export interface ExpenseFilters {
  start_date?: string;
  end_date?: string;
  category_id?: number;
  page?: number;
  limit?: number;
}

export interface ProductFilters {
  search?: string;
  category_id?: number;
  sort_by?: 'name' | 'created_at';
  sort_dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface AuditLogFilters {
  start_date?: string;
  end_date?: string;
  user_id?: number;
  action?: string;
  table_name?: string;
  page?: number;
  limit?: number;
}

export interface BatchFilters {
  status?: BatchStatus;
  category_id?: number;
  search?: string;
  page?: number;
  limit?: number;
}

export interface InventoryValuationFilters {
  category_id?: number;
  search?: string;
  page?: number;
  limit?: number;
}

export interface AdjustmentFilters {
  batch_id?: number;
  product_id?: number;
  type?: AdjustmentType;
  start_date?: string;
  end_date?: string;
  page?: number;
  limit?: number;
}

// ─── Report Types ───

export interface CashFlowReport {
  total_sales: number;
  total_returns: number;
  net_sales: number;
  cost_of_goods_sold: number;
  gross_profit: number;
  gross_margin: number;
  operational_expenses: number;
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

export interface DashboardStats {
  // Today
  today_sales: number;
  today_returns: number;
  today_net_sales: number;
  today_transactions: number;
  // Past 30 days
  month_sales: number;
  month_returns: number;
  month_net_sales: number;
  month_transactions: number;
  // Inventory
  inventory_cost_value: number;
  inventory_retail_value: number;
  low_stock_count: number;
  expiring_soon_count: number;
  expired_count: number;
  // Misc
  open_shifts: number;
}

export interface ShiftExpectedCash {
  opening_amount: number;
  total_cash_sales: number;
  total_cash_returns: number;
  total_cash_expenses: number;
  total_cash_drops: number;
  expected_cash: number;
}

export interface ShiftReport {
  shift: Shift;
  transactions: Transaction[];
  expenses: Expense[];
  cash_drops: CashDrop[];
  summary: {
    total_sales: number;
    total_returns: number;
    total_expenses: number;
    total_cash_drops: number;
    transaction_count: number;
  };
}

/** Map of "batchId_unitType" → returned base quantity */
export type ReturnedQuantityMap = Record<string, number>;

// ─── Purchase Management ───

export type PurchasePaymentStatus = 'unpaid' | 'partial' | 'paid';

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
  // Joined fields
  supplier_name?: string;
  username?: string;
  items?: PurchaseItem[];
  payments?: PurchasePayment[];
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
  // Joined fields
  product_name?: string;
  parent_unit?: string;
  child_unit?: string;
  conversion_factor?: number;
}

export interface PurchasePayment {
  id: number;
  purchase_id: number;
  due_date: string;
  amount: number;
  is_paid: number;
  paid_date: string | null;
  payment_method: ExpensePaymentMethod | null;
  expense_id: number | null;
  paid_by_user_id: number | null;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  purchase_number?: string;
  supplier_name?: string;
  paid_by_username?: string;
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

// ─── Purchase Input Types ───

export interface CreateSupplierInput {
  name: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export interface UpdateSupplierInput {
  name?: string;
  phone?: string;
  address?: string;
  notes?: string;
  is_active?: boolean;
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
  quantity: number;             // in parent units
  cost_per_parent: number;
  selling_price_parent: number;
  selling_price_child?: number;
  expiry_date: string;
  batch_number?: string;
}

export interface CreatePaymentPlanInput {
  type: 'full' | 'installments';
  payment_method?: ExpensePaymentMethod;
  reference_number?: string;
  installments?: Array<{
    due_date: string;
    amount: number;
  }>;
}

export interface CreatePurchaseInput {
  supplier_id?: number;
  invoice_reference?: string;
  purchase_date: string;
  total_amount: number;
  alert_days_before?: number;
  notes?: string;
  items?: CreatePurchaseItemInput[];
  payment_plan: CreatePaymentPlanInput;
}

export interface PurchaseFilters {
  start_date?: string;
  end_date?: string;
  supplier_id?: number;
  payment_status?: PurchasePaymentStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PurchaseReportFilters {
  start_date: string;
  end_date: string;
  supplier_id?: number;
  payment_status?: PurchasePaymentStatus;
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
    payment_status: PurchasePaymentStatus;
    item_count: number;
    created_by: string;
  }>;
}

// ─── Paginated Result ───

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── App Info ───

export interface AppInfo {
  version: string;
  isDev: boolean;
  isFirstLaunch: boolean;
}
