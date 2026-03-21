/**
 * Integration tests — full business flow with real sql.js database.
 *
 * Tests exercise the complete stack: repositories → services → events,
 * with a real in-memory SQLite database (no mocks).
 */

import { createTestContext, type TestContext } from '../helpers/test-db';
import { Money } from '@core/common/money';
import type { UserPublic, TransactionType } from '@core/types/models';

let ctx: TestContext;
let adminUser: UserPublic;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.destroy();
});

// ─── Auth ────────────────────────────────────────────────────────────────────

describe('Auth flow', () => {
  it('admin can login with default credentials', async () => {
    const result = await ctx.services.auth.login('admin', 'admin123');
    expect(result.user.username).toBe('admin');
    expect(result.user.role).toBe('admin');
    adminUser = result.user;
  });

  it('login fails with wrong password', async () => {
    await expect(ctx.services.auth.login('admin', 'wrong')).rejects.toThrow();
  });

  it('demo pharmacist can login', async () => {
    const result = await ctx.services.auth.login('pharmacist', 'pharma123');
    expect(result.user.role).toBe('pharmacist');
  });

  it('demo cashier can login', async () => {
    const result = await ctx.services.auth.login('cashier', 'cashier123');
    expect(result.user.role).toBe('cashier');
  });

  it('isFirstLaunch returns true when admin has default password', async () => {
    expect(await ctx.services.auth.isFirstLaunch()).toBe(true);
  });

  it('password change works', async () => {
    await ctx.services.auth.changePassword(adminUser.id, 'admin123', 'newpass123');
    const result = await ctx.services.auth.login('admin', 'newpass123');
    expect(result.user.id).toBe(adminUser.id);
  });

  it('isFirstLaunch returns false after password change', async () => {
    expect(await ctx.services.auth.isFirstLaunch()).toBe(false);
  });

  it('restore admin password for remaining tests', async () => {
    await ctx.services.auth.adminResetPassword(adminUser.id, 'admin123', adminUser.id, false);
    const result = await ctx.services.auth.login('admin', 'admin123');
    expect(result.user.id).toBe(adminUser.id);
  });
});

// ─── Products & Categories ───────────────────────────────────────────────────

describe('Product and category queries', () => {
  it('categories exist from demo seed', async () => {
    const cats = await ctx.services.category.getAll();
    expect(cats.length).toBeGreaterThanOrEqual(8);
  });

  it('products exist from demo seed', async () => {
    const products = await ctx.services.product.getAll();
    expect(products.length).toBeGreaterThanOrEqual(15);
  });

  it('product search works', async () => {
    const results = await ctx.services.product.search('Amoxicillin');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toContain('Amoxicillin');
  });

  it('can get product by id', async () => {
    const products = await ctx.services.product.getAll();
    const product = await ctx.services.product.getById(products[0].id);
    expect(product.id).toBe(products[0].id);
  });
});

// ─── Batches ─────────────────────────────────────────────────────────────────

describe('Batch queries', () => {
  it('batches exist from demo seed', async () => {
    const products = await ctx.services.product.getAll();
    const batches = await ctx.services.batch.getByProduct(products[0].id);
    expect(batches.length).toBeGreaterThanOrEqual(1);
  });

  it('available batches sorted by expiry (FIFO)', async () => {
    const products = await ctx.services.product.getAll();
    for (const p of products) {
      const available = await ctx.services.batch.getAvailable(p.id);
      if (available.length >= 2) {
        for (let i = 1; i < available.length; i++) {
          expect(available[i].expiry_date >= available[i - 1].expiry_date).toBe(true);
        }
        break;
      }
    }
  });

  it('expiring batches returns results', async () => {
    const expiring = await ctx.services.batch.getExpiring(90);
    expect(Array.isArray(expiring)).toBe(true);
  });
});

// ─── Full Sale → Return → Void Flow ─────────────────────────────────────────

describe('Transaction flow (sale → return → void)', () => {
  let shiftId: number;
  let saleTransactionId: number;
  let returnTransactionId: number;
  let productForSale: any;
  let batchBeforeSale: any;

  it('opens a shift', async () => {
    const openingAmount = Money.toMinor(500);
    const shift = await ctx.services.shift.open(adminUser.id, openingAmount);
    expect(shift.status).toBe('open');
    expect(shift.opening_amount).toBe(openingAmount);
    shiftId = shift.id;
  });

  it('creates a sale', async () => {
    const products = await ctx.services.product.getAll();
    for (const p of products) {
      const available = await ctx.services.batch.getAvailable(p.id);
      if (available.length > 0 && available[0].quantity_base >= 2) {
        productForSale = p;
        batchBeforeSale = { ...available[0] };
        break;
      }
    }
    expect(productForSale).toBeDefined();

    const sellingPrice = batchBeforeSale.selling_price_parent || Money.toMinor(100);
    const totalAmount = Money.multiply(sellingPrice, 1);

    const sale = await ctx.services.transaction.createSale({
      transaction_type: 'sale' as TransactionType,
      subtotal: totalAmount,
      total_amount: totalAmount,
      items: [{
        product_id: productForSale.id,
        batch_id: batchBeforeSale.id,
        quantity: 1,
        unit_type: 'parent' as const,
        unit_price: sellingPrice,
        discount_percent: 0,
      }],
      payment_method: 'cash' as const,
      cash_tendered: totalAmount,
    }, adminUser.id);

    expect(sale.transaction_type).toBe('sale');
    expect(sale.total_amount).toBeGreaterThan(0);
    saleTransactionId = sale.id;

    // Verify stock was deducted
    const batchAfter = await ctx.services.batch.getById(batchBeforeSale.id);
    const expectedQty = batchBeforeSale.quantity_base - productForSale.conversion_factor;
    expect(batchAfter.quantity_base).toBe(expectedQty);
  });

  it('creates a return from the sale', async () => {
    const returnTxn = await ctx.services.transaction.createReturn({
      original_transaction_id: saleTransactionId,
      items: [{
        batch_id: batchBeforeSale.id,
        quantity: 1,
        unit_type: 'parent' as const,
      }],
      notes: 'Customer changed mind',
    }, adminUser.id);

    expect(returnTxn.transaction_type).toBe('return');
    returnTransactionId = returnTxn.id;

    // Verify stock was restored
    const batchAfterReturn = await ctx.services.batch.getById(batchBeforeSale.id);
    expect(batchAfterReturn.quantity_base).toBe(batchBeforeSale.quantity_base);
  });

  it('cannot return more than original quantity', async () => {
    await expect(ctx.services.transaction.createReturn({
      original_transaction_id: saleTransactionId,
      items: [{
        batch_id: batchBeforeSale.id,
        quantity: 1,
        unit_type: 'parent' as const,
      }],
    }, adminUser.id)).rejects.toThrow();
  });

  it('can void the return (re-deducts stock)', async () => {
    await ctx.services.transaction.voidTransaction(returnTransactionId, 'Test void', adminUser.id);

    const batchAfterVoid = await ctx.services.batch.getById(batchBeforeSale.id);
    const expectedQty = batchBeforeSale.quantity_base - productForSale.conversion_factor;
    expect(batchAfterVoid.quantity_base).toBe(expectedQty);
  });

  it('can void the original sale (restores stock)', async () => {
    await ctx.services.transaction.voidTransaction(saleTransactionId, 'Test void sale', adminUser.id);

    const batchAfterVoid = await ctx.services.batch.getById(batchBeforeSale.id);
    expect(batchAfterVoid.quantity_base).toBe(batchBeforeSale.quantity_base);
  });

  it('closes the shift with variance calculation', async () => {
    const info = await ctx.services.shift.getExpectedCash(shiftId);
    expect(info).toBeDefined();
    expect(info.opening_amount).toBe(Money.toMinor(500));

    const closedShift = await ctx.services.shift.close(
      shiftId,
      info.expected_cash,
      'Integration test',
      adminUser.id
    );
    expect(closedShift.status).toBe('closed');
    expect(closedShift.variance_type).toBe('balanced');
    expect(closedShift.variance).toBe(0);
  });
});

// ─── Expenses ────────────────────────────────────────────────────────────────

describe('Expense flow', () => {
  let shiftId: number;

  it('opens a shift for expense testing', async () => {
    const shift = await ctx.services.shift.open(adminUser.id, Money.toMinor(1000));
    shiftId = shift.id;
  });

  it('creates an expense category', async () => {
    const cat = await ctx.services.expense.createCategory('Test Supplies', adminUser.id);
    expect(cat.name).toBe('Test Supplies');
  });

  it('creates an expense', async () => {
    const cats = await ctx.services.expense.getCategories();
    const expense = await ctx.services.expense.create({
      category_id: cats[0].id,
      amount: Money.toMinor(50),
      expense_date: new Date().toISOString().split('T')[0],
      description: 'Integration test expense',
    }, adminUser.id);
    expect(expense.amount).toBe(Money.toMinor(50));
  });

  it('creates a cash drop', async () => {
    const drop = await ctx.services.expense.createCashDrop({
      amount: Money.toMinor(200),
      reason: 'Test cash drop',
    }, adminUser.id);
    expect(drop.amount).toBe(Money.toMinor(200));
  });

  it('expected cash reflects expenses and drops', async () => {
    const info = await ctx.services.shift.getExpectedCash(shiftId);
    expect(info.total_cash_expenses).toBe(Money.toMinor(50));
    expect(info.total_cash_drops).toBe(Money.toMinor(200));
  });

  it('closes shift', async () => {
    const info = await ctx.services.shift.getExpectedCash(shiftId);
    const closed = await ctx.services.shift.close(shiftId, info.expected_cash, null, adminUser.id);
    expect(closed.status).toBe('closed');
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe('Settings', () => {
  it('can set and get a setting', async () => {
    await ctx.services.settings.set('business_name', 'Test Pharmacy', adminUser.id);
    expect(await ctx.services.settings.get('business_name')).toBe('Test Pharmacy');
  });

  it('rejects unknown keys', async () => {
    await expect(ctx.services.settings.set('invalid_key', 'val', adminUser.id)).rejects.toThrow();
  });

  it('getAll returns settings array', async () => {
    const all = await ctx.services.settings.getAll();
    expect(Array.isArray(all)).toBe(true);
    const bn = all.find((s: any) => s.key === 'business_name');
    expect(bn).toBeDefined();
  });
});

// ─── Reports ─────────────────────────────────────────────────────────────────

describe('Reports', () => {
  it('dashboard stats return without error', async () => {
    const stats = await ctx.services.dashboard.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats.today_net_sales).toBe('number');
    expect(typeof stats.today_transactions).toBe('number');
    expect(typeof stats.month_net_sales).toBe('number');
    expect(typeof stats.inventory_cost_value).toBe('number');
    expect(typeof stats.expired_count).toBe('number');
  });

  it('cash flow report works', async () => {
    const today = new Date().toISOString().split('T')[0];
    const report = await ctx.services.report.getCashFlow(today, today);
    expect(report).toBeDefined();
  });

  it('reorder recommendations return array', async () => {
    const recs = await ctx.services.report.getReorderRecommendations();
    expect(Array.isArray(recs)).toBe(true);
  });

  it('inventory valuation returns data', async () => {
    const val = await ctx.services.report.getInventoryValuation({});
    expect(val).toBeDefined();
    expect(Array.isArray(val.data)).toBe(true);
  });
});

// ─── Audit ───────────────────────────────────────────────────────────────────

describe('Audit trail', () => {
  it('audit logs captured from business operations', async () => {
    const logs = await ctx.services.audit.getAll({});
    expect(logs.data.length).toBeGreaterThan(0);
  });
});
