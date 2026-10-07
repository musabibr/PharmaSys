import type { BaseRepository } from '../repositories/sql/base.repository';
import type {
  PurchaseOrderRepository, PurchaseOrder, PurchaseOrderItem, PurchaseOrderFilters, PurchaseOrderStatus, ReceiptStatus,
} from '../repositories/sql/purchase-order.repository';
import type { SupplierRepository } from '../repositories/sql/supplier.repository';
import type { ProductRepository } from '../repositories/sql/product.repository';
import type { EventBus } from '../events/event-bus';
import type { PaginatedResult } from '../types/models';
import { Validate } from '../common/validation';
import { todayLocalISO } from '../common/expiry';
import { BusinessRuleError, NotFoundError, ValidationError } from '../types/errors';

export type { PurchaseOrder, PurchaseOrderItem, PurchaseOrderFilters, PurchaseOrderStatus, ReceiptStatus };

const MAX_LINES = 300;

export interface PurchaseOrderInput {
  supplier_id: number;
  order_date?: string | null;
  expected_date?: string | null;
  notes?: string | null;
  items: Array<{ product_id: number; quantity: number; expected_cost_parent?: number | null; notes?: string | null }>;
}

export interface PurchaseOrderDetail extends PurchaseOrder {
  /** How far invoices have filled the order. */
  receipt_status: ReceiptStatus;
  /** What people see: draft, sent, partially received, received, closed, cancelled. */
  display_status: 'draft' | 'sent' | 'partially_received' | 'received' | 'closed' | 'cancelled';
  items: PurchaseOrderItem[];
  purchases: Array<{ id: number; purchase_number: string; invoice_reference: string | null; purchase_date: string; total_amount: number }>;
  /** Lines where the invoice differs from the order (quantity short or over, cost changed by more than 1%). */
  discrepancies: Array<{ product_id: number; product_name: string; ordered: number; received: number; expected_cost_parent: number | null; invoiced_cost_parent: number | null; kind: 'short' | 'over' | 'cost' }>;
}

export interface ReceivePrefill {
  purchase_order_id: number;
  supplier_id: number;
  items: Array<{ product_id: number; quantity: number; cost_parent: number | null }>;
}

/**
 * Purchase orders (L4): drafted by hand, sent to the
 * supplier as a message or print-out, received through ordinary invoices that
 * are matched back to the order line by line.
 */
export class PurchaseOrderService {
  constructor(
    private readonly base: BaseRepository,
    private readonly repo: PurchaseOrderRepository,
    private readonly suppliers: SupplierRepository,
    private readonly products: ProductRepository,
    private readonly bus: EventBus,
  ) {}

  async list(filters: PurchaseOrderFilters = {}): Promise<PaginatedResult<PurchaseOrder & { display_status: PurchaseOrderDetail['display_status'] }>> {
    if (filters.status !== undefined) Validate.enum(filters.status, ['draft', 'sent', 'closed', 'cancelled'] as const, 'Status');
    const page = await this.repo.list(filters);
    return { ...page, data: page.data.map(po => ({ ...po, display_status: displayStatus(po) })) };
  }

  async getById(id: number): Promise<PurchaseOrderDetail> {
    Validate.id(id, 'Purchase order');
    const po = await this.repo.getById(id);
    if (!po) throw new NotFoundError('Purchase order', id);
    const [items, purchases] = await Promise.all([this.repo.getItems(id), this.repo.getLinkedPurchases(id)]);
    const discrepancies: PurchaseOrderDetail['discrepancies'] = [];
    if (purchases.length > 0) {
      for (const i of items) {
        const received = i.received_quantity ?? 0;
        const base = { product_id: i.product_id, product_name: i.product_name ?? '', ordered: i.quantity, received, expected_cost_parent: i.expected_cost_parent, invoiced_cost_parent: i.invoiced_cost_parent ?? null };
        if (received > i.quantity) discrepancies.push({ ...base, kind: 'over' });
        else if ((po.status === 'closed' || receiptStatus(po) === 'complete' || received > 0) && received < i.quantity) discrepancies.push({ ...base, kind: 'short' });
        if (received > 0 && i.expected_cost_parent && i.invoiced_cost_parent
          && Math.abs(i.invoiced_cost_parent - i.expected_cost_parent) > i.expected_cost_parent * 0.01) {
          discrepancies.push({ ...base, kind: 'cost' });
        }
      }
    }
    return { ...po, receipt_status: receiptStatus(po), display_status: displayStatus(po), items, purchases, discrepancies };
  }

  async create(input: PurchaseOrderInput, userId: number): Promise<PurchaseOrderDetail> {
    const clean = await this._validate(input);
    const id = await this.base.inTransaction(async () => {
      const number = await this.repo.nextNumber(clean.order_date.replace(/-/g, ''));
      const poId = await this.repo.insert({ po_number: number, supplier_id: clean.supplier_id, order_date: clean.order_date, expected_date: clean.expected_date, notes: clean.notes, user_id: userId });
      await this.repo.replaceItems(poId, await this._withCosts(clean.items, clean.supplier_id));
      return poId;
    });
    const detail = await this.getById(id);
    this.bus.emit('entity:mutated', {
      action: 'CREATE_PURCHASE_ORDER', table: 'purchase_orders', recordId: id, userId,
      newValues: { po_number: detail.po_number, supplier_id: detail.supplier_id, lines: detail.items.length },
    });
    return detail;
  }

  async update(id: number, input: PurchaseOrderInput, userId: number): Promise<PurchaseOrderDetail> {
    Validate.id(id, 'Purchase order');
    const clean = await this._validate(input);
    await this.base.inTransaction(async () => {
      const po = await this.repo.getById(id);
      if (!po) throw new NotFoundError('Purchase order', id);
      if (po.status !== 'draft') throw new BusinessRuleError(`${po.po_number} was already sent and can no longer be edited`);
      await this.repo.updateHeader(id, clean);
      await this.repo.replaceItems(id, await this._withCosts(clean.items, clean.supplier_id));
    });
    this.bus.emit('entity:mutated', { action: 'UPDATE_PURCHASE_ORDER', table: 'purchase_orders', recordId: id, userId, newValues: { lines: clean.items.length } });
    return await this.getById(id);
  }

  async send(id: number, userId: number): Promise<PurchaseOrderDetail & { share_text: string }> {
    Validate.id(id, 'Purchase order');
    const po = await this.repo.getById(id);
    if (!po) throw new NotFoundError('Purchase order', id);
    if ((po.lines ?? 0) === 0) throw new ValidationError('Add at least one product before sending the order', 'items');
    if ((await this.repo.setStatus(id, ['draft'], 'sent', { sent: true })) !== 1) {
      throw new BusinessRuleError(`${po.po_number} is not a draft`);
    }
    this.bus.emit('entity:mutated', { action: 'SEND_PURCHASE_ORDER', table: 'purchase_orders', recordId: id, userId, newValues: { status: 'sent' } });
    const detail = await this.getById(id);
    return { ...detail, share_text: shareText(detail) };
  }

  async shareText(id: number): Promise<string> {
    return shareText(await this.getById(id));
  }

  /** Stop expecting the rest: a partly received order is closed, an unreceived one cancelled. */
  async close(id: number, reason: string, userId: number): Promise<PurchaseOrderDetail> {
    Validate.id(id, 'Purchase order');
    const why = Validate.requiredString(reason, 'Reason', 500);
    const po = await this.repo.getById(id);
    if (!po) throw new NotFoundError('Purchase order', id);
    const to: PurchaseOrderStatus = (po.invoices ?? 0) > 0 ? 'closed' : 'cancelled';
    if ((await this.repo.setStatus(id, ['draft', 'sent'], to, { closed: true, reason: why })) !== 1) {
      throw new BusinessRuleError(`${po.po_number} is already ${po.status}`);
    }
    this.bus.emit('entity:mutated', {
      action: to === 'closed' ? 'CLOSE_PURCHASE_ORDER' : 'CANCEL_PURCHASE_ORDER', table: 'purchase_orders', recordId: id, userId,
      oldValues: { status: po.status }, newValues: { status: to, reason: why },
    });
    return await this.getById(id);
  }

  /** What an invoice against the order should start from: the quantities still to come. */
  async receivePrefill(id: number): Promise<ReceivePrefill> {
    const detail = await this.getById(id);
    if (detail.status !== 'sent') throw new BusinessRuleError(`Only a sent order can be received (${detail.po_number} is ${detail.display_status.replace('_', ' ')})`);
    return {
      purchase_order_id: detail.id,
      supplier_id: detail.supplier_id,
      items: detail.items
        .map(i => ({ product_id: i.product_id, quantity: Math.max(0, i.quantity - (i.received_quantity ?? 0)), cost_parent: i.expected_cost_parent }))
        .filter(i => i.quantity > 0),
    };
  }

  /**
   * Called by purchase creation (inside its transaction): checks the invoice
   * may be received against the order and links its lines.
   */
  async attachInvoice(purchaseId: number, poId: number, supplierId: number | null): Promise<void> {
    const po = await this.repo.getById(poId);
    if (!po) throw new NotFoundError('Purchase order', poId);
    if (po.status !== 'sent') throw new BusinessRuleError(`${po.po_number} is not open for receiving`);
    if (supplierId !== po.supplier_id) throw new ValidationError(`${po.po_number} was ordered from ${po.supplier_name}; choose that supplier for the invoice`, 'supplier_id');
    await this.repo.linkPurchase(purchaseId, poId);
  }

  private async _validate(input: PurchaseOrderInput) {
    if (!input || typeof input !== 'object') throw new ValidationError('Order details are required', 'supplier_id');
    const supplierId = Validate.id(input.supplier_id, 'Supplier');
    if (!(await this.suppliers.getById(supplierId))) throw new NotFoundError('Supplier', supplierId);
    const today = todayLocalISO();
    const orderDate = input.order_date ? Validate.dateString(input.order_date, 'Order date') : today;
    if (orderDate > today) throw new ValidationError('Order date cannot be in the future', 'order_date');
    const expected = input.expected_date ? Validate.dateString(input.expected_date, 'Expected date') : null;
    if (expected && expected < orderDate) throw new ValidationError('Expected delivery cannot be before the order date', 'expected_date');
    if (!Array.isArray(input.items) || input.items.length === 0) throw new ValidationError('Add at least one product', 'items');
    if (input.items.length > MAX_LINES) throw new ValidationError(`An order can have at most ${MAX_LINES} lines`, 'items');
    const seen = new Set<number>();
    const items = [];
    for (const [i, item] of input.items.entries()) {
      const productId = Validate.id(item?.product_id, `Line ${i + 1} product`);
      if (seen.has(productId)) throw new ValidationError('A product can appear only once in an order', 'items');
      seen.add(productId);
      const product = await this.products.getById(productId);
      if (!product) throw new NotFoundError('Product', productId);
      const cost = item.expected_cost_parent;
      if (cost !== undefined && cost !== null && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) {
        throw new ValidationError(`Line ${i + 1}: expected cost must be 0 or more`, 'expected_cost_parent');
      }
      items.push({
        product_id: productId,
        quantity: Validate.positiveInteger(item.quantity, `Line ${i + 1} quantity`),
        expected_cost_parent: cost === undefined || cost === null || String(cost) === '' ? null : Math.round(Number(cost) * 1000) / 1000,
        notes: Validate.optionalString(item.notes, 'Line note', 200),
      });
    }
    return { supplier_id: supplierId, order_date: orderDate, expected_date: expected, notes: Validate.optionalString(input.notes, 'Notes', 500), items };
  }

  private async _withCosts<T extends { product_id: number; expected_cost_parent: number | null }>(items: T[], supplierId: number): Promise<T[]> {
    const missing = items.filter(i => i.expected_cost_parent === null).map(i => i.product_id);
    if (missing.length === 0) return items;
    const costs = await this.repo.getLastCosts(missing, supplierId);
    return items.map(i => (i.expected_cost_parent === null ? { ...i, expected_cost_parent: costs.get(i.product_id) ?? null } : i));
  }
}

function receiptStatus(po: PurchaseOrder): ReceiptStatus {
  const ordered = po.ordered_units ?? 0;
  const received = po.received_units ?? 0;
  return received <= 0 ? 'none' : received >= ordered ? 'complete' : 'partial';
}

function displayStatus(po: PurchaseOrder): PurchaseOrderDetail['display_status'] {
  if (po.status !== 'sent') return po.status;
  const r = receiptStatus(po);
  return r === 'complete' ? 'received' : r === 'partial' ? 'partially_received' : 'sent';
}

/** Plain text for WhatsApp or SMS. */
function shareText(po: PurchaseOrderDetail): string {
  const lines = po.items.map((i, n) => `${n + 1}. ${(i.product_name ?? '').trim()} — ${i.quantity} ${i.parent_unit ?? ''}`.trim());
  return [
    `${po.po_number}`,
    `${po.supplier_name ?? ''}`,
    `${po.order_date}${po.expected_date ? ` → ${po.expected_date}` : ''}`,
    '',
    ...lines,
    ...(po.notes ? ['', po.notes] : []),
  ].join('\n');
}

