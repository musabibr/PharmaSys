/**
 * Match step: receiving an invoice line in the invoice's units, which updates
 * the matched product (and its existing stock) inside the purchase.
 */
import { createTestContext, type TestContext } from '../helpers/test-db';
import { toLocalISODate, addDaysISO } from '@core/common/dates';
import { endOfMonthISO } from '@core/common/expiry';
import { PermissionError, ValidationError } from '@core/types/errors';
import { assertProductUnitsAllowed } from '@core/common/purchase-permissions';

describe('receiving in the invoice\'s units', () => {
  let ctx: TestContext;
  let adminId: number;
  const today = toLocalISODate(new Date());

  beforeEach(async () => {
    ctx = await createTestContext();
    adminId = (await ctx.services.auth.login('admin', 'admin123')).user.id;
  });
  // Audit rows are written after each commit; let them land before closing.
  afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 20)); ctx.destroy(); });

  const db = () => ctx.repos.base.db;
  const row = (sql: string, ...params: unknown[]) => db().prepare(sql).get(...params) as any;
  const expiry = (days = 400) => {
    const d = addDaysISO(today, days);
    return endOfMonthISO(Number(d.slice(0, 4)), Number(d.slice(5, 7)));
  };
  function makeProduct(name: string, child: string | null, cf: number): number {
    return Number(db().prepare(
      `INSERT INTO products (name, parent_unit, child_unit, conversion_factor, is_active) VALUES (?, 'Box', ?, ?, 1)`
    ).run(name, child, cf).lastInsertRowid);
  }
  const buy = (items: Array<Record<string, unknown>>) => ctx.services.purchase.createPurchase({
    purchase_date: today, total_amount: 0,
    payment_plan: { type: 'full', payment_method: 'cash' },
    items: items as any,
  }, adminId);
  const stock = (productId: number) => row('SELECT COALESCE(SUM(quantity_base), 0) AS q FROM batches WHERE product_id = ?', productId).q as number;

  it('adds a small unit to a product counted in boxes, keeping its box count', async () => {
    const pid = makeProduct('Units Boxed', null, 1);
    await buy([{ product_id: pid, quantity: 5, cost_per_parent: 6000, selling_price_parent: 7200, expiry_date: expiry() }]);
    expect(stock(pid)).toBe(5); // 5 boxes, counted in boxes

    // The invoice says Box = 10 Strip: 3 boxes at 6,300.
    await buy([{
      product_id: pid, quantity: 3, cost_per_parent: 6300, selling_price_parent: 7500, selling_price_child: 800, expiry_date: expiry(500),
      product_units: { parent_unit: 'Box', child_unit: 'Strip', conversion_factor: 10, rescale_stock: 'keep_packs' },
    }]);
    expect(row('SELECT parent_unit, child_unit, conversion_factor FROM products WHERE id = ?', pid))
      .toEqual({ parent_unit: 'Box', child_unit: 'Strip', conversion_factor: 10 });
    expect(stock(pid)).toBe(80); // the old 5 boxes as 50 strips, plus 30 strips received
    const batches = db().prepare('SELECT quantity_base, selling_price_parent, selling_price_child FROM batches WHERE product_id = ? ORDER BY id').all(pid) as any[];
    expect(batches.map(b => b.quantity_base)).toEqual([50, 30]);
    // Old stock now sells at the new price, per strip too.
    expect(batches[0]).toMatchObject({ selling_price_parent: 7500, selling_price_child: 800 });
    await new Promise(resolve => setTimeout(resolve, 20)); // audit rows are written after commit
    const audit = db().prepare(`SELECT action FROM audit_logs WHERE record_id = ? AND table_name = 'products' ORDER BY id`).all(pid).map((r: any) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['CASCADE_CF_CHANGE', 'UPDATE_PRODUCT']));
  });

  it('corrects a pack size keeping the strip count, and refuses units it cannot use', async () => {
    const pid = makeProduct('Units Corrected', 'Strip', 10);
    await buy([{ product_id: pid, quantity: 4.5, cost_per_parent: 6000, selling_price_parent: 7200, expiry_date: expiry() }]);
    expect(stock(pid)).toBe(45);

    await buy([{
      product_id: pid, quantity: 2, cost_per_parent: 1800, selling_price_parent: 2100, expiry_date: expiry(),
      product_units: { parent_unit: 'Box', child_unit: 'Strip', conversion_factor: 3 },
    }]);
    expect(row('SELECT conversion_factor FROM products WHERE id = ?', pid).conversion_factor).toBe(3);
    expect(stock(pid)).toBe(45 + 6); // strips kept as they are
    // Each old strip keeps its cost: 6,000 a box of 10 is 1,800 a box of 3, still 600 a strip.
    expect(row('SELECT cost_per_parent, cost_per_child FROM batches WHERE product_id = ? ORDER BY id LIMIT 1', pid))
      .toEqual({ cost_per_parent: 1800, cost_per_child: 600 });

    const before = row('SELECT COUNT(*) AS c FROM purchases').c;
    await expect(buy([{
      product_id: pid, quantity: 1, cost_per_parent: 1800, selling_price_parent: 2100, expiry_date: expiry(),
      product_units: { parent_unit: '', child_unit: 'Strip', conversion_factor: 3 },
    }])).rejects.toThrow(ValidationError);
    await expect(buy([{
      product_id: pid, quantity: 1, cost_per_parent: 1800, selling_price_parent: 2100, expiry_date: expiry(),
      product_units: { parent_unit: 'Box', child_unit: 'Strip', conversion_factor: 0 },
    }])).rejects.toThrow(ValidationError);
    // Nothing of a refused invoice is kept, the product included.
    expect(row('SELECT COUNT(*) AS c FROM purchases').c).toBe(before);
    expect(row('SELECT conversion_factor FROM products WHERE id = ?', pid).conversion_factor).toBe(3);
  });

  it('describes matched products for the Match step', async () => {
    const pid = makeProduct('Units Context', 'Strip', 10);
    const supplier = await ctx.services.purchase.createSupplier({ name: 'Context Supplier' }, adminId);
    await ctx.services.purchase.createPurchase({
      supplier_id: supplier.id, purchase_date: addDaysISO(today, -3), total_amount: 0,
      payment_plan: { type: 'full', payment_method: 'cash' },
      items: [{ product_id: pid, quantity: 2, cost_per_parent: 6000, selling_price_parent: 7500, expiry_date: expiry() }],
    }, adminId);
    const [ctxRow] = await ctx.services.purchase.getMatchContext([pid]);
    expect(ctxRow).toMatchObject({
      product_id: pid, parent_unit: 'Box', child_unit: 'Strip', conversion_factor: 10, stock_base: 20,
      price: 7500, price_child: 750, price_source: 'current',
      last_cost_parent: 6000, last_cost_date: addDaysISO(today, -3), last_cost_supplier: 'Context Supplier',
    });

    // Sold out: the last price stays visible as "last".
    db().prepare(`UPDATE batches SET quantity_base = 0, status = 'sold_out' WHERE product_id = ?`).run(pid);
    const [soldOut] = await ctx.services.purchase.getMatchContext([pid]);
    expect(soldOut).toMatchObject({ stock_base: 0, price: 7500, price_source: 'last' });

    await expect(ctx.services.purchase.getMatchContext('x')).rejects.toThrow(ValidationError);
  });

  it('lets only users who may edit products change units through a purchase', () => {
    const items = [{ product_id: 1, product_units: { parent_unit: 'Box' } }];
    const base = { perm_finance: 0, perm_inventory: 0, perm_reports: 0 };
    const buyer = { ...base, role: 'pharmacist', permissions_json: JSON.stringify(['purchases.manage']) };
    const editor = { ...base, role: 'pharmacist', permissions_json: JSON.stringify(['purchases.manage', 'inventory.products.manage']) };
    expect(() => assertProductUnitsAllowed(buyer, items)).toThrow(PermissionError);
    expect(() => assertProductUnitsAllowed(buyer, [{ product_id: 1 }])).not.toThrow();
    expect(() => assertProductUnitsAllowed(editor, items)).not.toThrow();
    expect(() => assertProductUnitsAllowed({ ...base, role: 'admin', permissions_json: null }, items)).not.toThrow();
  });
});
