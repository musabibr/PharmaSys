/**
 * Event types for the internal event bus.
 * Services emit events; listeners (audit, notifications) subscribe.
 */

export type MutationAction =
  | 'CREATE_PRODUCT'   | 'UPDATE_PRODUCT'   | 'DELETE_PRODUCT' | 'BULK_CREATE_PRODUCTS' | 'CASCADE_CF_CHANGE'
  | 'CREATE_BATCH'     | 'UPDATE_BATCH'     | 'REPORT_DAMAGE' | 'DELETE_BATCH' | 'BULK_UPDATE_BATCH_PRICES' | 'RESTORE_BATCH'
  | 'CREATE_USER'      | 'UPDATE_USER'      | 'RESET_PASSWORD' | 'UNLOCK_ACCOUNT'
  | 'CREATE_CATEGORY'  | 'UPDATE_CATEGORY'
  | 'CREATE_EXPENSE'   | 'UPDATE_EXPENSE'   | 'DELETE_EXPENSE'   | 'CREATE_EXPENSE_CATEGORY'
  | 'CREATE_CASH_DROP'
  | 'CLOSE_SHIFT'     | 'FORCE_CLOSE_SHIFT' | 'UPDATE_OPENING_AMOUNT'
  | 'CREATE_SALE'     | 'CREATE_RETURN'    | 'VOID_TRANSACTION' | 'VOID_STOCK_SKIP'
  | 'HOLD_SALE'        | 'DELETE_HELD_SALE'
  | 'UPDATE_SETTING'
  | 'MANUAL_BACKUP'    | 'RESTORE_BACKUP'
  | 'CREATE_SUPPLIER'  | 'UPDATE_SUPPLIER' | 'DELETE_SUPPLIER'
  | 'CREATE_PURCHASE'  | 'UPDATE_PURCHASE' | 'DELETE_PURCHASE' | 'ADD_PURCHASE_ITEMS' | 'MARK_PAYMENT_PAID' | 'DELETE_PAYMENT' | 'DELETE_PURCHASE_ITEM'
  | 'UPDATE_PAYMENT_SCHEDULE' | 'REPLACE_PAYMENT_SCHEDULE'
  | 'COMPLETE_PENDING_ITEM' | 'DELETE_PENDING_ITEM' | 'UPDATE_PENDING_ITEM' | 'MERGE_PURCHASES'
  | 'CREATE_RECURRING_EXPENSE' | 'UPDATE_RECURRING_EXPENSE' | 'DELETE_RECURRING_EXPENSE' | 'TOGGLE_RECURRING_EXPENSE';

export interface EntityMutatedEvent {
  action: MutationAction;
  table: string;
  recordId: number | null;
  userId: number | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface TransactionCreatedEvent {
  transactionId: number;
  transactionType: 'sale' | 'return';
  totalAmount: number;
  userId: number;
  shiftId: number | null;
  itemCount: number;
}

export interface StockChangedEvent {
  batchId: number;
  productId: number;
  previousQuantity: number;
  newQuantity: number;
  changeReason: 'sale' | 'return' | 'void' | 'damage' | 'correction' | 'expiry' | 'adjustment' | 'purchase';
  userId: number;
}

export interface ShiftEvent {
  shiftId: number;
  userId: number;
  action: 'opened' | 'closed';
  openingAmount?: number;
  expectedCash?: number;
  actualCash?: number;
  variance?: number;
}

export interface AuthEvent {
  userId: number | null;
  username: string;
  action:
    | 'login' | 'logout' | 'login_failed' | 'account_locked'
    | 'password_changed' | 'password_reset'
    | 'account_unlocked' | 'security_question_set'
    | 'emergency_reset';
  extra?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Map of event names to their payload types */
export interface EventMap {
  'entity:mutated': EntityMutatedEvent;
  'transaction:created': TransactionCreatedEvent;
  'stock:changed': StockChangedEvent;
  'shift:changed': ShiftEvent;
  'auth:event': AuthEvent;
}

export type EventName = keyof EventMap;
