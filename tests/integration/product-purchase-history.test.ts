/**
 * Product purchase lookup ("By product") against a real SQLite database.
 */
import { createTestContext, type TestContext } from '../helpers/test-db';
import { toLocalISODate, addDaysISO } from '@core/common/dates';
import { endOfMonthISO } from '@core/common/expiry';

describe('product purchase lookup', () => {
  let ctx: TestContext;
  let adminId: number;

  beforeEach(async () => {
    ctx = await createTestContext();
    adminId = (await ctx.services.auth.login('admin', 'admin123')).user.id;
  });
  afterEach(() => ctx.destroy());

  const db = () => ctx.repos.base.db;
  const expiry = (days = 400) => {
    const d = addDaysISO(toLocalISODate(new Date()), days);
    return endOfMonthISO(Number(d.slice(0, 4)), Number(d.slice(5, 7)));
  };
  function makeProduct(name: string, cf = 10, barcode: string | null = null, generic: string | null = null): number {
    return Number(db().prepare(
      `INSERT INTO products (name, generic_name, parent_unit, child_unit, conversion_factor, barcode, is_active) VALUES (?, ?, 'Box', 'Strip', ?, ?, 1)`
    ).run(name, generic, cf, barcode).lastInsertRowid);
  }
  async function buy(productId: number, supplierId: number, date: string, qty: number, cost: number) {
    return ctx.services.purchase.createPurchase({
      supplier_id: supplierId, purchase_date: date, total_amount: 0,
      payment_plan: { type: 'full', payment_method: 'bank_transfer' },
      items: [{ product_id: productId, quantity: qty, cost_per_parent: cost, selling_price_parent: 3000, expiry_date: expiry() }],
    }, adminId);
  }

  it('lists every line with its change, remaining stock and shelf life, and compares suppliers', async () => {
    const pid = makeProduct('Zirocin 500', 3, '6221000009999', 'Azithromycin');
    const a = await ctx.services.purchase.createSupplier({ name: 'Supplier A' }, adminId);
    const b = await ctx.services.purchase.createSupplier({ name: 'Supplier B' }, adminId);
    const today = toLocalISODate(new Date());
    await buy(pid, a.id, addDaysISO(today, -60), 10, 2000);
    await buy(pid, b.id, addDaysISO(today, -30), 10, 1900);
    await buy(pid, a.id, addDaysISO(today, -5), 5, 2500);

    const history = await ctx.services.productPurchaseHistory.getHistory(pid);
    expect(history.lines.map(l => l.cost_per_parent)).toEqual([2500, 1900, 2000]); // newest first
    expect(history.lines[0].change_pct).toBeCloseTo(31.6, 1);
    expect(history.lines[1]).toMatchObject({ bonus_qty: 0, batch_remaining_base: 30, effective_cost_per_parent: 1900 });
    expect(history.lines[2].shelf_life_days).toBeGreaterThan(400);

    expect(history.summary).toMatchObject({
      invoices: 3, suppliers: 2, lines: 3, quantity: 25, bonus: 0, received: 25,
      spend: 20000 + 19000 + 12500, last_cost: 2500, lowest_effective_cost: 1900,
    });
    expect(history.summary.change_since_first_pct).toBe(25);

    // Supplier A's last price is newer but higher; B is cheapest.
    expect(history.suppliers[0]).toMatchObject({ supplier_name: 'Supplier B', is_cheapest: true, gap_to_cheapest_pct: 0 });
    expect(history.suppliers[1]).toMatchObject({ supplier_name: 'Supplier A', last_cost: 2500, is_cheapest: false });
    expect(history.suppliers[1].gap_to_cheapest_pct).toBeCloseTo(31.6, 0);

    const filtered = await ctx.services.productPurchaseHistory.getHistory(pid, { supplier_id: a.id, start_date: addDaysISO(today, -10) });
    expect(filtered.lines).toHaveLength(1);
    // "Change from the previous purchase" still looks at the full history.
    expect(filtered.lines[0].previous_cost).toBe(1900);
    await expect(ctx.services.productPurchaseHistory.getHistory(pid, { start_date: '01/01/2026' })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('mentions parked invoice lines that name the product', async () => {
    const pid = makeProduct('Parkocin 250');
    const supplier = await ctx.services.purchase.createSupplier({ name: 'Parking Supplier' }, adminId);
    await ctx.services.purchase.createPurchase({
      supplier_id: supplier.id, purchase_date: toLocalISODate(new Date()), total_amount: 5000,
      payment_plan: { type: 'full', payment_method: 'cash' },
      pending_items: [{ raw_data: JSON.stringify({ name: 'Parkocin 250 caps', quantity: 2, costPerParent: 2500 }) }],
    }, adminId);
    const history = await ctx.services.productPurchaseHistory.getHistory(pid);
    expect(history.lines).toHaveLength(0);
    expect(history.parked).toHaveLength(1);
    expect(history.parked[0]).toMatchObject({ supplier_name: 'Parking Supplier' });
  });
});
