/**
 * PgMigrationRepository -- creates and seeds the PostgreSQL schema.
 *
 * Called once at startup from the platform entry point after the PG connection
 * is established but BEFORE any service or repository is used.
 *
 * Design decisions:
 *   - Date/time columns are TEXT (not TIMESTAMP) to keep domain repos unchanged.
 *     Defaults use NOW()::text which produces ISO-8601-style strings.
 *   - SERIAL PRIMARY KEY instead of AUTOINCREMENT.
 *   - INSERT ... ON CONFLICT DO NOTHING for idempotent seeding.
 *   - Historical data seeding is skipped (too complex for initial PG version).
 */

import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as path   from 'path';
import type { PgBaseRepository } from './base.repository';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export class PgMigrationRepository {
  constructor(
    private readonly base: PgBaseRepository,
    private readonly dataPath: string
  ) {}

  /**
   * Run the full initialisation sequence.
   * Safe to call on every startup -- uses IF NOT EXISTS / ON CONFLICT throughout.
   */
  async initialise(seedDemo = false): Promise<void> {
    await this._createSchema();
    await this._createIndexes();
    await this._seedDefaultData();
    if (seedDemo) {
      await this._seedDemoData();
    }
    await this._checkFreshInstall();
    await this._unlockAdminAccounts();

    // Deferred housekeeping -- purge audit logs older than 1 year
    setTimeout(() => this._purgeOldAuditLogs(365), 5000);
  }

  // --- Schema ----------------------------------------------------------------

  private async _createSchema(): Promise<void> {
    const schemas = [
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
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
        created_at TEXT DEFAULT (NOW()::text),
        updated_at TEXT DEFAULT (NOW()::text)
      )`,

      `CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT DEFAULT (NOW()::text)
      )`,

      `CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
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
        created_at TEXT DEFAULT (NOW()::text),
        updated_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
      )`,

      // shifts must be created before transactions (FK dependency)
      `CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY,
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

      `CREATE TABLE IF NOT EXISTS batches (
        id SERIAL PRIMARY KEY,
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
        created_at TEXT DEFAULT (NOW()::text),
        updated_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      )`,

      `CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
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
        created_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (shift_id) REFERENCES shifts(id),
        FOREIGN KEY (voided_by) REFERENCES users(id)
      )`,

      `CREATE TABLE IF NOT EXISTS transaction_items (
        id SERIAL PRIMARY KEY,
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
        created_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (batch_id) REFERENCES batches(id)
      )`,

      `CREATE TABLE IF NOT EXISTS expense_categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0 CHECK(amount > 0),
        description TEXT,
        expense_date TEXT NOT NULL,
        payment_method TEXT DEFAULT 'cash' CHECK(payment_method IN ('cash', 'bank_transfer')),
        user_id INTEGER NOT NULL,
        shift_id INTEGER,
        created_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (category_id) REFERENCES expense_categories(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      )`,

      `CREATE TABLE IF NOT EXISTS cash_drops (
        id SERIAL PRIMARY KEY,
        shift_id INTEGER NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        reason TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (shift_id) REFERENCES shifts(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,

      `CREATE TABLE IF NOT EXISTS held_sales (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        customer_note TEXT,
        items_json TEXT NOT NULL,
        total_amount INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,

      `CREATE TABLE IF NOT EXISTS inventory_adjustments (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        quantity_base INTEGER NOT NULL CHECK(quantity_base > 0),
        reason TEXT,
        type TEXT NOT NULL CHECK(type IN ('damage', 'expiry', 'correction')),
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (NOW()::text),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (batch_id) REFERENCES batches(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,

      `CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        action TEXT NOT NULL,
        table_name TEXT,
        record_id INTEGER,
        old_values TEXT,
        new_values TEXT,
        ip_address TEXT,
        created_at TEXT DEFAULT (NOW()::text)
      )`,

      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (NOW()::text)
      )`,
    ];

    for (const sql of schemas) {
      await this.base.exec(sql);
    }
  }

  // --- Indexes ---------------------------------------------------------------

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
        await this.base.exec(sql);
      } catch (err: any) {
        if (!err.message?.includes('already exists')) {
          console.error(`[PgMigration][Index] Failed to create index: ${sql}`, err.message);
        }
      }
    }

    // PG-specific partial indexes for hot queries
    const partialIndexes = [
      `CREATE INDEX IF NOT EXISTS idx_batches_fifo ON batches(product_id, expiry_date) WHERE status = 'active' AND quantity_base > 0`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_active_sales ON transactions(created_at) WHERE is_voided = 0 AND transaction_type = 'sale'`,
    ];

    for (const sql of partialIndexes) {
      try {
        await this.base.exec(sql);
      } catch (err: any) {
        if (!err.message?.includes('already exists')) {
          console.error(`[PgMigration][Index] Failed to create partial index: ${sql}`, err.message);
        }
      }
    }
  }

  // --- Seed Default Data -----------------------------------------------------

  private async _seedDefaultData(): Promise<void> {
    // Create admin user if missing
    const admin = await this.base.getOne<{ id: number }>(
      'SELECT id FROM users WHERE username = $1', ['admin']
    );
    if (!admin) {
      const hash = hashPassword('admin123');
      await this.base.rawRun(
        `INSERT INTO users (username, password_hash, full_name, role,
         perm_finance, perm_inventory, perm_reports, must_change_password)
         VALUES ($1, $2, $3, $4, 1, 1, 1, 0)`,
        ['admin', hash, 'System Administrator', 'admin']
      );
      console.log('='.repeat(60));
      console.log('Default admin password: admin123');
      console.log('='.repeat(60));
    }

    // Seed expense categories (ON CONFLICT for idempotency)
    const categories = ['Salaries', 'Utilities', 'Rent', 'Maintenance', 'Supplies', 'Transport', 'Other'];
    for (const name of categories) {
      await this.base.rawRun(
        'INSERT INTO expense_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name]
      );
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
      await this.base.rawRun(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, value]
      );
    }
  }

  // --- Demo / Sample Data ----------------------------------------------------

  private async _seedDemoData(): Promise<void> {
    // Only seed if no products exist yet (fresh install)
    const existing = await this.base.getOne<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM products'
    );
    if (existing && existing.cnt > 0) return;

    console.log('[PgMigration][Demo] Seeding demo data ...');

    // -- Additional users --
    const pharmaHash = hashPassword('pharma123');
    await this.base.rawRun(
      `INSERT INTO users (username, password_hash, full_name, role,
       perm_finance, perm_inventory, perm_reports, must_change_password)
       VALUES ($1, $2, $3, $4, 0, 1, 1, 0)
       ON CONFLICT (username) DO NOTHING`,
      ['pharmacist', pharmaHash, 'Ahmed Mohamed', 'pharmacist']
    );
    const cashierHash = hashPassword('cashier123');
    await this.base.rawRun(
      `INSERT INTO users (username, password_hash, full_name, role,
       perm_finance, perm_inventory, perm_reports, must_change_password)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0)
       ON CONFLICT (username) DO NOTHING`,
      ['cashier', cashierHash, 'Sara Ibrahim', 'cashier']
    );

    // -- Product categories --
    const cats = [
      'Antibiotics', 'Pain Relief', 'Vitamins & Supplements', 'Skin Care',
      'Respiratory', 'Gastrointestinal', 'Cardiovascular', 'Diabetes',
    ];
    for (const name of cats) {
      await this.base.rawRun(
        'INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name]
      );
    }

    // Helper: look up category id by name
    const catId = async (name: string): Promise<number> => {
      const row = await this.base.getOne<{ id: number }>(
        'SELECT id FROM categories WHERE name = $1', [name]
      );
      return row!.id;
    };

    // Dates for batches
    const today = new Date();
    const dateStr = (monthsFromNow: number): string => {
      const d = new Date(today);
      d.setMonth(d.getMonth() + monthsFromNow);
      return d.toISOString().slice(0, 10);
    };

    // -- Products + Batches --
    // All prices in whole SDG (no piastres -- SDG has no minor currency units).
    // cost_per_child  = floor(cost_per_parent / conversion_factor)
    // selling_price_child = floor(selling_price_parent / conversion_factor)
    interface DemoProduct {
      name: string; generic: string; catName: string; barcode: string;
      parentUnit: string; childUnit: string; convFactor: number; minStock: number;
      batches: Array<{
        batchNo: string; expiryMonths: number; qtyParent: number;
        costParent: number; sellParent: number;
      }>;
    }

    const products: DemoProduct[] = [
      {
        name: 'Amoxicillin 500mg', generic: 'Amoxicillin', catName: 'Antibiotics',
        barcode: '6001234000011', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 20,
        batches: [
          { batchNo: 'AMX-2024-001', expiryMonths: 8,  qtyParent: 100, costParent: 750, sellParent: 1000 },
          { batchNo: 'AMX-2025-001', expiryMonths: 16, qtyParent: 120, costParent: 780, sellParent: 1000 },
          { batchNo: 'AMX-2025-002', expiryMonths: 22, qtyParent: 60,  costParent: 780, sellParent: 1000 },
        ],
      },
      {
        name: 'Paracetamol 500mg', generic: 'Paracetamol', catName: 'Pain Relief',
        barcode: '6001234000028', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 30,
        batches: [
          { batchNo: 'PCM-2023-001', expiryMonths: -1, qtyParent: 15,  costParent: 380, sellParent: 550 },
          { batchNo: 'PCM-2024-001', expiryMonths: 10, qtyParent: 120, costParent: 400, sellParent: 550 },
          { batchNo: 'PCM-2025-001', expiryMonths: 18, qtyParent: 150, costParent: 420, sellParent: 550 },
          { batchNo: 'PCM-2025-002', expiryMonths: 24, qtyParent: 80,  costParent: 420, sellParent: 550 },
        ],
      },
      {
        name: 'Ibuprofen 400mg', generic: 'Ibuprofen', catName: 'Pain Relief',
        barcode: '6001234000035', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 20,
        batches: [
          { batchNo: 'IBU-2024-001', expiryMonths: 9,  qtyParent: 80,  costParent: 420, sellParent: 580 },
          { batchNo: 'IBU-2025-001', expiryMonths: 16, qtyParent: 100, costParent: 440, sellParent: 580 },
        ],
      },
      {
        name: 'Azithromycin 250mg', generic: 'Azithromycin', catName: 'Antibiotics',
        barcode: '6001234000042', parentUnit: 'Box', childUnit: 'Strip', convFactor: 6, minStock: 10,
        batches: [
          { batchNo: 'AZI-2024-001', expiryMonths: 7,  qtyParent: 40, costParent: 900,  sellParent: 1200 },
          { batchNo: 'AZI-2025-001', expiryMonths: 18, qtyParent: 50, costParent: 920,  sellParent: 1200 },
        ],
      },
      {
        name: 'Omeprazole 20mg', generic: 'Omeprazole', catName: 'Gastrointestinal',
        barcode: '6001234000059', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        batches: [
          { batchNo: 'OMP-2024-001', expiryMonths: 12, qtyParent: 100, costParent: 520, sellParent: 720 },
          { batchNo: 'OMP-2025-001', expiryMonths: 20, qtyParent: 80,  costParent: 540, sellParent: 720 },
        ],
      },
      {
        name: 'Metformin 500mg', generic: 'Metformin', catName: 'Diabetes',
        barcode: '6001234000066', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 25,
        batches: [
          { batchNo: 'MET-2023-001', expiryMonths: -3, qtyParent: 8,   costParent: 360, sellParent: 520 },
          { batchNo: 'MET-2024-001', expiryMonths: 2,  qtyParent: 40,  costParent: 380, sellParent: 520 },
          { batchNo: 'MET-2025-001', expiryMonths: 14, qtyParent: 120, costParent: 400, sellParent: 520 },
          { batchNo: 'MET-2025-002', expiryMonths: 22, qtyParent: 100, costParent: 400, sellParent: 520 },
        ],
      },
      {
        name: 'Amlodipine 5mg', generic: 'Amlodipine', catName: 'Cardiovascular',
        barcode: '6001234000073', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        batches: [
          { batchNo: 'AML-2024-001', expiryMonths: 10, qtyParent: 70,  costParent: 450, sellParent: 620 },
          { batchNo: 'AML-2025-001', expiryMonths: 18, qtyParent: 80,  costParent: 470, sellParent: 620 },
        ],
      },
      {
        name: 'Vitamin C 1000mg', generic: 'Ascorbic Acid', catName: 'Vitamins & Supplements',
        barcode: '6001234000080', parentUnit: 'Bottle', childUnit: 'Tablet', convFactor: 30, minStock: 10,
        batches: [
          { batchNo: 'VTC-2024-001', expiryMonths: 14, qtyParent: 60, costParent: 400, sellParent: 560 },
          { batchNo: 'VTC-2025-001', expiryMonths: 26, qtyParent: 50, costParent: 420, sellParent: 560 },
        ],
      },
      {
        name: 'Cetirizine 10mg', generic: 'Cetirizine', catName: 'Respiratory',
        barcode: '6001234000097', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
        batches: [
          { batchNo: 'CTZ-2023-001', expiryMonths: -2, qtyParent: 12, costParent: 340, sellParent: 500 },
          { batchNo: 'CTZ-2024-001', expiryMonths: 8,  qtyParent: 80, costParent: 360, sellParent: 500 },
          { batchNo: 'CTZ-2025-001', expiryMonths: 20, qtyParent: 70, costParent: 380, sellParent: 500 },
        ],
      },
      {
        name: 'Betadine Solution 120ml', generic: 'Povidone-Iodine', catName: 'Skin Care',
        barcode: '6001234000103', parentUnit: 'Bottle', childUnit: 'Bottle', convFactor: 1, minStock: 10,
        batches: [
          { batchNo: 'BTD-2024-001', expiryMonths: 12, qtyParent: 60, costParent: 500, sellParent: 680 },
          { batchNo: 'BTD-2025-001', expiryMonths: 24, qtyParent: 50, costParent: 520, sellParent: 680 },
        ],
      },
      {
        name: 'Salbutamol Inhaler', generic: 'Salbutamol', catName: 'Respiratory',
        barcode: '6001234000110', parentUnit: 'Piece', childUnit: 'Piece', convFactor: 1, minStock: 8,
        batches: [
          { batchNo: 'SAL-2024-001', expiryMonths: 6,  qtyParent: 30, costParent: 620, sellParent: 820 },
          { batchNo: 'SAL-2025-001', expiryMonths: 14, qtyParent: 40, costParent: 640, sellParent: 820 },
        ],
      },
      {
        name: 'Ciprofloxacin 500mg', generic: 'Ciprofloxacin', catName: 'Antibiotics',
        barcode: '6001234000127', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 10,
        batches: [
          { batchNo: 'CIP-2024-001', expiryMonths: 8,  qtyParent: 50, costParent: 720, sellParent: 950 },
          { batchNo: 'CIP-2025-001', expiryMonths: 18, qtyParent: 60, costParent: 740, sellParent: 950 },
        ],
      },
      {
        name: 'Diclofenac Gel 50g', generic: 'Diclofenac', catName: 'Skin Care',
        barcode: '6001234000134', parentUnit: 'Tube', childUnit: 'Tube', convFactor: 1, minStock: 10,
        batches: [
          { batchNo: 'DCL-2024-001', expiryMonths: 10, qtyParent: 40, costParent: 420, sellParent: 580 },
          { batchNo: 'DCL-2025-001', expiryMonths: 22, qtyParent: 40, costParent: 440, sellParent: 580 },
        ],
      },
      {
        name: 'Multivitamin Complex', generic: 'Multivitamin', catName: 'Vitamins & Supplements',
        barcode: '6001234000141', parentUnit: 'Bottle', childUnit: 'Tablet', convFactor: 60, minStock: 8,
        batches: [
          { batchNo: 'MVT-2024-001', expiryMonths: 14, qtyParent: 35, costParent: 650, sellParent: 880 },
          { batchNo: 'MVT-2025-001', expiryMonths: 26, qtyParent: 30, costParent: 680, sellParent: 880 },
        ],
      },
      {
        name: 'Losartan 50mg', generic: 'Losartan', catName: 'Cardiovascular',
        barcode: '6001234000158', parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, minStock: 15,
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
         parent_unit, child_unit, conversion_factor, min_stock_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.name, p.generic, await catId(p.catName), p.barcode,
         p.parentUnit, p.childUnit, p.convFactor, p.minStock]
      );
      const prod = await this.base.getOne<{ id: number }>(
        'SELECT id FROM products WHERE barcode = $1', [p.barcode]
      );
      if (!prod) continue;

      for (const b of p.batches) {
        const qtyBase   = b.qtyParent * p.convFactor;
        const costChild = Math.floor(b.costParent / p.convFactor);
        const sellChild = Math.floor(b.sellParent / p.convFactor);
        await this.base.rawRun(
          `INSERT INTO batches (product_id, batch_number, expiry_date,
           quantity_base, cost_per_parent, cost_per_child, cost_per_child_override,
           selling_price_parent, selling_price_child,
           selling_price_parent_override, selling_price_child_override, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')`,
          [prod.id, b.batchNo, dateStr(b.expiryMonths),
           qtyBase, b.costParent, costChild, costChild,
           b.sellParent, sellChild,
           b.sellParent, sellChild]
        );
      }
    }

    console.log(`[PgMigration][Demo] Seeded ${products.length} products, ${cats.length} categories, 2 staff users`);
    console.log('[PgMigration][Demo] Demo users: pharmacist / pharma123, cashier / cashier123');
  }

  // --- Fresh Install Detection -----------------------------------------------

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
           SET password_hash = $1,
               must_change_password = 1,
               failed_login_attempts = 0,
               locked_until = NULL,
               updated_at = NOW()::text
           WHERE id = $2`,
          [hash, admin.id]
        );
        console.log('[PgMigration] Fresh install detected -- admin password reset to default.');
      }
      fs.writeFileSync(donePath, '');
      try { fs.unlinkSync(markerPath); } catch { /* best effort */ }
    } catch (e: any) {
      console.error('[PgMigration] Failed to process fresh_install marker:', e.message);
    }
  }

  // --- Housekeeping ----------------------------------------------------------

  private async _unlockAdminAccounts(): Promise<void> {
    await this.base.rawRun(
      "UPDATE users SET locked_until = NULL, failed_login_attempts = 0 WHERE role = 'admin'"
    );
  }

  private async _purgeOldAuditLogs(days: number): Promise<void> {
    try {
      await this.base.rawRun(
        `DELETE FROM audit_logs WHERE created_at < (NOW() - INTERVAL '${days} days')::text`
      );
    } catch (e: any) {
      console.error('[PgMigration][Housekeeping] Audit purge failed:', e.message);
    }
  }
}
