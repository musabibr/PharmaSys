/**
 * PharmaSys — Micro-Permission System
 *
 * Defines all granular permission keys, grouped by module.
 * Provides resolver functions that handle both legacy (perm_finance/inventory/reports)
 * and new (permissions_json) storage formats.
 *
 * Used by both backend (IPC router, REST middleware) and frontend (hooks, guards).
 */

// ─── Permission Key Type ────────────────────────────────────────────────────

export type PermissionKey =
  // Inventory
  | 'inventory.products.view'
  | 'inventory.products.manage'
  | 'inventory.products.delete'
  | 'inventory.products.bulk_import'
  | 'inventory.batches.view'
  | 'inventory.batches.manage'
  | 'inventory.batches.damage'
  | 'inventory.batches.adjust'
  | 'inventory.categories.view'
  | 'inventory.categories.manage'
  | 'inventory.valuation'
  | 'inventory.reorder'
  | 'inventory.dead_capital'
  | 'inventory.expiry_alerts'
  | 'inventory.low_stock'
  | 'inventory.view_costs'
  // Finance
  | 'finance.transactions.view'
  | 'finance.transactions.view_own'
  | 'finance.transactions.return'
  | 'finance.transactions.return_own'
  | 'finance.transactions.void'
  | 'finance.expenses.view'
  | 'finance.expenses.manage'
  | 'finance.expenses.delete'
  | 'finance.expense_categories'
  | 'finance.cash_drops.view'
  | 'finance.cash_drops.manage'
  | 'finance.shifts.view'
  | 'finance.shifts.view_own'
  | 'finance.shifts.manage'
  | 'finance.shifts.close'
  | 'finance.view_totals'
  // Reports
  | 'reports.cash_flow'
  | 'reports.profit_loss'
  | 'reports.dashboard'
  // POS
  | 'pos.sales'
  | 'pos.held_sales'
  | 'pos.discounts'
  | 'pos.bank_transfer'
  // Purchases
  | 'purchases.view'
  | 'purchases.manage'
  | 'purchases.pay'
  | 'purchases.delete'
  | 'purchases.suppliers.manage';

export type PermissionModule = 'inventory' | 'finance' | 'reports' | 'pos' | 'purchases';

export type LegacyPermissionKey = 'perm_finance' | 'perm_inventory' | 'perm_reports';

// ─── Permission Registry ────────────────────────────────────────────────────

export interface PermissionEntry {
  key: PermissionKey;
  label: string;
  description: string;
}

export interface PermissionGroup {
  module: PermissionModule;
  label: string;
  permissions: PermissionEntry[];
}

export const PERMISSION_REGISTRY: PermissionGroup[] = [
  {
    module: 'inventory',
    label: 'Inventory',
    permissions: [
      { key: 'inventory.products.view',        label: 'View Products',           description: 'View product list and details' },
      { key: 'inventory.products.manage',      label: 'Manage Products',         description: 'Create and update products' },
      { key: 'inventory.products.delete',     label: 'Delete Products',         description: 'Delete products from the system' },
      { key: 'inventory.products.bulk_import', label: 'Bulk Import',             description: 'Import products via CSV' },
      { key: 'inventory.batches.view',         label: 'View Batches',            description: 'View batch list, expiring, expired' },
      { key: 'inventory.batches.manage',       label: 'Manage Batches',          description: 'Create and update batches' },
      { key: 'inventory.batches.damage',       label: 'Report Damage',           description: 'Report batch damage' },
      { key: 'inventory.batches.adjust',      label: 'Stock Adjustments',       description: 'Make stock corrections and adjustments' },
      { key: 'inventory.categories.view',      label: 'View Categories',         description: 'View product categories' },
      { key: 'inventory.categories.manage',    label: 'Manage Categories',       description: 'Create and update categories' },
      { key: 'inventory.valuation',            label: 'Inventory Valuation',     description: 'View inventory valuation report' },
      { key: 'inventory.reorder',              label: 'Reorder Recommendations', description: 'View reorder suggestions' },
      { key: 'inventory.dead_capital',         label: 'Dead Capital',            description: 'View dead capital report' },
      { key: 'inventory.expiry_alerts',        label: 'Expiry Alerts',           description: 'View expiry and expired product alerts' },
      { key: 'inventory.low_stock',            label: 'Low Stock Alerts',        description: 'View low stock warnings' },
      { key: 'inventory.view_costs',           label: 'View Cost Prices',        description: 'See cost prices, margins, and cost valuations in inventory pages' },
    ],
  },
  {
    module: 'finance',
    label: 'Finance',
    permissions: [
      { key: 'finance.transactions.view',      label: 'View All Transactions',      description: 'View all transaction list and details' },
      { key: 'finance.transactions.view_own', label: 'View Own Transactions',      description: 'View only own transactions' },
      { key: 'finance.transactions.return',   label: 'Return Any Transaction',     description: 'Create returns for any transaction' },
      { key: 'finance.transactions.return_own', label: 'Return Own Transactions',  description: 'Create returns for own transactions only' },
      { key: 'finance.transactions.void',     label: 'Void Transactions',          description: 'Void existing transactions' },
      { key: 'finance.expenses.view',        label: 'View Expenses',              description: 'View expense list' },
      { key: 'finance.expenses.manage',      label: 'Manage Expenses',            description: 'Create expenses' },
      { key: 'finance.expenses.delete',     label: 'Delete Expenses',            description: 'Delete expense records' },
      { key: 'finance.expense_categories',   label: 'Manage Expense Categories',  description: 'Create expense categories' },
      { key: 'finance.cash_drops.view',      label: 'View Cash Drops',            description: 'View cash drop history' },
      { key: 'finance.cash_drops.manage',    label: 'Create Cash Drops',          description: 'Record cash drops' },
      { key: 'finance.shifts.view',            label: 'View All Shifts',            description: 'View all shift history and reports' },
      { key: 'finance.shifts.view_own',       label: 'View Own Shifts',            description: 'View own shift history and reports' },
      { key: 'finance.shifts.manage',         label: 'Open Shifts',                description: 'Open new shifts' },
      { key: 'finance.shifts.close',         label: 'Close Shifts',               description: 'Close open shifts' },
      { key: 'finance.view_totals',           label: 'View Financial Totals',      description: 'See aggregate financial summary cards (total sales, returns, net)' },
    ],
  },
  {
    module: 'reports',
    label: 'Reports',
    permissions: [
      { key: 'reports.cash_flow',    label: 'Cash Flow Report',     description: 'View cash flow analysis' },
      { key: 'reports.profit_loss',  label: 'Profit & Loss Report', description: 'View profit & loss analysis' },
      { key: 'reports.dashboard',    label: 'Dashboard Stats',      description: 'View dashboard statistics' },
    ],
  },
  {
    module: 'pos',
    label: 'Point of Sale',
    permissions: [
      { key: 'pos.sales',      label: 'Create Sales',      description: 'Process sales at POS' },
      { key: 'pos.held_sales', label: 'Manage Held Sales', description: 'Park and recall held sales' },
      { key: 'pos.discounts',      label: 'Apply Discounts',   description: 'Apply line-item discounts during sales' },
      { key: 'pos.bank_transfer',  label: 'Bank Transfer',     description: 'Allow bank transfer payment method at POS' },
    ],
  },
  {
    module: 'purchases',
    label: 'Purchases',
    permissions: [
      { key: 'purchases.view',              label: 'View Purchases',    description: 'View purchase list, details, and aging' },
      { key: 'purchases.manage',            label: 'Manage Purchases',  description: 'Create purchases, confirm invoices' },
      { key: 'purchases.pay',               label: 'Make Payments',     description: 'Mark installments as paid' },
      { key: 'purchases.delete',            label: 'Delete Purchases',  description: 'Delete purchase records' },
      { key: 'purchases.suppliers.manage',   label: 'Manage Suppliers',  description: 'Create and update suppliers' },
    ],
  },
];

/** Flat array of all permission keys */
export const ALL_PERMISSION_KEYS: PermissionKey[] =
  PERMISSION_REGISTRY.flatMap(g => g.permissions.map(p => p.key));

// ─── Legacy Group Mapping ───────────────────────────────────────────────────

/** Maps each legacy permission column to its micro-permission equivalents */
export const LEGACY_GROUP_MAP: Record<LegacyPermissionKey, PermissionKey[]> = {
  perm_inventory: PERMISSION_REGISTRY
    .find(g => g.module === 'inventory')!
    .permissions.map(p => p.key),
  perm_finance: PERMISSION_REGISTRY
    .find(g => g.module === 'finance')!
    .permissions.map(p => p.key),
  perm_reports: PERMISSION_REGISTRY
    .find(g => g.module === 'reports')!
    .permissions.map(p => p.key),
};

// ─── Permission Resolver ────────────────────────────────────────────────────

/** User shape required by resolvePermissions (works with both User and UserPublic) */
interface PermissionUser {
  perm_finance: number;
  perm_inventory: number;
  perm_reports: number;
  permissions_json: string | null;
}

/**
 * Resolve a user's effective permissions into a Set.
 *
 * If `permissions_json` is present, parse it.
 * Otherwise, expand legacy columns into micro-permissions.
 */
export function resolvePermissions(user: PermissionUser): Set<PermissionKey> {
  if (user.permissions_json) {
    try {
      const parsed = JSON.parse(user.permissions_json) as string[];
      const valid = new Set(ALL_PERMISSION_KEYS as string[]);
      return new Set(parsed.filter(k => valid.has(k)) as PermissionKey[]);
    } catch {
      // Corrupted JSON — fall through to legacy expansion
    }
  }

  // Legacy expansion
  const perms = new Set<PermissionKey>();

  if (user.perm_inventory) {
    for (const k of LEGACY_GROUP_MAP.perm_inventory) perms.add(k);
  }
  if (user.perm_finance) {
    for (const k of LEGACY_GROUP_MAP.perm_finance) perms.add(k);
    // Legacy finance permission also grants purchase access
    const purchasePerms = PERMISSION_REGISTRY.find(g => g.module === 'purchases');
    if (purchasePerms) {
      for (const p of purchasePerms.permissions) perms.add(p.key);
    }
  }
  if (user.perm_reports) {
    for (const k of LEGACY_GROUP_MAP.perm_reports) perms.add(k);
  }

  // POS permissions granted to all legacy users by default
  perms.add('pos.sales');
  perms.add('pos.held_sales');
  perms.add('pos.discounts');
  perms.add('pos.bank_transfer');

  return perms;
}

// ─── Permission Check Helpers ───────────────────────────────────────────────

/** Check if a user has a specific micro-permission. Admin bypasses. */
export function hasPermission(
  role: string,
  permissions: Set<PermissionKey>,
  required: PermissionKey,
): boolean {
  if (role === 'admin') return true;
  return permissions.has(required);
}

/** Check if a user has ANY of the given permissions. Used for sidebar visibility. */
export function hasAnyPermission(
  role: string,
  permissions: Set<PermissionKey>,
  required: PermissionKey[],
): boolean {
  if (role === 'admin') return true;
  return required.some(k => permissions.has(k));
}

/**
 * Derive legacy permission columns from a micro-permission set.
 * Used when saving to keep legacy columns in sync for backward compat.
 *
 * A legacy column is set to 1 if the user has ANY permission from that group.
 */
export function deriveLegacyPermissions(permissions: PermissionKey[]): {
  perm_finance: number;
  perm_inventory: number;
  perm_reports: number;
} {
  const set = new Set(permissions);
  return {
    perm_inventory: LEGACY_GROUP_MAP.perm_inventory.some(k => set.has(k)) ? 1 : 0,
    perm_finance:   LEGACY_GROUP_MAP.perm_finance.some(k => set.has(k)) ? 1 : 0,
    perm_reports:   LEGACY_GROUP_MAP.perm_reports.some(k => set.has(k)) ? 1 : 0,
  };
}
