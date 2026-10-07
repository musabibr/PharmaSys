import type {
  ProductPurchaseHistoryRepository, ProductPurchaseLine, ProductPurchaseHistoryFilters, ParkedLineMention,
} from '../repositories/sql/product-purchase-history.repository';
import type { ProductRepository } from '../repositories/sql/product.repository';
import { Validate } from '../common/validation';
import { isCanonicalISODate, daysBetweenISO } from '../common/dates';
import { todayLocalISO } from '../common/expiry';
import { NotFoundError, ValidationError } from '../types/errors';

export interface ProductPurchaseLineView extends ProductPurchaseLine {
  /** Change of the invoice unit cost from the previous purchase of this product, %. */
  change_pct: number | null;
}

export interface SupplierCostComparison {
  supplier_id: number | null;
  supplier_name: string | null;
  lines: number;
  received: number;
  spend: number;
  last_cost: number;
  last_effective_cost: number;
  last_date: string;
  /** How old the last price is, in days. */
  age_days: number;
  avg_effective_cost: number;
  lowest_effective_cost: number;
  /** How much more the last effective cost is than the cheapest supplier's, %. */
  gap_to_cheapest_pct: number;
  is_cheapest: boolean;
}

export interface ProductPurchaseHistory {
  product: {
    id: number; name: string; generic_name: string | null; barcode: string | null;
    parent_unit: string | null; child_unit: string | null; conversion_factor: number;
    on_hand_base: number; selling_price: number; is_active: number;
  };
  summary: {
    invoices: number;
    suppliers: number;
    lines: number;
    quantity: number;
    bonus: number;
    received: number;
    spend: number;
    stock_cost: number;
    first_date: string | null;
    last_date: string | null;
    last_cost: number | null;
    last_effective_cost: number | null;
    avg_effective_cost: number | null;
    lowest_effective_cost: number | null;
    lowest_cost_date: string | null;
    /** Effective cost change from the first to the last purchase in view, %. */
    change_since_first_pct: number | null;
    /** Margin of today's selling price over the last effective cost, %. */
    margin_at_current_price_pct: number | null;
  };
  suppliers: SupplierCostComparison[];
  lines: ProductPurchaseLineView[];
  parked: ParkedLineMention[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (from: number, to: number) => (from > 0 ? round1((to - from) * 100 / from) : null);

/** Product purchase lookup (PL1–PL5). Read-only; everything is computed from stored lines. */
export class ProductPurchaseHistoryService {
  constructor(
    private readonly repo: ProductPurchaseHistoryRepository,
    private readonly products: ProductRepository,
  ) {}

  async getHistory(productId: number, filters: ProductPurchaseHistoryFilters = {}): Promise<ProductPurchaseHistory> {
    Validate.id(productId, 'Product');
    const f = this._filters(filters);
    const product = await this.products.getById(productId);
    if (!product) throw new NotFoundError('Product', productId);

    const rows = await this.repo.getLines(productId, f);
    const lines: ProductPurchaseLineView[] = rows.map(r => ({
      ...r,
      change_pct: r.previous_cost !== null ? pct(Number(r.previous_cost), Number(r.cost_per_parent)) : null,
    }));

    const chronological = [...lines].reverse();
    const received = lines.reduce((s, l) => s + Number(l.quantity_received) + Number(l.bonus_qty), 0);
    const stockCost = lines.reduce((s, l) => s + Number(l.line_total) + Number(l.allocated_adjustment), 0);
    const lowest = lines.reduce<ProductPurchaseLineView | null>(
      (best, l) => (!best || l.effective_cost_per_parent < best.effective_cost_per_parent ? l : best), null);
    const last = lines[0] ?? null;
    const first = chronological[0] ?? null;
    const sellingPrice = Number(product.selling_price) || 0;

    return {
      product: {
        id: product.id, name: product.name, generic_name: product.generic_name ?? null, barcode: product.barcode ?? null,
        parent_unit: product.parent_unit ?? null, child_unit: product.child_unit ?? null,
        conversion_factor: product.conversion_factor || 1,
        on_hand_base: Number(product.total_stock_base) || 0, selling_price: sellingPrice,
        is_active: Number(product.is_active),
      },
      summary: {
        invoices: new Set(lines.map(l => l.purchase_id)).size,
        suppliers: new Set(lines.map(l => l.supplier_id ?? 0)).size,
        lines: lines.length,
        quantity: lines.reduce((s, l) => s + Number(l.quantity_received), 0),
        bonus: lines.reduce((s, l) => s + Number(l.bonus_qty), 0),
        received,
        spend: lines.reduce((s, l) => s + Number(l.line_total), 0),
        stock_cost: stockCost,
        first_date: first?.purchase_date ?? null,
        last_date: last?.purchase_date ?? null,
        last_cost: last ? Number(last.cost_per_parent) : null,
        last_effective_cost: last ? Number(last.effective_cost_per_parent) : null,
        avg_effective_cost: received > 0 ? Math.round((stockCost / received) * 1000) / 1000 : null,
        lowest_effective_cost: lowest ? Number(lowest.effective_cost_per_parent) : null,
        lowest_cost_date: lowest?.purchase_date ?? null,
        change_since_first_pct: first && last && first !== last
          ? pct(Number(first.effective_cost_per_parent), Number(last.effective_cost_per_parent)) : null,
        margin_at_current_price_pct: last && sellingPrice > 0 ? pct(Number(last.effective_cost_per_parent), sellingPrice) : null,
      },
      suppliers: this._compareSuppliers(lines),
      lines,
      parked: await this.repo.getParkedMentions([product.name, product.barcode ?? '']),
    };
  }

  private _compareSuppliers(lines: ProductPurchaseLineView[]): SupplierCostComparison[] {
    const today = todayLocalISO();
    const groups = new Map<string, ProductPurchaseLineView[]>();
    for (const line of lines) {
      const key = String(line.supplier_id ?? 0);
      const list = groups.get(key);
      if (list) list.push(line); else groups.set(key, [line]);
    }
    const rows = [...groups.values()].map(group => {
      const latest = group[0]; // lines arrive newest first
      const received = group.reduce((s, l) => s + Number(l.quantity_received) + Number(l.bonus_qty), 0);
      const cost = group.reduce((s, l) => s + Number(l.line_total) + Number(l.allocated_adjustment), 0);
      return {
        supplier_id: latest.supplier_id,
        supplier_name: latest.supplier_name,
        lines: group.length,
        received,
        spend: group.reduce((s, l) => s + Number(l.line_total), 0),
        last_cost: Number(latest.cost_per_parent),
        last_effective_cost: Number(latest.effective_cost_per_parent),
        last_date: latest.purchase_date,
        age_days: isCanonicalISODate(latest.purchase_date) ? Math.max(0, daysBetweenISO(latest.purchase_date, today)) : 0,
        avg_effective_cost: received > 0 ? Math.round((cost / received) * 1000) / 1000 : Number(latest.effective_cost_per_parent),
        lowest_effective_cost: Math.min(...group.map(l => Number(l.effective_cost_per_parent))),
        gap_to_cheapest_pct: 0,
        is_cheapest: false,
      };
    });
    const cheapest = Math.min(...rows.map(r => r.last_effective_cost).filter(c => c > 0));
    for (const r of rows) {
      r.is_cheapest = Number.isFinite(cheapest) && r.last_effective_cost === cheapest;
      r.gap_to_cheapest_pct = Number.isFinite(cheapest) && cheapest > 0 ? round1((r.last_effective_cost - cheapest) * 100 / cheapest) : 0;
    }
    return rows.sort((a, b) => a.last_effective_cost - b.last_effective_cost || b.last_date.localeCompare(a.last_date));
  }

  private _filters(filters: ProductPurchaseHistoryFilters): ProductPurchaseHistoryFilters {
    const out: ProductPurchaseHistoryFilters = {};
    for (const key of ['start_date', 'end_date'] as const) {
      const v = filters?.[key];
      if (v === undefined || v === null || v === '') continue;
      if (!isCanonicalISODate(String(v))) throw new ValidationError(`${key === 'start_date' ? 'Start' : 'End'} date must be YYYY-MM-DD`, key);
      out[key] = String(v);
    }
    if (filters?.supplier_id !== undefined && filters.supplier_id !== null && String(filters.supplier_id) !== '') {
      out.supplier_id = Validate.id(filters.supplier_id, 'Supplier');
    }
    if (filters?.payment_status) {
      out.payment_status = Validate.enum(filters.payment_status, ['unpaid', 'partial', 'paid'] as const, 'Payment status');
    }
    if (filters?.in_stock_only === true || String(filters?.in_stock_only) === 'true') out.in_stock_only = true;
    if (filters?.limit !== undefined && String(filters.limit) !== '') {
      const n = Number(filters.limit);
      if (!Number.isInteger(n) || n < 1) throw new ValidationError('Limit must be a positive whole number', 'limit');
      out.limit = n;
    }
    return out;
  }
}
