/**
 * Purchase orders (L4):
 *
 *  - purchase_orders / purchase_order_items   orders to suppliers, received by invoices
 *  - purchases.purchase_order_id, purchase_items.po_item_id   invoice lines matched to order lines
 *
 * The definitions are identical to the full schema's (phase3-schema.ts), so a
 * database created here upgrades to it without changes. Idempotent: CREATE …
 * IF NOT EXISTS and columns added only when missing.
 */

import type { BaseRepository } from '../base.repository';

async function hasColumn(base: BaseRepository, table: string, column: string): Promise<boolean> {
  const cols = await base.getAll<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.some(c => c.name === column);
}

async function addColumn(base: BaseRepository, table: string, column: string, definition: string): Promise<void> {
  if (!(await hasColumn(base, table, column))) {
    await base.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function guardDate(base: BaseRepository, table: string, column: string, nullable: boolean): Promise<void> {
  const invalid = nullable
    ? `NEW.${column} IS NOT NULL AND date(NEW.${column}) IS NOT NEW.${column}`
    : `date(NEW.${column}) IS NOT NEW.${column}`;
  const abort = `SELECT RAISE(ABORT, 'INVALID_DATE:${table}.${column}')`;
  await base.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_${column}_insert
    BEFORE INSERT ON ${table} WHEN ${invalid}
    BEGIN ${abort}; END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_${column}_update
    BEFORE UPDATE OF ${column} ON ${table} WHEN ${invalid}
    BEGIN ${abort}; END;
  `);
}

export async function applyPurchaseOrderSchema(base: BaseRepository): Promise<void> {
  await base.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'closed', 'cancelled')),
      order_date TEXT NOT NULL,
      expected_date TEXT,
      notes TEXT,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      sent_at TEXT,
      closed_at TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id, status);

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      expected_cost_parent REAL CHECK(expected_cost_parent IS NULL OR expected_cost_parent >= 0),
      notes TEXT,
      UNIQUE(po_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_order_items_product ON purchase_order_items(product_id);
  `);

  await addColumn(base, 'purchases', 'purchase_order_id', 'INTEGER');
  await addColumn(base, 'purchase_items', 'po_item_id', 'INTEGER');
  await base.exec(`CREATE INDEX IF NOT EXISTS idx_purchase_items_po_item ON purchase_items(po_item_id)`);
  await base.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_purchase_order ON purchases(purchase_order_id)`);

  await guardDate(base, 'purchase_orders', 'order_date', false);
  await guardDate(base, 'purchase_orders', 'expected_date', true);
}
