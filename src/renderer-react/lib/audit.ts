/**
 * Shared display helpers for audit_logs entries — used by AuditPage,
 * BatchHistoryTab, and ProductMovementsDialog's History tab so all three
 * show the same human-readable labels, colors, and formatting instead of
 * each inventing its own (previously AuditPage showed "Stock Batch Added"
 * while BatchHistoryTab showed the raw "CREATE_BATCH" for the same event).
 */

import type { AuditEntry } from '@/api/types';

/**
 * The row's display name — a product name, ideally, never the raw
 * record_id. A pharmacist/cashier has no idea what "batch #412" means; they
 * know products by name. Falls back to old_values.product_name for a
 * hard-deleted batch (the live join in the repo returns null once the row
 * is gone, but DELETE_BATCH captures the name at delete time).
 */
export function resolveEntryName(entry: AuditEntry): string | null {
  if (entry.product_name) return entry.product_name;
  try {
    const old = entry.old_values ? JSON.parse(entry.old_values) : null;
    if (old && typeof old === 'object' && typeof old.product_name === 'string') return old.product_name;
  } catch { /* not JSON or no old_values — fall through */ }
  return null;
}

export type AuditBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

/** Human label for every action currently emitted by the services. */
export const ACTION_LABELS: Record<string, string> = {
  'LOGIN':                       'User Login',
  'LOGOUT':                      'User Logout',
  'CREATE_PRODUCT':              'Product Created',
  'UPDATE_PRODUCT':              'Product Updated',
  'DELETE_PRODUCT':              'Product Deleted',
  'BULK_CREATE_PRODUCTS':        'Products Bulk Import',
  'CASCADE_CF_CHANGE':           'Conversion Factor Changed',
  'CREATE_BATCH':                'Stock Batch Added',
  'UPDATE_BATCH':                'Stock Batch Updated',
  'DELETE_BATCH':                'Stock Batch Deleted',
  'RESTORE_BATCH':               'Batch Restored (Return)',
  'REPORT_DAMAGE':               'Damage Reported',
  'REVERSE_ADJUSTMENT':          'Adjustment Reversed',
  'VOID_STOCK_SKIP':             'Stock Not Adjusted (Void)',
  'BULK_UPDATE_BATCH_PRICES':    'Prices Updated by Product',
  'BULK_MARGIN_PRICE_UPDATE':    'Bulk Margin Price Update',
  'BULK_MANUAL_PRICE_UPDATE':    'Bulk Manual Price Update',
  'PROPAGATE_SELLING_PRICE':     'Price Propagated to Older Batches',
  'CREATE_SALE':                 'Sale Completed',
  'CREATE_RETURN':               'Return Processed',
  'VOID_TRANSACTION':            'Transaction Voided',
  'CREATE_EXPENSE':              'Expense Created',
  'DELETE_EXPENSE':              'Expense Deleted',
  'CREATE_CASH_DROP':            'Cash Withdrawal',
  'OPEN_SHIFT':                  'Shift Opened',
  'CLOSE_SHIFT':                 'Shift Closed',
  'FORCE_CLOSE_SHIFT':           'Shift Force-Closed',
  'CREATE_USER':                 'User Created',
  'UPDATE_USER':                 'User Updated',
  'RESET_PASSWORD':              'Password Reset',
  'UNLOCK_ACCOUNT':              'Account Unlocked',
  'CHANGE_PASSWORD':             'Password Changed',
  'CREATE_CATEGORY':             'Category Created',
  'UPDATE_CATEGORY':             'Category Updated',
  'UPDATE_SETTING':               'Setting Updated',
  'MANUAL_BACKUP':               'Backup Created',
  'RESTORE_BACKUP':              'Backup Restored',
  'HOLD_SALE':                   'Sale Held',
  'DELETE_HELD_SALE':            'Held Sale Deleted',
  'CREATE_PURCHASE':             'Purchase Created',
  'UPDATE_PURCHASE':             'Purchase Updated',
  'MERGE_PURCHASES':             'Purchases Merged',
  'MARK_PAYMENT_PAID':           'Payment Recorded',
  'COMPLETE_PENDING_ITEM':       'Parked Item Completed',
  'DELETE_PENDING_ITEM':         'Parked Item Deleted',
  'UPDATE_PENDING_ITEM':         'Parked Item Updated',
  'DELETE_PAYMENT':              'Payment Deleted',
  'DELETE_PURCHASE_ITEM':        'Purchase Item Deleted',
  'ADD_PURCHASE_ITEMS':          'Items Added to Purchase',
};

/** SCREAMING_SNAKE_CASE → "Screaming Snake Case", for actions not yet in ACTION_LABELS. */
function humanize(action: string): string {
  return action
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Human-readable label for an audit action — never the raw enum constant. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanize(action);
}

export function actionBadgeVariant(action: string): AuditBadgeVariant {
  if (action.startsWith('CREATE_') || action === 'RESTORE_BATCH') return 'success';
  if (action.startsWith('DELETE_') || action.startsWith('VOID_')) return 'destructive';
  if (action.startsWith('BULK_') || action === 'PROPAGATE_SELLING_PRICE' || action === 'CASCADE_CF_CHANGE') return 'warning';
  if (action.startsWith('UPDATE_') || action === 'REPORT_DAMAGE' || action === 'REVERSE_ADJUSTMENT') return 'secondary';
  if (action === 'LOGIN' || action === 'LOGOUT') return 'outline';
  return 'default';
}

/** Pretty-print a JSON values blob, falling back to the raw string if it doesn't parse. */
export function safeJsonFormat(value: string | null): string {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function parseValues(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

/**
 * One-line "field: old → new" preview for a table cell. Full detail belongs
 * in a dialog (see AuditDetailDialog) — this is a scannable summary, not the
 * only way to see the change, so truncating it is safe.
 */
export function summarizeDiff(oldJson: string | null, newJson: string | null): string {
  const oldV = parseValues(oldJson);
  const newV = parseValues(newJson);
  const keys = Object.keys(newV).filter((k) => k !== 'version');
  if (keys.length === 0) return '';
  return keys
    .map((k) => {
      const nv = newV[k] ?? '—';
      const hasOld = Object.prototype.hasOwnProperty.call(oldV, k);
      if (!hasOld) return `${k}: ${nv}`;
      const ov = oldV[k] ?? '—';
      return ov === nv ? `${k}: ${nv}` : `${k}: ${ov} → ${nv}`;
    })
    .join(', ');
}

export function formatDateTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return dateStr;
  }
}
