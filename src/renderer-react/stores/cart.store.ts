import { create } from 'zustand';

export interface CartItem {
  product_id: number;
  product_name: string;
  batch_id: number;
  batch_number: string | null;
  quantity: number;
  unit_type: 'parent' | 'child';
  unit_price: number;
  cost_price: number;
  discount_percent: number;
  conversion_factor: number;
  parent_unit: string;
  child_unit: string;
  availableStock?: number; // max units available when item was added
}

/**
 * Result of a quantity-affecting cart operation — lets the caller show real
 * feedback ("only N available") instead of a silent no-op or clamp (H2).
 */
export interface QuantityResult {
  /** The quantity actually applied (post-clamp). */
  quantity: number;
  /** True when the requested quantity was reduced to fit available stock. */
  clamped: boolean;
  /** True when the input itself was rejected (not a positive integer) — the
   *  cart is unchanged; the caller should show a validation message rather
   *  than silently doing nothing. */
  rejected?: boolean;
  /** The stock ceiling that caused clamping, when known. */
  maxAvailable?: number;
}

interface CartState {
  items: CartItem[];
  /** Add an item, merging into an existing matching line instead of always
   *  creating a new one (H1). */
  addItem: (item: CartItem) => QuantityResult;
  removeItem: (index: number) => void;
  updateQuantity: (index: number, qty: number) => QuantityResult;
  updateDiscount: (index: number, discount: number) => void;
  clear: () => void;
  getSubtotal: () => number;
  getDiscountTotal: () => number;
  getTotal: () => number;
  getItemCount: () => number;
}

/** Rounded gross for a line (whole SDG). Single source of truth so subtotal, discount,
 *  and total can never disagree on how a line is rounded. */
function lineGross(item: CartItem): number {
  return Math.round(item.unit_price * item.quantity);
}

function lineDiscount(item: CartItem): number {
  const pct = Math.min(100, Math.max(0, item.discount_percent));
  return Math.floor(lineGross(item) * pct / 100);
}

function calcLineTotal(item: CartItem): number {
  return Math.max(0, lineGross(item) - lineDiscount(item));
}

/**
 * Two cart lines are "the same line" when they'd sell identically — same
 * product, same batch (so FIFO/price/expiry stay attached to the batch that
 * was actually resolved), same unit, same price, same discount. Scanning
 * the same barcode twice should grow one line, not create a second one that
 * client-side stock validation checks independently of the first (H1) — the
 * combination this mismatches on (e.g. a different discount) is kept as its
 * own line deliberately, since merging it would silently change what was
 * agreed for the earlier units.
 */
function sameLine(a: CartItem, b: CartItem): boolean {
  return a.product_id === b.product_id
    && a.batch_id === b.batch_id
    && a.unit_type === b.unit_type
    && a.unit_price === b.unit_price
    && a.discount_percent === b.discount_percent;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],

  addItem: (item) => {
    const items = get().items;
    const idx = items.findIndex((i) => sameLine(i, item));

    if (idx === -1) {
      set({ items: [...items, item] });
      return { quantity: item.quantity, clamped: false };
    }

    // Merge: clamp the COMBINED quantity against remaining stock, not each
    // line independently — two lines of 10 each with only 10 in stock used
    // to both pass client-side validation and only fail at the very end,
    // from the server, with the cashier unable to tell which line was wrong.
    const existing = items[idx];
    const maxQty = existing.availableStock ?? item.availableStock ?? Infinity;
    const requested = existing.quantity + item.quantity;
    const merged = Math.min(requested, maxQty);

    const next = [...items];
    next[idx] = { ...existing, quantity: merged, availableStock: maxQty === Infinity ? undefined : maxQty };
    set({ items: next });

    return {
      quantity: merged,
      clamped: merged < requested,
      maxAvailable: maxQty === Infinity ? undefined : maxQty,
    };
  },

  removeItem: (index) => {
    const items = [...get().items];
    items.splice(index, 1);
    set({ items });
  },

  updateQuantity: (index, qty) => {
    const items = get().items;
    const item = items[index];
    if (!item) return { quantity: 0, clamped: false, rejected: true };

    // H2: previously returned silently on invalid input, so the field
    // appeared frozen with no explanation. Reject explicitly instead —
    // the cart is left unchanged, and the caller can show why.
    if (!Number.isInteger(qty) || qty < 1) {
      return { quantity: item.quantity, clamped: false, rejected: true };
    }

    const maxQty = item.availableStock ?? Infinity;
    const clampedQty = Math.min(qty, maxQty);
    const next = [...items];
    next[index] = { ...item, quantity: clampedQty };
    set({ items: next });

    return {
      quantity: clampedQty,
      clamped: clampedQty < qty,
      maxAvailable: maxQty === Infinity ? undefined : maxQty,
    };
  },

  updateDiscount: (index, discount) => {
    const clamped = Math.min(100, Math.max(0, discount));
    const items = [...get().items];
    if (items[index]) items[index] = { ...items[index], discount_percent: clamped };
    set({ items });
  },

  clear: () => set({ items: [] }),

  getSubtotal: () => get().items.reduce((s, i) => s + lineGross(i), 0),

  getDiscountTotal: () => get().items.reduce((s, i) => s + lineDiscount(i), 0),

  getTotal: () => get().items.reduce((s, i) => s + calcLineTotal(i), 0),

  getItemCount: () => get().items.length,
}));
