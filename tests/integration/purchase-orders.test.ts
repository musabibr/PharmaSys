/**
 * Purchase orders received through invoices (L4) against a real SQLite database.
 */
import { createTestContext, type TestContext } from '../helpers/test-db';
import { toLocalISODate, addDaysISO } from '@core/common/dates';
import { endOfMonthISO } from '@core/common/expiry';
import { BusinessRuleError, NotFoundError, ValidationError } from '@core/types/errors';

describe('purchase orders', () => {
  let ctx: TestContext;
  let adminId: number;
  const today = toLocalISODate(new Date());

  beforeEach(async () => {
    ctx = await createTestContext();
    adminId = (await ctx.services.auth.login('admin', 'admin123')).user.id;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    ctx.destroy();
  });

  const db = () => ctx.repos.base.db;
  const row = (sql: string, ...params: unknown[]) => db().prepare(sql).get(...params) as any;
  const expiry = (days = 400) => {
    const d = addDaysISO(today, days);
    return endOfMonthISO(Number(d.slice(0, 4)), Number(d.slice(5, 7)));
  };
  function makeProduct(name: string, cf = 10): number {
    return Number(db().prepare(
      `INSERT INTO products (name, parent_unit, child_unit, conversion_factor, is_active) VALUES (?, 'Box', 'Strip', ?, 1)`
    ).run(name, cf).lastInsertRowid);
  }
  const line = (productId: number, boxes: number, cost: number, expiryDate = expiry()) =>
    ({ product_id: productId, quantity: boxes, cost_per_parent: cost, selling_price_parent: cost * 2, expiry_date: expiryDate });
  const invoice = (supplierId: number, items: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) =>
    ctx.services.purchase.createPurchase({
      supplier_id: supplierId, purchase_date: today,
      total_amount: items.reduce((s, i) => s + i.quantity * i.cost_per_parent, 0),
      payment_plan: { type: 'full', payment_method: 'cash' },
      items, ...extra,
    }, adminId);

  it('orders, sends, receives in two deliveries against the order, reports discrepancies and closes', async () => {
    const supplier = await ctx.services.purchase.createSupplier({ name: 'Order Supplier', phone: '0912' }, adminId);
    const other = await ctx.services.purchase.createSupplier({ name: 'Someone Else' }, adminId);
    const amox = makeProduct('Order Amox');
    const para = makeProduct('Order Para', 1);
    const extra = makeProduct('Unordered Extra');

    // The last invoice cost fills a missing expected cost.
    await invoice(supplier.id, [line(amox, 1, 950)]);

    await expect(ctx.services.purchaseOrder.create({ supplier_id: supplier.id, items: [] }, adminId)).rejects.toThrow(ValidationError);
    await expect(ctx.services.purchaseOrder.create({
      supplier_id: supplier.id, items: [{ product_id: amox, quantity: 1 }, { product_id: amox, quantity: 2 }],
    }, adminId)).rejects.toThrow(/only once/);
    await expect(ctx.services.purchaseOrder.create({
      supplier_id: supplier.id, order_date: addDaysISO(today, 1), items: [{ product_id: amox, quantity: 1 }],
    }, adminId)).rejects.toThrow(/future/);

    const po = await ctx.services.purchaseOrder.create({
      supplier_id: supplier.id, expected_date: addDaysISO(today, 3), notes: 'Urgent',
      items: [{ product_id: amox, quantity: 10 }, { product_id: para, quantity: 20, expected_cost_parent: 300 }],
    }, adminId);
    expect(po.po_number).toMatch(/^PO-\d{8}-001$/);
    expect(po).toMatchObject({ status: 'draft', display_status: 'draft', receipt_status: 'none', lines: 2, ordered_units: 30, expected_value: 10 * 950 + 20 * 300 });
    expect(po.items.find(i => i.product_id === amox)).toMatchObject({ expected_cost_parent: 950, received_quantity: 0 });

    const edited = await ctx.services.purchaseOrder.update(po.id, {
      supplier_id: supplier.id, expected_date: addDaysISO(today, 3),
      items: [{ product_id: amox, quantity: 12, expected_cost_parent: 950 }, { product_id: para, quantity: 20, expected_cost_parent: 300 }],
    }, adminId);
    expect(edited.ordered_units).toBe(32);

    // Not receivable until sent.
    await expect(invoice(supplier.id, [line(amox, 1, 950)], { purchase_order_id: po.id })).rejects.toThrow(BusinessRuleError);
    await expect(ctx.services.purchaseOrder.receivePrefill(po.id)).rejects.toThrow(/sent order/);

    const sent = await ctx.services.purchaseOrder.send(po.id, adminId);
    expect(sent.status).toBe('sent');
    expect(sent.sent_at).toBeTruthy();
    expect(sent.share_text).toContain(po.po_number);
    expect(sent.share_text).toContain('Order Amox — 12 Box');
    await expect(ctx.services.purchaseOrder.update(po.id, { supplier_id: supplier.id, items: [{ product_id: amox, quantity: 1 }] }, adminId))
      .rejects.toThrow(/already sent/);
    await expect(ctx.services.purchaseOrder.send(po.id, adminId)).rejects.toThrow(/not a draft/);

    // The wrong supplier cannot deliver the order; a failed attempt leaves nothing behind.
    const purchasesBefore = row('SELECT COUNT(*) AS c FROM purchases').c;
    await expect(invoice(other.id, [line(amox, 1, 950)], { purchase_order_id: po.id })).rejects.toThrow(/choose that supplier/);
    await expect(invoice(supplier.id, [line(amox, 1, 950)], { purchase_order_id: 99999 })).rejects.toThrow(NotFoundError);
    expect(row('SELECT COUNT(*) AS c FROM purchases').c).toBe(purchasesBefore);

    // First delivery: 5 of 12 Amox at a higher price, plus a product that was not ordered.
    const first = await invoice(supplier.id, [line(amox, 5, 1000), line(extra, 2, 100)], { purchase_order_id: po.id });
    expect(row('SELECT purchase_order_id FROM purchases WHERE id = ?', first.id).purchase_order_id).toBe(po.id);
    expect(row('SELECT po_item_id FROM purchase_items WHERE purchase_id = ? AND product_id = ?', first.id, extra).po_item_id).toBeNull();
    expect((await ctx.services.purchase.getById(first.id)).po_number).toBe(po.po_number);

    let detail = await ctx.services.purchaseOrder.getById(po.id);
    expect(detail).toMatchObject({ receipt_status: 'partial', display_status: 'partially_received', received_units: 5, invoices: 1 });
    expect(detail.discrepancies.map(d => [d.product_name, d.kind]).sort()).toEqual([
      // Para has not arrived at all yet: pending, not short, while the order is open.
      ['Order Amox', 'cost'], ['Order Amox', 'short'],
    ]);

    const prefill = await ctx.services.purchaseOrder.receivePrefill(po.id);
    expect(prefill).toEqual({
      purchase_order_id: po.id, supplier_id: supplier.id,
      items: expect.arrayContaining([
        { product_id: amox, quantity: 7, cost_parent: 950 },
        { product_id: para, quantity: 20, cost_parent: 300 },
      ]),
    });
    expect(prefill.items).toHaveLength(2);

    // A line added to the invoice later is matched too; the supplier of a matched invoice is fixed.
    await ctx.services.purchase.addItemsToPurchase(first.id, [line(para, 5, 300)], adminId);
    expect(row('SELECT po_item_id FROM purchase_items WHERE purchase_id = ? AND product_id = ?', first.id, para).po_item_id).not.toBeNull();
    await expect(ctx.services.purchase.updatePurchase(first.id, { supplier_id: other.id }, adminId)).rejects.toThrow(/supplier cannot change/);

    // Second delivery completes Amox and over-delivers Para.
    const second = await invoice(supplier.id, [line(amox, 7, 950), line(para, 17, 300)], { purchase_order_id: po.id });
    detail = await ctx.services.purchaseOrder.getById(po.id);
    expect(detail).toMatchObject({ receipt_status: 'complete', display_status: 'received', received_units: 32, invoices: 2 });
    expect(detail.items.find(i => i.product_id === para)).toMatchObject({ received_quantity: 22 });
    expect(detail.items.find(i => i.product_id === amox)!.invoiced_cost_parent).toBeCloseTo((5 * 1000 + 7 * 950) / 12, 3);
    expect(detail.discrepancies.map(d => [d.product_name, d.kind]).sort()).toEqual([['Order Amox', 'cost'], ['Order Para', 'over']]);
    expect(detail.purchases.map(p => p.id)).toEqual([first.id, second.id]);

    const dup = makeProduct('Order Para Duplicate', 1);
    await ctx.services.purchaseOrder.create({ supplier_id: supplier.id, items: [{ product_id: dup, quantity: 1 }] }, adminId);

    // Deleting an invoice takes its receipts off the order.
    await ctx.services.purchase.deletePurchase(second.id, adminId, true);
    expect((await ctx.services.purchaseOrder.getById(po.id))).toMatchObject({ received_units: 10, invoices: 1, display_status: 'partially_received' });

    await expect(ctx.services.purchaseOrder.close(po.id, '', adminId)).rejects.toThrow(ValidationError);
    const closed = await ctx.services.purchaseOrder.close(po.id, 'Supplier out of stock', adminId);
    expect(closed).toMatchObject({ status: 'closed', display_status: 'closed', close_reason: 'Supplier out of stock' });
    await expect(ctx.services.purchaseOrder.close(po.id, 'again', adminId)).rejects.toThrow(/already closed/);
    await expect(invoice(supplier.id, [line(amox, 1, 950)], { purchase_order_id: po.id })).rejects.toThrow(/not open for receiving/);

    // An order nothing arrived for is cancelled.
    const unused = await ctx.services.purchaseOrder.create({ supplier_id: supplier.id, items: [{ product_id: amox, quantity: 3 }] }, adminId);
    expect((await ctx.services.purchaseOrder.close(unused.id, 'Not needed', adminId)).status).toBe('cancelled');

    const list = await ctx.services.purchaseOrder.list({ search: 'Order Para Duplicate' });
    expect(list.data).toHaveLength(1);
    expect(list.data[0].display_status).toBe('draft');
    expect((await ctx.services.purchaseOrder.list({ status: 'closed' })).data.map(p => p.id)).toEqual([po.id]);

    const actions = db().prepare(`SELECT action FROM audit_logs WHERE action LIKE '%_PURCHASE_ORDER' ORDER BY id`).all().map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['CREATE_PURCHASE_ORDER', 'UPDATE_PURCHASE_ORDER', 'SEND_PURCHASE_ORDER', 'CLOSE_PURCHASE_ORDER', 'CANCEL_PURCHASE_ORDER']));
  });

  it('keeps merged invoices on their order and refuses to mix orders', async () => {
    const supplier = await ctx.services.purchase.createSupplier({ name: 'Merge Supplier' }, adminId);
    const a = makeProduct('Merge A');
    const b = makeProduct('Merge B');
    const po1 = await ctx.services.purchaseOrder.create({ supplier_id: supplier.id, items: [{ product_id: a, quantity: 4, expected_cost_parent: 100 }, { product_id: b, quantity: 4, expected_cost_parent: 100 }] }, adminId);
    const po2 = await ctx.services.purchaseOrder.create({ supplier_id: supplier.id, items: [{ product_id: a, quantity: 1, expected_cost_parent: 100 }] }, adminId);
    await ctx.services.purchaseOrder.send(po1.id, adminId);
    await ctx.services.purchaseOrder.send(po2.id, adminId);

    const unpaid = (amount: number) => ({ payment_plan: { type: 'installments', installments: [{ due_date: addDaysISO(today, 30), amount }] } });
    const onOrder = await invoice(supplier.id, [line(a, 4, 100)], { purchase_order_id: po1.id, ...unpaid(400) });
    const loose = await invoice(supplier.id, [line(b, 4, 100)], unpaid(400));
    const other = await invoice(supplier.id, [line(a, 1, 100)], { purchase_order_id: po2.id, ...unpaid(100) });

    await expect(ctx.services.purchase.mergePurchases(onOrder.id, [other.id], adminId)).rejects.toThrow(/different purchase orders/);

    // The loose invoice is merged into a new target that had no order: the target adopts the order.
    await ctx.services.purchase.mergePurchases(loose.id, [onOrder.id], adminId);
    expect(row('SELECT purchase_order_id FROM purchases WHERE id = ?', loose.id).purchase_order_id).toBe(po1.id);
    const detail = await ctx.services.purchaseOrder.getById(po1.id);
    expect(detail).toMatchObject({ received_units: 8, receipt_status: 'complete', invoices: 1 });
  });
});
