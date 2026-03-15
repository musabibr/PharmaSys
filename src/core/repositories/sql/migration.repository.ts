/**
 * MigrationRepository — replicates all schema creation, migrations, indexes,
 * and seed data from the legacy database.js constructor.
 *
 * Called once from platform/electron/main.ts after the DB connection is
 * established but BEFORE any service or repository is used.
 */

import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as path   from 'path';
import type { BaseRepository } from './base.repository';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export class MigrationRepository {
  constructor(
    private readonly base: BaseRepository,
    private readonly dataPath: string
  ) {}

  /**
   * Run the full initialisation sequence.
   * Safe to call on every startup — uses IF NOT EXISTS / OR IGNORE throughout.
   *
   * @param seedDemo  If true, seed demo products and historical data. Only for dev mode.
   */
  async initialise(seedDemo = false, seedHistory = true): Promise<void> {
    await this._createSchema();
    await this._createIndexes();
    await this._runMigrations();
    await this._seedDefaultData();
    if (seedDemo) {
      await this._seedDemoData();
      if (seedHistory) await this._seedHistoricalData();
    }
    await this._checkFreshInstall();
    await this._unlockAdminAccounts();
    this.base.save();

    // Deferred housekeeping — purge audit logs older than 1 year
    setTimeout(() => this._purgeOldAuditLogs(365), 5000);
  }

  // ─── Schema ──────────────────────────────────────────────────────────────────

  private async _createSchema(): Promise<void> {
    const schemas = [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'pharmacist', 'cashier')),
        perm_finance INTEGER DEFAULT 0,
        perm_inventory INTEGER DEFAULT 0,
        perm_reports INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        must_change_password INTEGER DEFAULT 0,
        failed_login_attempts INTEGER DEFAULT 0,
        locked_until TEXT,
        security_question TEXT,
        security_answer_hash TEXT,
        security_answer_failed_attempts INTEGER DEFAULT 0,
        security_answer_locked_until TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        generic_name TEXT,
        usage_instructions TEXT,
        category_id INTEGER,
        barcode TEXT,
        parent_unit TEXT DEFAULT 'Box',
        child_unit TEXT DEFAULT 'Strip',
        conversion_factor INTEGER DEFAULT 1 CHECK(conversion_factor > 0),
        min_stock_level INTEGER DEFAULT 0 CHECK(min_stock_level >= 0),
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        batch_number TEXT,
        expiry_date TEXT NOT NULL,
        quantity_base INTEGER NOT NULL DEFAULT 0 CHECK(quantity_base >= 0),
        cost_per_parent INTEGER NOT NULL DEFAULT 0 CHECK(cost_per_parent >= 0),
        cost_per_child INTEGER CHECK(cost_per_child >= 0),
        cost_per_child_override INTEGER DEFAULT 0,
        selling_price_parent INTEGER CHECK(selling_price_parent >= 0),
        selling_price_child INTEGER CHECK(selling_price_child >= 0),
        selling_price_parent_override INTEGER DEFAULT 0,
        selling_price_child_override INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'quarantine', 'sold_out')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_number TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        shift_id INTEGER,
        transaction_type TEXT NOT NULL CHECK(transaction_type IN ('sale', 'return', 'void')),
        subtotal INTEGER NOT NULL DEFAULT 0,
        discount_amount INTEGER DEFAULT 0,
        tax_amount INTEGER DEFAULT 0,
        total_amount INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT CHECK(payment_method IN ('cash', 'bank_transfer', 'mixed')),
        bank_name TEXT,
        reference_number TEXT,
        cash_tendered INTEGER NOT NULL DEFAULT 0 CHECK(cash_tendered >= 0),
        payment TEXT,
        customer_name TEXT,
        customer_phone TEXT,
        notes TEXT,
        is_voided INTEGER DEFAULT 0,
        void_reason TEXT,
        voided_by INTEGER,
        voided_at TEXT,
        parent_transaction_id INTEGER REFERENCES transactions(id),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (shift_id) REFERENCES shifts(id),
        FOREIGN KEY (voided_by) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS transaction_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        quantity_base INTEGER NOT NULL CHECK(quantity_base > 0),
        unit_type TEXT NOT NULL CHECK(unit_type IN ('parent', 'child')),
        unit_price INTEGER NOT NULL DEFAULT 0 CHECK(unit_price >= 0),
        cost_price INTEGER NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
        discount_percent REAL DEFAULT 0 CHECK(discount_percent >= 0 AND discount_percent <= 100),
        line_total INTEGER NOT NULL DEFAULT 0,
        gross_profit INTEGER NOT NULL DEFAULT 0,
        conversion_factor_snapshot INTEGER NOT NULL DEFAULT 1 CHECK(conversion_factor_snapshot > 0),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (batch_id) REFERENCES batches(id)
      )`,
      `CREATE TABLE IF NOT EXISTS expense_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0 CHECK(amount > 0),
        description TEXT,
        expense_date TEXT NOT NULL,
        payment_method TEXT DEFAULT 'cash' CHECK(payment_method IN ('cash', 'bank_transfer')),
        user_id INTEGER NOT NULL,
        shift_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (category_id) REFERENCES expense_categories(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      )`,
      `CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        opening_amount INTEGER NOT NULL DEFAULT 0 CHECK(opening_amount >= 0),
        expected_cash INTEGER,
        actual_cash INTEGER,
        variance INTEGER,
        variance_type TEXT CHECK(variance_type IN ('shortage', 'overage', 'balanced')),
        notes TEXT,
        status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS cash_drops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        reason TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (shift_id) REFERENCES shifts(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS held_sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        customer_note TEXT,
        items_json TEXT NOT NULL,
        total_amount INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS inventory_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        quantity_base INTEGER NOT NULL CHECK(quantity_base > 0),
        reason TEXT,
        type TEXT NOT NULL CHECK(type IN ('damage', 'expiry', 'correction')),
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (batch_id) REFERENCES batches(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        action TEXT NOT NULL,
        table_name TEXT,
        record_id INTEGER,
        old_values TEXT,
        new_values TEXT,
        ip_address TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      // ─── Purchase Management ───
      `CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        notes TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_number TEXT UNIQUE NOT NULL,
        supplier_id INTEGER,
        invoice_reference TEXT,
        purchase_date TEXT NOT NULL,
        total_amount INTEGER NOT NULL DEFAULT 0,
        total_paid INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid'
          CHECK(payment_status IN ('unpaid', 'partial', 'paid')),
        alert_days_before INTEGER NOT NULL DEFAULT 7,
        notes TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        batch_id INTEGER,
        quantity_received INTEGER NOT NULL DEFAULT 0,
        cost_per_parent INTEGER NOT NULL DEFAULT 0,
        selling_price_parent INTEGER NOT NULL DEFAULT 0,
        line_total INTEGER NOT NULL DEFAULT 0,
        expiry_date TEXT,
        batch_number TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (batch_id) REFERENCES batches(id)
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        is_paid INTEGER NOT NULL DEFAULT 0,
        paid_date TEXT,
        payment_method TEXT CHECK(payment_method IN ('cash', 'bank_transfer')),
        expense_id INTEGER,
        paid_by_user_id INTEGER,
        reference_number TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
        FOREIGN KEY (expense_id) REFERENCES expenses(id),
        FOREIGN KEY (paid_by_user_id) REFERENCES users(id)
      )`,
    ];

    for (const sql of schemas) {
      await this.base.rawRun(sql);
    }
  }

  private async _createIndexes(): Promise<void> {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_batches_product_expiry ON batches(product_id, expiry_date)',
      'CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches(expiry_date)',
      'CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_shift ON transactions(shift_id)',
      'CREATE INDEX IF NOT EXISTS idx_transaction_items_txn ON transaction_items(transaction_id)',
      'CREATE INDEX IF NOT EXISTS idx_transaction_items_product ON transaction_items(product_id)',
      'CREATE INDEX IF NOT EXISTS idx_transaction_items_batch ON transaction_items(batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id)',
      'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
      'CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)',
      'CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)',
      'CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_shifts_user_status ON shifts(user_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_cash_drops_shift ON cash_drops(shift_id)',
      'CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_batch ON inventory_adjustments(batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_type_voided ON transactions(transaction_type, is_voided, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_logs(user_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_parent ON transactions(parent_transaction_id)',
      // Purchase indexes
      'CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id)',
      'CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(payment_status)',
      'CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date)',
      'CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id)',
      'CREATE INDEX IF NOT EXISTS idx_purchase_payments_purchase ON purchase_payments(purchase_id)',
      'CREATE INDEX IF NOT EXISTS idx_purchase_payments_due ON purchase_payments(due_date)',
      'CREATE INDEX IF NOT EXISTS idx_purchase_payments_paid_due ON purchase_payments(is_paid, due_date)',
      'CREATE INDEX IF NOT EXISTS idx_purchase_payments_purchase_paid ON purchase_payments(purchase_id, is_paid)',
      'CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_products_active_name ON products(is_active, name)',
      // Report performance indexes
      'CREATE INDEX IF NOT EXISTS idx_expenses_date_method ON expenses(expense_date, payment_method)',
      'CREATE INDEX IF NOT EXISTS idx_batches_product_status_expiry ON batches(product_id, status, expiry_date)',
      'CREATE INDEX IF NOT EXISTS idx_transaction_items_txn_product ON transaction_items(transaction_id, product_id)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_number ON transactions(transaction_number)',
      'CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_type_date ON transactions(transaction_type, created_at)',
    ];

    for (const sql of indexes) {
      try {
        await this.base.rawRun(sql);
      } catch (err: any) {
        if (!err.message?.includes('already exists')) {
          console.error(`[Index] Failed to create index: ${sql}`, err.message);
        }
      }
    }
  }

  // ─── Migrations ──────────────────────────────────────────────────────────────

  private async _runMigrations(): Promise<void> {
    // Each migration checks whether the column/fix exists before altering.
    // On a fresh install all columns are already declared in _createSchema,
    // so most migrations are no-ops.  On upgraded databases they fill the gaps.

    await this._migrateColumn('transaction_items', 'conversion_factor_snapshot',
      'ALTER TABLE transaction_items ADD COLUMN conversion_factor_snapshot INTEGER NOT NULL DEFAULT 1');

    await this._migrateColumn('batches', 'version',
      'ALTER TABLE batches ADD COLUMN version INTEGER NOT NULL DEFAULT 1');

    await this._migrateColumn('users', 'failed_login_attempts',
      'ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN locked_until TEXT');

    await this._migrateColumn('batches', 'selling_price_parent_override',
      'ALTER TABLE batches ADD COLUMN selling_price_parent_override INTEGER DEFAULT 0',
      'ALTER TABLE batches ADD COLUMN selling_price_child_override INTEGER DEFAULT 0');

    await this._migrateColumn('batches', 'cost_per_child_override',
      'ALTER TABLE batches ADD COLUMN cost_per_child_override INTEGER DEFAULT 0');

    // Pillar 3: quantity_base on batches and transaction_items
    await this._migrateQuantityBase();

    // Pillar 1: Banking columns
    await this._migrateColumn('transactions', 'bank_name',
      'ALTER TABLE transactions ADD COLUMN bank_name TEXT',
      'ALTER TABLE transactions ADD COLUMN reference_number TEXT');
    await this._migrateColumn('transactions', 'payment',
      'ALTER TABLE transactions ADD COLUMN payment TEXT');
    await this._migrateCashTendered();
    await this._migrateOldPaymentMethods();
    await this._migrateColumn('expenses', 'payment_method',
      "ALTER TABLE expenses ADD COLUMN payment_method TEXT DEFAULT 'cash'");

    // Pillar 2: cash_drops user_id
    await this._migrateCashDropUserId();

    // Pillar 4: batch status
    await this._migrateBatchStatus();

    // Security questions
    await this._migrateColumn('users', 'security_question',
      'ALTER TABLE users ADD COLUMN security_question TEXT',
      'ALTER TABLE users ADD COLUMN security_answer_hash TEXT',
      'ALTER TABLE users ADD COLUMN security_answer_failed_attempts INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN security_answer_locked_until TEXT');

    // Return transactions
    await this._migrateColumn('transactions', 'parent_transaction_id',
      'ALTER TABLE transactions ADD COLUMN parent_transaction_id INTEGER REFERENCES transactions(id)');

    // Micro-permissions JSON column
    await this._migrateColumn('users', 'permissions_json',
      'ALTER TABLE users ADD COLUMN permissions_json TEXT DEFAULT NULL');

    // Default markup setting
    await this.base.rawRun(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('default_markup_percent', '20')"
    );

    // Backfill usage_instructions for demo products that don't have them yet
    await this._migrateUsageInstructions();

    // Unique index on product name (case-insensitive) to prevent duplicates
    await this._migrateUniqueProductName();

    // Purchase alert days before due date
    await this._migrateColumn('purchases', 'alert_days_before',
      'ALTER TABLE purchases ADD COLUMN alert_days_before INTEGER NOT NULL DEFAULT 7');

    // Bank reference number on purchase payments
    await this._migrateColumn('purchase_payments', 'reference_number',
      'ALTER TABLE purchase_payments ADD COLUMN reference_number TEXT');

    // Actual paid amount on purchase payments (for flexible payments)
    await this._migrateColumn('purchase_payments', 'paid_amount',
      'ALTER TABLE purchase_payments ADD COLUMN paid_amount INTEGER');

    this.base.save();
  }

  /** Populate usage_instructions on existing demo products (idempotent). */
  private async _migrateUsageInstructions(): Promise<void> {
    const usageMap: Record<string, string> = {
      '6001234000011': 'Take 1 capsule 3 times daily after meals for 7 days. Complete the full course.',
      '6001234000028': 'Take 1-2 tablets every 4-6 hours as needed. Max 8 tablets per day.',
      '6001234000035': 'Take 1 tablet 3 times daily after meals. Not for use on empty stomach.',
      '6001234000042': 'Take 2 tablets on day 1, then 1 tablet daily for 4 days. Take 1 hour before meals.',
      '6001234000059': 'Take 1 capsule daily before breakfast. Swallow whole, do not crush or chew.',
      '6001234000066': 'Take 1 tablet twice daily with meals. Monitor blood sugar regularly.',
      '6001234000073': 'Take 1 tablet once daily at the same time each day. Can be taken with or without food.',
      '6001234000080': 'Take 1 tablet daily with water. Best taken with a meal.',
      '6001234000097': 'Take 1 tablet once daily. May cause drowsiness, avoid driving.',
      '6001234000103': 'Apply to affected area 2-3 times daily. For external use only.',
      '6001234000110': 'Inhale 1-2 puffs as needed for breathlessness. Shake well before each use.',
      '6001234000127': 'Take 1 tablet twice daily with plenty of water. Avoid dairy products within 2 hours.',
      '6001234000134': 'Apply a thin layer to affected area 3-4 times daily. Massage gently. For external use only.',
      '6001234000141': 'Take 1 tablet daily with breakfast. Do not exceed recommended dose.',
      '6001234000158': 'Take 1 tablet once daily. Monitor blood pressure regularly.',
    };
    for (const [barcode, usage] of Object.entries(usageMap)) {
      await this.base.rawRun(
        'UPDATE products SET usage_instructions = ? WHERE barcode = ? AND usage_instructions IS NULL',
        [usage, barcode]
      );
    }
  }

  /** Add unique index on product name (case-insensitive) to prevent duplicates. */
  private async _migrateUniqueProductName(): Promise<void> {
    try {
      await this.base.rawRun(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_name_unique
         ON products (LOWER(TRIM(name))) WHERE is_active = 1`
      );
    } catch {
      // SQLite partial indexes (WHERE clause) require >= 3.8.0. If this
      // fails (e.g. on an older sql.js build), fall back to a non-partial index.
      try {
        await this.base.rawRun(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_name_unique
           ON products (LOWER(TRIM(name)))`
        );
      } catch {
        // Index already exists or cannot be created (duplicate names already
        // present). Service-level check is the fallback safety net.
      }
    }
  }

  /** Safely add column(s) if missing. */
  private async _migrateColumn(table: string, checkColumn: string, ...alterStatements: string[]): Promise<void> {
    try {
      await this.base.rawRun(`SELECT ${checkColumn} FROM ${table} LIMIT 0`);
    } catch {
      const sp = `migration_${table}_${checkColumn}`;
      try {
        await this.base.rawRun(`SAVEPOINT ${sp}`);
        for (const sql of alterStatements) {
          await this.base.rawRun(sql);
        }
        await this.base.rawRun(`RELEASE ${sp}`);
        console.log(`[Migration] Added ${checkColumn} to ${table}`);
      } catch (err: any) {
        console.error(`[Migration] ${table}.${checkColumn} failed:`, err.message);
        try {
          await this.base.rawRun(`ROLLBACK TO ${sp}`);
          await this.base.rawRun(`RELEASE ${sp}`);
        } catch {}
      }
      this.base.save();
    }
  }

  private async _migrateQuantityBase(): Promise<void> {
    // Batches
    let hasBatchQtyBase = false;
    try { await this.base.rawRun('SELECT quantity_base FROM batches LIMIT 0'); hasBatchQtyBase = true; } catch {}

    if (!hasBatchQtyBase) {
      let hasOldCol = false;
      try { await this.base.rawRun('SELECT quantity_parent FROM batches LIMIT 0'); hasOldCol = true; } catch {}

      if (hasOldCol) {
        await this.base.rawRun('ALTER TABLE batches ADD COLUMN quantity_base INTEGER NOT NULL DEFAULT 0');
        await this.base.rawRun(`
          UPDATE batches SET quantity_base = quantity_parent * (
            SELECT COALESCE(p.conversion_factor, 1) FROM products p WHERE p.id = batches.product_id
          )
        `);
        this.base.save();
      }
    }

    // Transaction items
    let hasTiQtyBase = false;
    try { await this.base.rawRun('SELECT quantity_base FROM transaction_items LIMIT 0'); hasTiQtyBase = true; } catch {}

    if (!hasTiQtyBase) {
      await this.base.rawRun('ALTER TABLE transaction_items ADD COLUMN quantity_base INTEGER NOT NULL DEFAULT 0');
      try {
        await this.base.rawRun(`
          UPDATE transaction_items SET quantity_base =
            CASE WHEN unit_type = 'child' THEN quantity
                 ELSE quantity * conversion_factor_snapshot END
        `);
      } catch {}
      this.base.save();
    }

    // Legacy quantity column on fresh installs
    try { await this.base.rawRun('SELECT quantity FROM transaction_items LIMIT 0'); } catch {
      await this.base.rawRun('ALTER TABLE transaction_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 0');
      this.base.save();
    }
  }

  private async _migrateCashTendered(): Promise<void> {
    try { await this.base.rawRun('SELECT cash_tendered FROM transactions LIMIT 0'); } catch {
      await this.base.rawRun('ALTER TABLE transactions ADD COLUMN cash_tendered INTEGER NOT NULL DEFAULT 0');
      await this.base.rawRun(`
        UPDATE transactions SET cash_tendered =
          CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END
      `);
      this.base.save();
    }
  }

  private async _migrateOldPaymentMethods(): Promise<void> {
    try {
      const rows = await this.base.getAll<{ payment_method: string }>(
        "SELECT DISTINCT payment_method FROM transactions WHERE payment_method IN ('card', 'mobile', 'credit')"
      );
      if (rows.length > 0) {
        await this.base.rawRun(
          "UPDATE transactions SET payment_method = 'bank_transfer' WHERE payment_method IN ('card', 'mobile', 'credit')"
        );
        this.base.save();
      }
    } catch {}
  }

  private async _migrateCashDropUserId(): Promise<void> {
    try { await this.base.rawRun('SELECT user_id FROM cash_drops LIMIT 0'); } catch {
      await this.base.rawRun('ALTER TABLE cash_drops ADD COLUMN user_id INTEGER');
      await this.base.rawRun(`
        UPDATE cash_drops SET user_id = (SELECT user_id FROM shifts WHERE shifts.id = cash_drops.shift_id)
      `);
      await this.base.rawRun('UPDATE cash_drops SET user_id = 1 WHERE user_id IS NULL');
      this.base.save();
    }
  }

  private async _migrateBatchStatus(): Promise<void> {
    try { await this.base.rawRun('SELECT status FROM batches LIMIT 0'); } catch {
      await this.base.rawRun("ALTER TABLE batches ADD COLUMN status TEXT DEFAULT 'active'");
      await this.base.rawRun("UPDATE batches SET status = 'sold_out' WHERE quantity_base = 0");
      this.base.save();
    }
  }

  // ─── Seed Data ───────────────────────────────────────────────────────────────

  private async _seedDefaultData(): Promise<void> {
    // Create admin user if missing
    const admin = await this.base.getOne<{ id: number }>('SELECT id FROM users WHERE username = ?', ['admin']);
    if (!admin) {
      const hash = hashPassword('admin123');
      await this.base.rawRun(
        `INSERT INTO users (username, password_hash, full_name, role,
         perm_finance, perm_inventory, perm_reports, must_change_password)
         VALUES (?, ?, ?, ?, 1, 1, 1, 1)`,
        ['admin', hash, 'System Administrator', 'admin']
      );
      console.log('='.repeat(60));
      console.log('Default admin password: admin123');
      console.log('='.repeat(60));
    }

    // Seed expense categories
    const categories = ['Salaries', 'Utilities', 'Rent', 'Maintenance', 'Supplies', 'Transport', 'Other'];
    for (const name of categories) {
      await this.base.rawRun('INSERT OR IGNORE INTO expense_categories (name) VALUES (?)', [name]);
    }

    // Seed default settings
    const defaults: Record<string, string> = {
      currency: 'SDG',
      currency_symbol: 'SDG',
      business_name: 'PharmaSys Pharmacy',
      backup_interval_hours: '6',
      expiry_warning_days: '90',
      default_markup_percent: '20',
      bank_config: JSON.stringify([
        { id: 'bok', name: 'Bank of Khartoum (BoK)', account_number: '', enabled: true },
        { id: 'fawry', name: 'Fawry', account_number: '', enabled: true },
        { id: 'ocash', name: 'OCash', account_number: '', enabled: true },
      ]),
    };
    for (const [key, value] of Object.entries(defaults)) {
      await this.base.rawRun('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  // ─── Demo / Sample Data ─────────────────────────────────────────────────────

  private async _seedDemoData(): Promise<void> {
    // Only seed if no products exist yet (fresh install)
    const existing = await this.base.getOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM products');
    if (existing && existing.cnt > 0) return;

    console.log('[Demo] Seeding demo data …');

    // ── Additional users ──
    const pharmaHash = hashPassword('pharma123');
    await this.base.rawRun(
      `INSERT OR IGNORE INTO users (username, password_hash, full_name, role,
       perm_finance, perm_inventory, perm_reports, must_change_password)
       VALUES (?, ?, ?, ?, 0, 1, 1, 0)`,
      ['pharmacist', pharmaHash, 'Ahmed Mohamed', 'pharmacist']
    );
    const cashierHash = hashPassword('cashier123');
    await this.base.rawRun(
      `INSERT OR IGNORE INTO users (username, password_hash, full_name, role,
       perm_finance, perm_inventory, perm_reports, must_change_password)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0)`,
      ['cashier', cashierHash, 'Sara Ibrahim', 'cashier']
    );

    // ── Product categories ──
    const cats = ['Antibiotics', 'Pain Relief', 'Vitamins & Supplements', 'Skin Care', 'Respiratory', 'Gastrointestinal', 'Cardiovascular', 'Diabetes'];
    for (const name of cats) {
      await this.base.rawRun('INSERT OR IGNORE INTO categories (name) VALUES (?)', [name]);
    }

    // Helper: look up category id by name
    const catId = async (name: string): Promise<number> => {
      const row = await this.base.getOne<{ id: number }>('SELECT id FROM categories WHERE name = ?', [name]);
      return row!.id;
    };

    // Dates for batches
    const today = new Date();
    const dateStr = (monthsFromNow: number): string => {
      const d = new Date(today);
      d.setMonth(d.getMonth() + monthsFromNow);
      return d.toISOString().slice(0, 10);
    };

    // ── Products + Batches ──
    // All prices in INTEGER piastres (1 SDG = 100).
    // cost_per_child = floor(cost_per_parent / conversion_factor)
    // selling_price_child = floor(selling_price_parent / conversion_factor)
    interface DemoProduct {
      name: string; generic: string; catName: string; barcode: string;
      parentUnit: string; childUnit: string; convFactor: number; minStock: number;
      usage?: string;
      batches: Array<{
        batchNo: string; expiryMonths: number; qtyParent: number;
        costParent: number; sellParent: number;
      }>;
    }

    // All prices in whole SDG (no piastres — SDG has no minor currency units)
    const products: DemoProduct[] = [
      {
        name: 'Amoxicillin 500mg', generic: 'Amoxicillin', catName: 'Antibiotics',
        barcode: '6001234000011', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 20,
        usage: 'Take 1 capsule 3 times daily after meals for 7 days. Complete the full course.',
        batches: [
          { batchNo: 'AMX-2024-001', expiryMonths: 8,  qtyParent: 100, costParent: 750, sellParent: 1000 },
          { batchNo: 'AMX-2025-001', expiryMonths: 16, qtyParent: 120, costParent: 780, sellParent: 1000 },
          { batchNo: 'AMX-2025-002', expiryMonths: 22, qtyParent: 60,  costParent: 780, sellParent: 1000 },
        ],
      },
      {
        name: 'Paracetamol 500mg', generic: 'Paracetamol', catName: 'Pain Relief',
        barcode: '6001234000028', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 30,
        usage: 'Take 1-2 tablets every 4-6 hours as needed. Max 8 tablets per day.',
        batches: [
          { batchNo: 'PCM-2023-001', expiryMonths: -1, qtyParent: 15,  costParent: 380, sellParent: 550 }, // Expired last month
          { batchNo: 'PCM-2024-001', expiryMonths: 10, qtyParent: 120, costParent: 400, sellParent: 550 },
          { batchNo: 'PCM-2025-001', expiryMonths: 18, qtyParent: 150, costParent: 420, sellParent: 550 },
          { batchNo: 'PCM-2025-002', expiryMonths: 24, qtyParent: 80,  costParent: 420, sellParent: 550 },
        ],
      },
      {
        name: 'Ibuprofen 400mg', generic: 'Ibuprofen', catName: 'Pain Relief',
        barcode: '6001234000035', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 20,
        usage: 'Take 1 tablet 3 times daily after meals. Not for use on empty stomach.',
        batches: [
          { batchNo: 'IBU-2024-001', expiryMonths: 9,  qtyParent: 80,  costParent: 420, sellParent: 580 },
          { batchNo: 'IBU-2025-001', expiryMonths: 16, qtyParent: 100, costParent: 440, sellParent: 580 },
        ],
      },
      {
        name: 'Azithromycin 250mg', generic: 'Azithromycin', catName: 'Antibiotics',
        barcode: '6001234000042', parentUnit: 'Box', childUnit: 'Strip', convFactor: 6, minStock: 10,
        usage: 'Take 2 tablets on day 1, then 1 tablet daily for 4 days. Take 1 hour before meals.',
        batches: [
          { batchNo: 'AZI-2024-001', expiryMonths: 7,  qtyParent: 40, costParent: 900,  sellParent: 1200 },
          { batchNo: 'AZI-2025-001', expiryMonths: 18, qtyParent: 50, costParent: 920,  sellParent: 1200 },
        ],
      },
      {
        name: 'Omeprazole 20mg', generic: 'Omeprazole', catName: 'Gastrointestinal',
        barcode: '6001234000059', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        usage: 'Take 1 capsule daily before breakfast. Swallow whole, do not crush or chew.',
        batches: [
          { batchNo: 'OMP-2024-001', expiryMonths: 12, qtyParent: 100, costParent: 520, sellParent: 720 },
          { batchNo: 'OMP-2025-001', expiryMonths: 20, qtyParent: 80,  costParent: 540, sellParent: 720 },
        ],
      },
      {
        name: 'Metformin 500mg', generic: 'Metformin', catName: 'Diabetes',
        barcode: '6001234000066', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 25,
        usage: 'Take 1 tablet twice daily with meals. Monitor blood sugar regularly.',
        batches: [
          { batchNo: 'MET-2023-001', expiryMonths: -3, qtyParent: 8,   costParent: 360, sellParent: 520 }, // Expired 3 months ago
          { batchNo: 'MET-2024-001', expiryMonths: 2,  qtyParent: 40,  costParent: 380, sellParent: 520 },
          { batchNo: 'MET-2025-001', expiryMonths: 14, qtyParent: 120, costParent: 400, sellParent: 520 },
          { batchNo: 'MET-2025-002', expiryMonths: 22, qtyParent: 100, costParent: 400, sellParent: 520 },
        ],
      },
      {
        name: 'Amlodipine 5mg', generic: 'Amlodipine', catName: 'Cardiovascular',
        barcode: '6001234000073', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        usage: 'Take 1 tablet once daily at the same time each day. Can be taken with or without food.',
        batches: [
          { batchNo: 'AML-2024-001', expiryMonths: 10, qtyParent: 70,  costParent: 450, sellParent: 620 },
          { batchNo: 'AML-2025-001', expiryMonths: 18, qtyParent: 80,  costParent: 470, sellParent: 620 },
        ],
      },
      {
        name: 'Vitamin C 1000mg', generic: 'Ascorbic Acid', catName: 'Vitamins & Supplements',
        barcode: '6001234000080', parentUnit: 'Bottle', childUnit: 'Tablet', convFactor: 30, minStock: 10,
        usage: 'Take 1 tablet daily with water. Best taken with a meal.',
        batches: [
          { batchNo: 'VTC-2024-001', expiryMonths: 14, qtyParent: 60, costParent: 400, sellParent: 560 },
          { batchNo: 'VTC-2025-001', expiryMonths: 26, qtyParent: 50, costParent: 420, sellParent: 560 },
        ],
      },
      {
        name: 'Cetirizine 10mg', generic: 'Cetirizine', catName: 'Respiratory',
        barcode: '6001234000097', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        usage: 'Take 1 tablet once daily. May cause drowsiness, avoid driving.',
        batches: [
          { batchNo: 'CTZ-2023-001', expiryMonths: -2, qtyParent: 12, costParent: 340, sellParent: 500 }, // Expired 2 months ago
          { batchNo: 'CTZ-2024-001', expiryMonths: 8,  qtyParent: 80, costParent: 360, sellParent: 500 },
          { batchNo: 'CTZ-2025-001', expiryMonths: 20, qtyParent: 70, costParent: 380, sellParent: 500 },
        ],
      },
      {
        name: 'Betadine Solution 120ml', generic: 'Povidone-Iodine', catName: 'Skin Care',
        barcode: '6001234000103', parentUnit: 'Bottle', childUnit: 'Bottle', convFactor: 1, minStock: 10,
        usage: 'Apply to affected area 2-3 times daily. For external use only.',
        batches: [
          { batchNo: 'BTD-2024-001', expiryMonths: 12, qtyParent: 60, costParent: 500, sellParent: 680 },
          { batchNo: 'BTD-2025-001', expiryMonths: 24, qtyParent: 50, costParent: 520, sellParent: 680 },
        ],
      },
      {
        name: 'Salbutamol Inhaler', generic: 'Salbutamol', catName: 'Respiratory',
        barcode: '6001234000110', parentUnit: 'Piece', childUnit: 'Piece', convFactor: 1, minStock: 8,
        usage: 'Inhale 1-2 puffs as needed for breathlessness. Shake well before each use.',
        batches: [
          { batchNo: 'SAL-2024-001', expiryMonths: 6,  qtyParent: 30, costParent: 620, sellParent: 820 },
          { batchNo: 'SAL-2025-001', expiryMonths: 14, qtyParent: 40, costParent: 640, sellParent: 820 },
        ],
      },
      {
        name: 'Ciprofloxacin 500mg', generic: 'Ciprofloxacin', catName: 'Antibiotics',
        barcode: '6001234000127', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 10,
        usage: 'Take 1 tablet twice daily with plenty of water. Avoid dairy products within 2 hours.',
        batches: [
          { batchNo: 'CIP-2024-001', expiryMonths: 8,  qtyParent: 50, costParent: 720, sellParent: 950 },
          { batchNo: 'CIP-2025-001', expiryMonths: 18, qtyParent: 60, costParent: 740, sellParent: 950 },
        ],
      },
      {
        name: 'Diclofenac Gel 50g', generic: 'Diclofenac', catName: 'Skin Care',
        barcode: '6001234000134', parentUnit: 'Tube', childUnit: 'Tube', convFactor: 1, minStock: 10,
        usage: 'Apply a thin layer to affected area 3-4 times daily. Massage gently. For external use only.',
        batches: [
          { batchNo: 'DCL-2024-001', expiryMonths: 10, qtyParent: 40, costParent: 420, sellParent: 580 },
          { batchNo: 'DCL-2025-001', expiryMonths: 22, qtyParent: 40, costParent: 440, sellParent: 580 },
        ],
      },
      {
        name: 'Multivitamin Complex', generic: 'Multivitamin', catName: 'Vitamins & Supplements',
        barcode: '6001234000141', parentUnit: 'Bottle', childUnit: 'Tablet', convFactor: 60, minStock: 8,
        usage: 'Take 1 tablet daily with breakfast. Do not exceed recommended dose.',
        batches: [
          { batchNo: 'MVT-2024-001', expiryMonths: 14, qtyParent: 35, costParent: 650, sellParent: 880 },
          { batchNo: 'MVT-2025-001', expiryMonths: 26, qtyParent: 30, costParent: 680, sellParent: 880 },
        ],
      },
      {
        name: 'Losartan 50mg', generic: 'Losartan', catName: 'Cardiovascular',
        barcode: '6001234000158', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        usage: 'Take 1 tablet once daily. Monitor blood pressure regularly.',
        batches: [
          { batchNo: 'LOS-2024-001', expiryMonths: 3,  qtyParent: 30,  costParent: 500, sellParent: 680 },
          { batchNo: 'LOS-2025-001', expiryMonths: 16, qtyParent: 100, costParent: 520, sellParent: 680 },
          { batchNo: 'LOS-2025-002', expiryMonths: 24, qtyParent: 60,  costParent: 520, sellParent: 680 },
        ],
      },
    ];

    for (const p of products) {
      await this.base.rawRun(
        `INSERT INTO products (name, generic_name, category_id, barcode,
         parent_unit, child_unit, conversion_factor, min_stock_level, usage_instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.name, p.generic, await catId(p.catName), p.barcode,
         p.parentUnit, p.childUnit, p.convFactor, p.minStock, p.usage ?? null]
      );
      const prod = await this.base.getOne<{ id: number }>(
        'SELECT id FROM products WHERE barcode = ?', [p.barcode]
      );
      if (!prod) continue;

      for (const b of p.batches) {
        const qtyBase = b.qtyParent * p.convFactor;
        const costChild = Math.floor(b.costParent / p.convFactor);
        const sellChild = Math.floor(b.sellParent / p.convFactor);
        await this.base.rawRun(
          `INSERT INTO batches (product_id, batch_number, expiry_date,
           quantity_base, cost_per_parent, cost_per_child, cost_per_child_override,
           selling_price_parent, selling_price_child,
           selling_price_parent_override, selling_price_child_override, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [prod.id, b.batchNo, dateStr(b.expiryMonths),
           qtyBase, b.costParent, costChild, costChild,
           b.sellParent, sellChild,
           b.sellParent, sellChild]
        );
      }
    }

    console.log(`[Demo] Seeded ${products.length} products, ${cats.length} categories, 2 staff users`);
    console.log('[Demo] Demo users: pharmacist / pharma123, cashier / cashier123');
  }

  // ─── Historical Demo Data (3 months of comprehensive business simulation) ──

  private async _seedHistoricalData(): Promise<void> {
    const has = await this.base.getOne<{ c: number }>('SELECT COUNT(*) as c FROM transactions');
    if (has && has.c > 0) return;

    // ── Load reference data ──
    const prods = await this.base.getAll<{
      id: number; conversion_factor: number; name: string;
    }>('SELECT id, conversion_factor, name FROM products WHERE is_active = 1 ORDER BY id');

    const nowStr = new Date().toISOString().slice(0, 10);
    const bList = await this.base.getAll<{
      id: number; product_id: number; selling_price_parent: number;
      selling_price_child: number; cost_per_parent: number;
      cost_per_child: number; quantity_base: number; expiry_date: string;
    }>("SELECT id, product_id, selling_price_parent, selling_price_child, cost_per_parent, cost_per_child, quantity_base, expiry_date FROM batches WHERE status='active'",
      []);

    const users = await this.base.getAll<{ id: number; role: string }>('SELECT id, role FROM users');
    const adminUser = users.find(u => u.role === 'admin') ?? users[0];
    const staffUsers = users.filter(u => u.role !== 'admin');
    if (staffUsers.length === 0) staffUsers.push(adminUser);

    const expCats = await this.base.getAll<{ id: number; name: string }>('SELECT id, name FROM expense_categories');
    const rentCatId = expCats.find(c => c.name === 'Rent')?.id ?? expCats[0].id;
    const salariesCatId = expCats.find(c => c.name === 'Salaries')?.id ?? expCats[0].id;
    const utilitiesCatId = expCats.find(c => c.name === 'Utilities')?.id ?? expCats[0].id;

    // ── Build productId → batches map (track stock in-memory) ──
    const bm = new Map<number, typeof bList>();
    for (const b of bList) {
      if (!bm.has(b.product_id)) bm.set(b.product_id, []);
      bm.get(b.product_id)!.push(b);
    }

    // Helper: find a batch with enough stock (FIFO by expiry, skip expired)
    const findBatch = (productId: number, minQty: number, dateStr: string) => {
      const bs = bm.get(productId);
      if (!bs) return undefined;
      return bs.find(x => x.quantity_base >= minQty && x.expiry_date > dateStr);
    };

    const today = new Date();
    const start = new Date(today);
    start.setMonth(start.getMonth() - 3);

    let saleSeq = 0;
    let rtnSeq = 0;
    let day = 0;
    const d = new Date(start);
    const rentSeenMonths = new Set<string>();
    const salarySeenMonths = new Set<string>();

    // Track sales for returns/voids (store recent sale IDs with their items)
    const recentSales: Array<{
      txnId: number; day: number; shiftId: number; userId: number;
      items: Array<{ pid: number; bid: number; qb: number; up: number; cp: number; cf: number; unitType: string }>;
      total: number; paymentMethod: string;
    }> = [];

    // Expense descriptions with realistic variety
    const expenseDescs: Array<{ desc: string; catIdx: number; minAmt: number; maxAmt: number }> = [
      { desc: 'Office supplies - printer paper', catIdx: 4, minAmt: 100, maxAmt: 300 },
      { desc: 'Cleaning supplies', catIdx: 4, minAmt: 80, maxAmt: 200 },
      { desc: 'Electricity bill', catIdx: 1, minAmt: 400, maxAmt: 800 },
      { desc: 'Water bill', catIdx: 1, minAmt: 100, maxAmt: 250 },
      { desc: 'Transport - delivery pickup', catIdx: 5, minAmt: 150, maxAmt: 400 },
      { desc: 'AC maintenance', catIdx: 3, minAmt: 300, maxAmt: 600 },
      { desc: 'Staff meals', catIdx: 6, minAmt: 100, maxAmt: 300 },
      { desc: 'Internet subscription', catIdx: 1, minAmt: 200, maxAmt: 350 },
      { desc: 'Pest control service', catIdx: 3, minAmt: 200, maxAmt: 400 },
      { desc: 'Generator fuel', catIdx: 1, minAmt: 300, maxAmt: 700 },
    ];

    // Deterministic pseudo-random with good distribution (safe 32-bit hash)
    const pseudo = (a: number, b: number): number => {
      // Use imul() for correct 32-bit integer multiplication (avoids float64 precision loss)
      let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + 1013904223) | 0;
      h = (Math.imul(h ^ (h >>> 13), 1274126177)) | 0;
      h = (h ^ (h >>> 16)) | 0;
      return h < 0 ? -h : h;
    };

    console.log('[Demo] Seeding 3-month comprehensive business history …');

    while (d < today) {
      if (d.getDay() === 5) { d.setDate(d.getDate() + 1); continue; } // Skip Friday
      const ds = d.toISOString().slice(0, 10);
      const dCompact = ds.replace(/-/g, '');
      const uid = staffUsers[day % staffUsers.length].id;
      const opening = 500 + (pseudo(day, 1) % 5) * 100; // 500-900 SDG

      // ══════════════════════════════════════════════════════════════════════════
      // ── OPEN SHIFT ──
      // ══════════════════════════════════════════════════════════════════════════
      const sid = await this.base.rawRunReturningId(
        "INSERT INTO shifts (user_id, opened_at, opening_amount, status) VALUES (?,?,?,'open')",
        [uid, `${ds} 08:00:00`, opening]
      );

      let cashIn = 0;
      let cashOut = 0;

      // ══════════════════════════════════════════════════════════════════════════
      // ── SALES (6-15 per day, mix of cash/bank/mixed, some with discounts) ──
      // ══════════════════════════════════════════════════════════════════════════
      const numSales = 6 + (pseudo(day, 2) % 10); // 6-15 per day

      for (let s = 0; s < numSales; s++) {
        saleSeq++;
        const tnum = `TXN-${dCompact}-${String(saleSeq).padStart(4, '0')}`;
        const nItems = 1 + (pseudo(day, s * 3 + 10) % 3); // 1-3 items
        let sub = 0;
        let totalCost = 0;
        const items: Array<{ pid: number; bid: number; qb: number; up: number; cp: number; cf: number; unitType: string }> = [];

        for (let i = 0; i < nItems; i++) {
          const pi = pseudo(day, s * 11 + i * 17 + 5) % prods.length;
          const p = prods[pi];
          const b = findBatch(p.id, p.conversion_factor, ds);
          if (!b) continue;
          if (items.some(x => x.pid === p.id)) continue;

          // ~20% chance of child unit sale (single strip/tablet)
          const sellChild = (pseudo(day, s * 7 + i * 23) % 5) === 0 && p.conversion_factor > 1;
          let qb: number, up: number, cp: number, unitType: string;

          if (sellChild) {
            // Sell 1-3 child units
            const childQty = 1 + (pseudo(day, s + i * 3) % 3);
            qb = Math.min(childQty, b.quantity_base);
            up = b.selling_price_child || Math.floor(b.selling_price_parent / p.conversion_factor);
            cp = b.cost_per_child || Math.floor(b.cost_per_parent / p.conversion_factor);
            unitType = 'child';
          } else {
            // Sell 1 parent unit (sometimes 2 for common items)
            const parentQty = (pseudo(day, s + i) % 8 === 0) ? 2 : 1;
            qb = Math.min(parentQty * p.conversion_factor, b.quantity_base);
            up = b.selling_price_parent;
            cp = b.cost_per_parent;
            unitType = 'parent';
          }

          if (qb <= 0) continue;
          b.quantity_base -= qb;

          const linePrice = unitType === 'parent'
            ? up * Math.round(qb / p.conversion_factor)
            : up * qb;
          const lineCost = unitType === 'parent'
            ? cp * Math.round(qb / p.conversion_factor)
            : cp * qb;

          sub += linePrice;
          totalCost += lineCost;
          items.push({ pid: p.id, bid: b.id, qb, up, cp, cf: p.conversion_factor, unitType });
        }
        if (items.length === 0) continue;

        // ── Discount: ~15% of sales get a small discount (5-15%) ──
        let discountAmt = 0;
        let discountPct = 0;
        if (pseudo(day, s * 19) % 7 === 0) {
          discountPct = 5 + (pseudo(day, s * 23) % 11); // 5-15%
          discountAmt = Math.floor(sub * discountPct / 100);
        }
        const total = sub - discountAmt;

        // ── Payment method: ~70% cash, ~20% bank, ~10% mixed ──
        const pmRoll = pseudo(day, s * 31) % 10;
        let pm: string, ct: number, bankName: string | null = null, refNo: string | null = null;
        let paymentJson: string | null = null;

        if (pmRoll < 7) {
          // Cash (70%)
          pm = 'cash';
          // Round up to nearest denomination for cash tendered
          const denoms = [100, 200, 500, 1000, 2000, 5000];
          ct = total;
          for (const den of denoms) {
            if (den >= total) { ct = den; break; }
          }
          if (ct < total) ct = Math.ceil(total / 1000) * 1000;
          cashIn += total;
        } else if (pmRoll < 9) {
          // Bank transfer (20%)
          pm = 'bank_transfer';
          ct = 0;
          const banks = ['Bank of Khartoum (BoK)', 'Fawry', 'OCash'];
          bankName = banks[pseudo(day, s * 13) % banks.length];
          refNo = `REF-${dCompact}-${String(pseudo(day, s) % 9999).padStart(4, '0')}`;
        } else {
          // Mixed payment (10%)
          pm = 'mixed';
          const cashPortion = Math.floor(total * 0.6); // 60% cash
          const bankPortion = total - cashPortion;
          ct = cashPortion;
          cashIn += cashPortion;
          bankName = 'Bank of Khartoum (BoK)';
          refNo = `REF-${dCompact}-${String(pseudo(day, s) % 9999).padStart(4, '0')}`;
          paymentJson = JSON.stringify({ cash: cashPortion, bank_transfer: bankPortion });
        }

        // Spread sales across 08:00-18:00
        const h = 8 + Math.floor((s * 10) / numSales);
        const mn = (pseudo(day, s * 37) % 60);
        const ts = `${ds} ${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}:00`;

        // ~5% of sales have customer info
        const hasCustomer = pseudo(day, s * 41) % 20 === 0;
        const customerName = hasCustomer ? `Customer ${pseudo(day, s) % 100}` : null;
        const customerPhone = hasCustomer ? `09${String(pseudo(day, s * 3) % 100000000).padStart(8, '0')}` : null;

        const tid = await this.base.rawRunReturningId(
          `INSERT INTO transactions (transaction_number,user_id,shift_id,transaction_type,
           subtotal,discount_amount,tax_amount,total_amount,payment_method,
           bank_name,reference_number,cash_tendered,payment,
           customer_name,customer_phone,created_at)
           VALUES (?,?,?,'sale',?,?,0,?,?,?,?,?,?,?,?,?)`,
          [tnum, uid, sid, sub, discountAmt, total, pm, bankName, refNo, ct, paymentJson,
           customerName, customerPhone, ts]
        );

        for (const it of items) {
          const lineTotal = it.unitType === 'parent'
            ? it.up * Math.round(it.qb / it.cf)
            : it.up * it.qb;
          const lineCost = it.unitType === 'parent'
            ? it.cp * Math.round(it.qb / it.cf)
            : it.cp * it.qb;
          // Apply proportional discount to line
          const lineDiscount = discountAmt > 0 ? Math.floor(lineTotal * discountPct / 100) : 0;
          const finalLine = lineTotal - lineDiscount;
          const gp = finalLine - lineCost;

          await this.base.rawRun(
            `INSERT INTO transaction_items (transaction_id,product_id,batch_id,quantity_base,
             unit_type,unit_price,cost_price,discount_percent,line_total,gross_profit,
             conversion_factor_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [tid, it.pid, it.bid, it.qb, it.unitType, it.up, it.cp, discountPct, finalLine, gp, it.cf]
          );
        }

        // Store for potential return/void later
        recentSales.push({
          txnId: tid, day, shiftId: sid, userId: uid,
          items, total, paymentMethod: pm,
        });
        // Keep only last 30 sales for return/void candidates
        if (recentSales.length > 30) recentSales.shift();
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── RETURNS (~3% of days, return 1 item from a recent sale) ──
      // ══════════════════════════════════════════════════════════════════════════
      if (pseudo(day, 100) % 8 === 0 && recentSales.length > 3) {
        const saleIdx = pseudo(day, 101) % Math.min(recentSales.length, 10);
        const origSale = recentSales[recentSales.length - 1 - saleIdx];
        if (origSale && origSale.items.length > 0) {
          const retItem = origSale.items[0]; // Return the first item
          const retQb = retItem.unitType === 'parent' ? retItem.cf : 1; // Return 1 unit
          if (retQb <= retItem.qb) {
            rtnSeq++;
            const rtnNum = `RTN-${dCompact}-${String(rtnSeq).padStart(4, '0')}`;
            const retPrice = retItem.unitType === 'parent' ? retItem.up : retItem.up;
            const retTotal = retPrice;

            const rtnH = 10 + (pseudo(day, 102) % 6);
            const rtnTs = `${ds} ${String(rtnH).padStart(2, '0')}:${String(pseudo(day, 103) % 60).padStart(2, '0')}:00`;

            const rtnId = await this.base.rawRunReturningId(
              `INSERT INTO transactions (transaction_number,user_id,shift_id,transaction_type,
               subtotal,discount_amount,tax_amount,total_amount,payment_method,
               cash_tendered,parent_transaction_id,notes,created_at)
               VALUES (?,?,?,'return',?,0,0,?,'cash',?,?,?,?)`,
              [rtnNum, uid, sid, retTotal, retTotal, retTotal, origSale.txnId,
               'Customer return - product issue', rtnTs]
            );

            const retLineCost = retItem.unitType === 'parent' ? retItem.cp : retItem.cp;
            const retGp = -(retTotal - retLineCost);

            await this.base.rawRun(
              `INSERT INTO transaction_items (transaction_id,product_id,batch_id,quantity_base,
               unit_type,unit_price,cost_price,discount_percent,line_total,gross_profit,
               conversion_factor_snapshot) VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
              [rtnId, retItem.pid, retItem.bid, retQb, retItem.unitType,
               retItem.up, retItem.cp, retTotal, retGp, retItem.cf]
            );

            // Restore stock to batch
            const batchList = bm.get(retItem.pid);
            const retBatch = batchList?.find(x => x.id === retItem.bid);
            if (retBatch) retBatch.quantity_base += retQb;

            cashOut += retTotal; // Cash refund
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── VOIDS (~2% of days, void a recent same-day sale) ──
      // ══════════════════════════════════════════════════════════════════════════
      if (pseudo(day, 200) % 12 === 0 && recentSales.length > 1) {
        // Find a same-day sale to void
        const sameDaySale = recentSales.filter(s => s.day === day).pop();
        if (sameDaySale) {
          const voidTs = `${ds} ${String(14 + pseudo(day, 201) % 4).padStart(2, '0')}:00:00`;
          const voidReasons = [
            'Customer changed mind before leaving',
            'Wrong product entered',
            'Price entry error',
            'Duplicate transaction',
          ];
          const voidReason = voidReasons[pseudo(day, 202) % voidReasons.length];

          await this.base.rawRun(
            `UPDATE transactions SET is_voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?`,
            [voidReason, adminUser.id, voidTs, sameDaySale.txnId]
          );

          // Restore stock for voided sale
          for (const it of sameDaySale.items) {
            const batchList = bm.get(it.pid);
            const voidBatch = batchList?.find(x => x.id === it.bid);
            if (voidBatch) voidBatch.quantity_base += it.qb;
          }

          // Reverse cash if it was a cash sale
          if (sameDaySale.paymentMethod === 'cash') {
            cashIn -= sameDaySale.total;
          } else if (sameDaySale.paymentMethod === 'mixed') {
            cashIn -= Math.floor(sameDaySale.total * 0.6);
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── DAMAGE / EXPIRY REPORTS (~every 10 days) ──
      // ══════════════════════════════════════════════════════════════════════════
      if (pseudo(day, 300) % 10 === 0) {
        // Pick a random product and report damage on its oldest batch
        const dmgProdIdx = pseudo(day, 301) % prods.length;
        const dmgProd = prods[dmgProdIdx];
        const dmgBatches = bm.get(dmgProd.id);
        if (dmgBatches && dmgBatches.length > 0) {
          const dmgBatch = dmgBatches[0]; // Oldest batch
          const dmgQty = Math.min(
            dmgProd.conversion_factor * (1 + pseudo(day, 302) % 3), // 1-3 parent units worth
            Math.floor(dmgBatch.quantity_base * 0.3) // Max 30% of batch
          );

          if (dmgQty > 0) {
            // ~60% damage, ~30% expiry write-off, ~10% correction
            const typeRoll = pseudo(day, 303) % 10;
            const adjType = typeRoll < 6 ? 'damage' : typeRoll < 9 ? 'expiry' : 'correction';
            const adjReasons: Record<string, string[]> = {
              damage: ['Broken packaging during storage', 'Water damage from leak', 'Dropped during handling', 'Packaging crushed'],
              expiry: ['Expired stock write-off', 'Near-expiry removal per policy', 'Failed quality check'],
              correction: ['Stock count correction', 'Inventory audit adjustment'],
            };
            const reason = adjReasons[adjType][pseudo(day, 304) % adjReasons[adjType].length];

            await this.base.rawRun(
              `INSERT INTO inventory_adjustments (product_id, batch_id, quantity_base, reason, type, user_id, created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [dmgProd.id, dmgBatch.id, dmgQty, reason, adjType, adminUser.id, `${ds} 09:30:00`]
            );

            dmgBatch.quantity_base -= dmgQty;
            // Quarantine the batch if damage/expiry took significant stock
            if (adjType !== 'correction' && dmgBatch.quantity_base < dmgProd.conversion_factor * 2) {
              // Will be reflected in final batch update
            }
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── HELD SALES (~every 15 days, simulate a parked sale) ──
      // ══════════════════════════════════════════════════════════════════════════
      if (pseudo(day, 400) % 15 === 0) {
        const heldItems: Array<{
          product_id: number; product_name: string; batch_id: number;
          quantity: number; unit_type: string; unit_price: number;
        }> = [];
        let heldTotal = 0;

        for (let hi = 0; hi < 2; hi++) {
          const hpi = pseudo(day, 401 + hi) % prods.length;
          const hp = prods[hpi];
          const hb = findBatch(hp.id, hp.conversion_factor, ds);
          if (!hb || heldItems.some(x => x.product_id === hp.id)) continue;

          const hPrice = hb.selling_price_parent;
          heldItems.push({
            product_id: hp.id, product_name: hp.name, batch_id: hb.id,
            quantity: 1, unit_type: 'parent', unit_price: hPrice,
          });
          heldTotal += hPrice;
        }

        if (heldItems.length > 0) {
          const customerNotes = [
            'Customer will return in 30 minutes',
            'Waiting for bank transfer confirmation',
            'Customer checking insurance coverage',
            'Preparing prescription items',
          ];
          await this.base.rawRun(
            `INSERT INTO held_sales (user_id, customer_note, items_json, total_amount, created_at)
             VALUES (?,?,?,?,?)`,
            [uid, customerNotes[pseudo(day, 402) % customerNotes.length],
             JSON.stringify(heldItems), heldTotal, `${ds} 11:00:00`]
          );
          // ~70% of held sales get "completed" (deleted after being sold)
          // We just leave them as held for demo data variety; some will show as pending
          if (pseudo(day, 403) % 10 < 7) {
            // Mark as retrieved by deleting (simulating POS retrieval)
            await this.base.rawRun(
              'DELETE FROM held_sales WHERE user_id = ? AND created_at = ?',
              [uid, `${ds} 11:00:00`]
            );
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── EXPENSES (varied schedule, realistic types) ──
      // ══════════════════════════════════════════════════════════════════════════

      // Regular expenses every 2-3 days
      if (day % 3 === 0 || (day % 2 === 0 && pseudo(day, 500) % 3 === 0)) {
        const expIdx = pseudo(day, 501) % expenseDescs.length;
        const exp = expenseDescs[expIdx];
        const ea = exp.minAmt + (pseudo(day, 502) % (exp.maxAmt - exp.minAmt));
        const expCatId = expCats[exp.catIdx % expCats.length].id;
        // ~80% cash, ~20% bank_transfer for expenses
        const expPm = pseudo(day, 503) % 5 === 0 ? 'bank_transfer' : 'cash';
        await this.base.rawRun(
          "INSERT INTO expenses (category_id,amount,description,expense_date,payment_method,user_id,shift_id) VALUES (?,?,?,?,?,?,?)",
          [expCatId, ea, exp.desc, ds, expPm, uid, sid]
        );
        if (expPm === 'cash') cashOut += ea;
      }

      // Monthly rent (first working day of month)
      const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
      if (!rentSeenMonths.has(monthKey)) {
        rentSeenMonths.add(monthKey);
        await this.base.rawRun(
          "INSERT INTO expenses (category_id,amount,description,expense_date,payment_method,user_id,shift_id) VALUES (?,?,?,?,'cash',?,?)",
          [rentCatId, 3500, 'Monthly rent payment', ds, uid, sid]
        );
        cashOut += 3500;
      }

      // Monthly salaries (last working day each month — approximated as day 25+)
      const salaryKey = `${d.getFullYear()}-${d.getMonth()}`;
      if (!salarySeenMonths.has(salaryKey) && d.getDate() >= 25) {
        salarySeenMonths.add(salaryKey);
        // Pay each staff member
        for (let si = 0; si < staffUsers.length; si++) {
          const salaryAmt = staffUsers[si] === adminUser ? 0 : (4000 + si * 500); // 4000-4500 SDG
          if (salaryAmt > 0) {
            await this.base.rawRun(
              "INSERT INTO expenses (category_id,amount,description,expense_date,payment_method,user_id,shift_id) VALUES (?,?,?,?,'cash',?,?)",
              [salariesCatId, salaryAmt, `Salary - ${staffUsers[si].role}`, ds, uid, sid]
            );
            cashOut += salaryAmt;
          }
        }
      }

      // Quarterly utility bill (every ~30 days of simulation)
      if (day > 0 && day % 30 === 0) {
        const utilityAmt = 600 + (pseudo(day, 510) % 400); // 600-1000 SDG
        await this.base.rawRun(
          "INSERT INTO expenses (category_id,amount,description,expense_date,payment_method,user_id,shift_id) VALUES (?,?,?,?,'bank_transfer',?,?)",
          [utilitiesCatId, utilityAmt, 'Monthly electricity & water', ds, uid, sid]
        );
        // Bank transfer — doesn't affect cash
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── CASH DROPS (every 4-6 days, varied amounts) ──
      // ══════════════════════════════════════════════════════════════════════════
      if (day % 5 === 3 || (day % 4 === 0 && pseudo(day, 600) % 2 === 0)) {
        const dropAmt = 1500 + (pseudo(day, 601) % 4) * 500; // 1500-3000 SDG
        const dropReasons = [
          'Weekly cash drop to safe',
          'Excess cash removal',
          'Cash deposit for bank',
          'Owner withdrawal',
        ];
        const dropTs = `${ds} ${String(15 + pseudo(day, 602) % 3).padStart(2, '0')}:30:00`;
        await this.base.rawRun(
          'INSERT INTO cash_drops (shift_id,amount,reason,user_id,created_at) VALUES (?,?,?,?,?)',
          [sid, dropAmt, dropReasons[pseudo(day, 603) % dropReasons.length], uid, dropTs]
        );
        cashOut += dropAmt;
      }

      // ══════════════════════════════════════════════════════════════════════════
      // ── CLOSE SHIFT (with realistic variance patterns) ──
      // ══════════════════════════════════════════════════════════════════════════
      const expected = opening + cashIn - cashOut;
      // ~75% balanced, ~15% shortage (small), ~10% overage (small)
      const varRoll = pseudo(day, 700) % 20;
      let variance = 0;
      if (varRoll < 15) {
        variance = 0; // balanced
      } else if (varRoll < 18) {
        variance = -(50 + pseudo(day, 701) % 150); // shortage: -50 to -200
      } else {
        variance = 20 + pseudo(day, 702) % 80; // overage: +20 to +100
      }
      const actual = Math.max(0, expected + variance);
      const vt = variance > 0 ? 'overage' : variance < 0 ? 'shortage' : 'balanced';

      // Close at varying times (17:00-19:00)
      const closeH = 17 + (pseudo(day, 703) % 3);
      await this.base.rawRun(
        "UPDATE shifts SET closed_at=?,expected_cash=?,actual_cash=?,variance=?,variance_type=?,status='closed' WHERE id=?",
        [`${ds} ${closeH}:00:00`, Math.max(0, expected), actual, Math.abs(variance), vt, sid]
      );

      day++;
      d.setDate(d.getDate() + 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── PURCHASE ORDERS & SUPPLIERS ──
    // ══════════════════════════════════════════════════════════════════════════

    // Create "Supplier Payment" expense category
    await this.base.rawRun("INSERT OR IGNORE INTO expense_categories (name) VALUES ('Supplier Payment')");
    const supplierPayCat = await this.base.getOne<{ id: number }>(
      "SELECT id FROM expense_categories WHERE name = 'Supplier Payment'"
    );
    const supplierPayCatId = supplierPayCat!.id;

    // ── Create suppliers ──
    const supplierData = [
      { name: 'Al-Nile Pharmaceuticals',    phone: '0912345678', address: 'Khartoum Industrial Area, Block 4', notes: 'Main antibiotics supplier' },
      { name: 'Sudan Medical Supplies',      phone: '0918765432', address: 'Omdurman, Market Street 12',       notes: 'General medicines and OTC' },
      { name: 'Khartoum Drug House',         phone: '0915551234', address: 'Khartoum 2, Pharmacy Square',      notes: 'Vitamins and supplements specialist' },
      { name: 'Red Sea Imports Co.',         phone: '0911112233', address: 'Port Sudan, Industrial Zone',      notes: 'Imported medicines and medical supplies' },
      { name: 'Blue Nile Wholesale Pharma',  phone: '0919998877', address: 'Bahri, Industrial District 3',     notes: 'Bulk orders, competitive pricing' },
    ];

    const supplierIds: number[] = [];
    for (const s of supplierData) {
      const sid = await this.base.rawRunReturningId(
        'INSERT INTO suppliers (name, phone, address, notes) VALUES (?,?,?,?)',
        [s.name, s.phone, s.address, s.notes]
      );
      supplierIds.push(sid);
    }

    // Dates for purchase history
    const todayStr = today.toISOString().slice(0, 10);
    const purchaseStart = new Date(today);
    purchaseStart.setMonth(purchaseStart.getMonth() - 3);

    // ── Create purchase orders across the 3-month period ──
    // Mix of: fully paid, installments (partial/unpaid/overdue)
    interface PurchaseSpec {
      suppIdx: number; daysFromStart: number; prodIdxs: number[];
      qtys: number[]; paymentType: 'full' | 'installments';
      installmentCount?: number; monthsBetween?: number;
    }
    const purchaseSpecs: PurchaseSpec[] = [
      // Fully paid purchases (mostly early in timeline)
      { suppIdx: 0, daysFromStart: 5,  prodIdxs: [0, 3, 11],  qtys: [40, 20, 25], paymentType: 'full' },
      { suppIdx: 1, daysFromStart: 12, prodIdxs: [1, 2, 4],   qtys: [60, 35, 40], paymentType: 'full' },
      { suppIdx: 2, daysFromStart: 20, prodIdxs: [7, 13],      qtys: [25, 15],     paymentType: 'full' },
      { suppIdx: 4, daysFromStart: 28, prodIdxs: [5, 6, 14],  qtys: [50, 30, 40], paymentType: 'full' },
      { suppIdx: 0, daysFromStart: 45, prodIdxs: [0, 8, 10],  qtys: [30, 40, 15], paymentType: 'full' },
      { suppIdx: 3, daysFromStart: 55, prodIdxs: [9, 12],      qtys: [30, 20],     paymentType: 'full' },
      // Installment purchases (mix of paid/partial/overdue)
      { suppIdx: 1, daysFromStart: 35, prodIdxs: [1, 2, 5, 6], qtys: [80, 50, 60, 40], paymentType: 'installments', installmentCount: 3, monthsBetween: 1 },
      { suppIdx: 0, daysFromStart: 50, prodIdxs: [0, 3, 11],   qtys: [60, 30, 40],     paymentType: 'installments', installmentCount: 2, monthsBetween: 1 },
      { suppIdx: 4, daysFromStart: 60, prodIdxs: [4, 5, 14],   qtys: [40, 50, 30],     paymentType: 'installments', installmentCount: 3, monthsBetween: 1 },
      { suppIdx: 2, daysFromStart: 70, prodIdxs: [7, 8, 13],   qtys: [20, 30, 12],     paymentType: 'installments', installmentCount: 2, monthsBetween: 1 },
      { suppIdx: 3, daysFromStart: 75, prodIdxs: [9, 10, 12],  qtys: [25, 20, 15],     paymentType: 'installments', installmentCount: 3, monthsBetween: 1 },
      // Recent purchases (last 2 weeks) — mostly unpaid installments
      { suppIdx: 0, daysFromStart: 82, prodIdxs: [0, 11],      qtys: [50, 30],          paymentType: 'installments', installmentCount: 2, monthsBetween: 1 },
      { suppIdx: 1, daysFromStart: 85, prodIdxs: [1, 4, 6],   qtys: [70, 45, 25],      paymentType: 'installments', installmentCount: 3, monthsBetween: 1 },
    ];

    let purSeq = 0;
    for (const spec of purchaseSpecs) {
      const purDate = new Date(purchaseStart);
      purDate.setDate(purDate.getDate() + spec.daysFromStart);
      if (purDate > today) continue;
      const purDs = purDate.toISOString().slice(0, 10);
      const purCompact = purDs.replace(/-/g, '');
      purSeq++;
      const purNum = `PUR-${purCompact}-${String(purSeq).padStart(3, '0')}`;
      const suppId = supplierIds[spec.suppIdx % supplierIds.length];

      // Calculate total from items
      let totalAmount = 0;
      const itemData: Array<{ prodId: number; qty: number; cost: number; sell: number; cf: number }> = [];
      for (let i = 0; i < spec.prodIdxs.length; i++) {
        const prodIdx = spec.prodIdxs[i] % prods.length;
        const prod = prods[prodIdx];
        const qty = spec.qtys[i] ?? 10;
        // Look up existing batch cost for this product
        const existingBatches = bm.get(prod.id);
        const refBatch = existingBatches?.[existingBatches.length - 1];
        const cost = refBatch ? refBatch.cost_per_parent : 500;
        const sell = refBatch ? refBatch.selling_price_parent : 700;
        const lineTotal = cost * qty;
        totalAmount += lineTotal;
        itemData.push({ prodId: prod.id, qty, cost, sell, cf: prod.conversion_factor });
      }

      const isPaidFull = spec.paymentType === 'full';
      const initialPaid = isPaidFull ? totalAmount : 0;
      const initialStatus = isPaidFull ? 'paid' : 'unpaid';

      const purId = await this.base.rawRunReturningId(
        `INSERT INTO purchases (purchase_number, supplier_id, invoice_reference, purchase_date,
         total_amount, total_paid, payment_status, alert_days_before, notes, user_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [purNum, suppId, `INV-${purCompact}-${purSeq}`, purDs,
         totalAmount, initialPaid, initialStatus, 7,
         `Stock replenishment order #${purSeq}`, adminUser.id, `${purDs} 09:00:00`]
      );

      // Insert purchase items (batches were already created by _seedDemoData, just link)
      for (const it of itemData) {
        const batchesForProd = bm.get(it.prodId);
        const lastBatch = batchesForProd?.[batchesForProd.length - 1];
        await this.base.rawRun(
          `INSERT INTO purchase_items (purchase_id, product_id, batch_id, quantity_received,
           cost_per_parent, selling_price_parent, line_total, expiry_date, batch_number)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [purId, it.prodId, lastBatch?.id ?? null, it.qty,
           it.cost, it.sell, it.cost * it.qty,
           lastBatch?.expiry_date ?? todayStr, lastBatch ? `PUR-${purSeq}-B` : null]
        );
      }

      // Payment handling
      if (isPaidFull) {
        // Create expense for full payment
        const expId = await this.base.rawRunReturningId(
          `INSERT INTO expenses (category_id, amount, description, expense_date, payment_method, user_id, shift_id)
           VALUES (?,?,?,?,?,?,NULL)`,
          [supplierPayCatId, totalAmount, `Supplier payment for ${purNum}`, purDs, 'cash', adminUser.id]
        );
        await this.base.rawRun(
          `INSERT INTO purchase_payments (purchase_id, due_date, amount, is_paid, paid_date,
           payment_method, expense_id, paid_by_user_id) VALUES (?,?,?,1,?,'cash',?,?)`,
          [purId, purDs, totalAmount, purDs, expId, adminUser.id]
        );
      } else {
        // Installment payments
        const instCount = spec.installmentCount ?? 3;
        const instAmount = Math.floor(totalAmount / instCount);
        const remainder = totalAmount - instAmount * instCount;
        let totalPaid = 0;

        for (let inst = 0; inst < instCount; inst++) {
          const dueDate = new Date(purDate);
          dueDate.setMonth(dueDate.getMonth() + inst + 1);
          const dueDateStr = dueDate.toISOString().slice(0, 10);
          const amount = inst === instCount - 1 ? instAmount + remainder : instAmount;
          const isOverdue = dueDate < today;
          // Pay older installments: pay if due date was > 2 weeks ago, ~60% chance for recently due
          const paymentAge = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
          const shouldPay = paymentAge > 14 || (isOverdue && pseudo(purSeq, inst * 7 + 800) % 5 < 3);

          if (shouldPay) {
            const paidDate = new Date(dueDate);
            paidDate.setDate(paidDate.getDate() + (pseudo(purSeq, inst + 810) % 5)); // Pay 0-4 days after due
            const paidDateStr = paidDate.toISOString().slice(0, 10);
            const pm = pseudo(purSeq, inst + 820) % 3 === 0 ? 'bank_transfer' : 'cash';

            const expId = await this.base.rawRunReturningId(
              `INSERT INTO expenses (category_id, amount, description, expense_date, payment_method, user_id, shift_id)
               VALUES (?,?,?,?,?,?,NULL)`,
              [supplierPayCatId, amount, `Supplier payment for ${purNum} (installment ${inst + 1})`, paidDateStr, pm, adminUser.id]
            );
            await this.base.rawRun(
              `INSERT INTO purchase_payments (purchase_id, due_date, amount, is_paid, paid_date,
               payment_method, expense_id, paid_by_user_id) VALUES (?,?,?,1,?,?,?,?)`,
              [purId, dueDateStr, amount, paidDateStr, pm, expId, adminUser.id]
            );
            totalPaid += amount;
          } else {
            // Unpaid installment
            await this.base.rawRun(
              `INSERT INTO purchase_payments (purchase_id, due_date, amount, is_paid) VALUES (?,?,?,0)`,
              [purId, dueDateStr, amount]
            );
          }
        }

        // Update purchase totals
        const newStatus = totalPaid >= totalAmount ? 'paid' : totalPaid > 0 ? 'partial' : 'unpaid';
        await this.base.rawRun(
          'UPDATE purchases SET total_paid=?, payment_status=? WHERE id=?',
          [totalPaid, newStatus, purId]
        );
      }
    }

    console.log(`[Demo] Seeded ${supplierData.length} suppliers, ${purSeq} purchase orders`);

    // ══════════════════════════════════════════════════════════════════════════
    // ── INVENTORY SIMULATION (expiry, low stock, dead capital, quarantine) ──
    // ══════════════════════════════════════════════════════════════════════════

    // The demo products already include:
    //   - Expired batches (PCM-2023-001, MET-2023-001, CTZ-2023-001 with negative expiryMonths)
    //   - Near-expiry batches (LOS-2024-001 expires in 3 months, MET-2024-001 in 2 months)
    //   - Varied expiry windows (6-26 months out)
    //
    // Now we adjust batch quantities to create specific inventory scenarios.
    // Use product names (not indices) to avoid ordering issues.

    const findProd = (name: string) => prods.find(p => p.name === name);

    // 1. LOW STOCK products (below min_stock_level) — drain batches
    const lowStockTargets: Array<{ name: string; targetBase: number }> = [
      { name: 'Azithromycin 250mg',   targetBase: 12 }, // min_stock=10, CF=6 → 2 parent barely above
      { name: 'Salbutamol Inhaler',    targetBase: 3 },  // min_stock=8, CF=1 → way below
      { name: 'Ciprofloxacin 500mg',   targetBase: 8 },  // min_stock=10, CF=10 → <1 parent
      { name: 'Cetirizine 10mg',       targetBase: 10 }, // min_stock=15, CF=10 → 1 parent
      { name: 'Losartan 50mg',         targetBase: 5 },  // min_stock=15, CF=10 → <1 parent
    ];

    for (const ls of lowStockTargets) {
      const prod = findProd(ls.name);
      if (!prod) continue;
      const batches = bm.get(prod.id);
      if (!batches) continue;
      for (let bi = 0; bi < batches.length; bi++) {
        if (bi === batches.length - 1) {
          batches[bi].quantity_base = Math.min(batches[bi].quantity_base, ls.targetBase);
        } else {
          batches[bi].quantity_base = 0;
        }
      }
    }

    // 2. DEAD CAPITAL — products with high stock but low recent sales
    const deadCapitalTargets: Array<{ name: string; boostBase: number }> = [
      { name: 'Betadine Solution 120ml', boostBase: 90 },
      { name: 'Diclofenac Gel 50g',      boostBase: 70 },
      { name: 'Multivitamin Complex',     boostBase: 150 },
    ];

    for (const dc of deadCapitalTargets) {
      const prod = findProd(dc.name);
      if (!prod) continue;
      const batches = bm.get(prod.id);
      if (!batches) continue;
      const lastBatch = batches[batches.length - 1];
      if (lastBatch && lastBatch.quantity_base < dc.boostBase) {
        lastBatch.quantity_base = dc.boostBase;
      }
    }

    // 3. QUARANTINED batches — expired stock awaiting disposal
    // Target batch[0] for products that have expired batches (PCM-2023-001, MET-2023-001, CTZ-2023-001)
    const quarantineNames = ['Paracetamol 500mg', 'Metformin 500mg', 'Cetirizine 10mg'];
    const quarantinedBatchIds = new Set<number>();
    for (const name of quarantineNames) {
      const prod = findProd(name);
      if (!prod) continue;
      const batches = bm.get(prod.id);
      if (!batches || batches.length === 0) continue;
      // Find the expired batch (first one, which has earliest expiry)
      const expiredBatch = batches.find(b => b.expiry_date < todayStr);
      const targetBatch = expiredBatch ?? batches[0];
      quarantinedBatchIds.add(targetBatch.id);
      // Ensure it has some stock (expired awaiting disposal)
      if (targetBatch.quantity_base <= 0) {
        targetBatch.quantity_base = prod.conversion_factor * 2;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── UPDATE BATCH QUANTITIES to reflect consumed stock + inventory sim ──
    // ══════════════════════════════════════════════════════════════════════════
    for (const [, bs] of bm) {
      for (const b of bs) {
        let st: string;
        if (quarantinedBatchIds.has(b.id)) {
          st = 'quarantine';
        } else if (b.quantity_base <= 0) {
          st = 'sold_out';
        } else {
          st = 'active';
        }
        await this.base.rawRun(
          'UPDATE batches SET quantity_base=?, status=? WHERE id=?',
          [Math.max(0, b.quantity_base), st, b.id]
        );
      }
    }

    this.base.save();
    console.log(`[Demo] Seeded ${saleSeq} sales, ${rtnSeq} returns across ${day} working days`);
    console.log(`[Demo] Includes: voids, damage reports, held sales, varied expenses, cash drops`);
    console.log(`[Demo] Includes: ${supplierData.length} suppliers, ${purSeq} purchases (full + installments)`);
    console.log(`[Demo] Inventory: low stock items, dead capital, quarantined expired batches`);
  }

  // ─── Fresh Install Detection ─────────────────────────────────────────────────

  private async _checkFreshInstall(): Promise<void> {
    const donePath = path.join(this.dataPath, 'fresh_install_done');
    if (fs.existsSync(donePath)) return;

    const execDir = process.execPath ? path.dirname(process.execPath) : null;
    const candidates = [
      execDir ? path.join(execDir, 'fresh_install') : null,
      path.join(this.dataPath, 'fresh_install'),
    ].filter(Boolean) as string[];

    const markerPath = candidates.find(p => fs.existsSync(p));
    if (!markerPath) return;

    try {
      const admin = await this.base.getOne<{ id: number }>(
        "SELECT id FROM users WHERE username = 'admin' AND role = 'admin'"
      );
      if (admin) {
        const hash = hashPassword('admin123');
        await this.base.rawRun(
          `UPDATE users
           SET password_hash = ?,
               must_change_password = 1,
               failed_login_attempts = 0,
               locked_until = NULL,
               updated_at = datetime('now')
           WHERE id = ?`,
          [hash, admin.id]
        );
        console.log('[PharmaSys] Fresh install detected — admin password reset to default.');
      }
      fs.writeFileSync(donePath, '');
      try { fs.unlinkSync(markerPath); } catch {}
    } catch (e: any) {
      console.error('[PharmaSys] Failed to process fresh_install marker:', e.message);
    }
  }

  // ─── Housekeeping ────────────────────────────────────────────────────────────

  private async _unlockAdminAccounts(): Promise<void> {
    await this.base.rawRun(
      "UPDATE users SET locked_until = NULL, failed_login_attempts = 0 WHERE role = 'admin'"
    );
  }

  private async _purgeOldAuditLogs(days: number): Promise<void> {
    try {
      await this.base.rawRun(
        'DELETE FROM audit_logs WHERE created_at < datetime(\'now\', ?)',
        [`-${days} days`]
      );
      this.base.save();
    } catch (e: any) {
      console.error('[Housekeeping] Audit purge failed:', e.message);
    }
  }
}
