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

interface CartState {
  items: CartItem[];
  extraDiscount: number;
  addItem: (item: CartItem) => void;
  removeItem: (index: number) => void;
  updateQuantity: (index: number, qty: number) => void;
  updateDiscount: (index: number, discount: number) => void;
  setExtraDiscount: (amount: number) => void;
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

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  extraDiscount: 0,

  addItem: (item) => set({ items: [...get().items, item] }),

  removeItem: (index) => {
    const items = [...get().items];
    items.splice(index, 1);
    set({ items });
  },

  updateQuantity: (index, qty) => {
    if (qty < 1 || !Number.isInteger(qty)) return;
    const items = [...get().items];
    if (!items[index]) return;
    const item = items[index];
    // Clamp to available stock if known (server-side is the ultimate guard)
    const maxQty = item.availableStock ?? Infinity;
    const clampedQty = Math.min(qty, maxQty);
    items[index] = { ...items[index], quantity: clampedQty };
    set({ items });
  },

  updateDiscount: (index, discount) => {
    const clamped = Math.min(100, Math.max(0, discount));
    const items = [...get().items];
    if (items[index]) items[index] = { ...items[index], discount_percent: clamped };
    set({ items });
  },

  setExtraDiscount: (amount) => set({ extraDiscount: amount }),

  clear: () => set({ items: [], extraDiscount: 0 }),

  getSubtotal: () => get().items.reduce((s, i) => s + lineGross(i), 0),

  getDiscountTotal: () => {
    const lineDiscounts = get().items.reduce((s, i) => s + lineDiscount(i), 0);
    return lineDiscounts + get().extraDiscount;
  },

  getTotal: () => {
    const lineTotal = get().items.reduce((s, i) => s + calcLineTotal(i), 0);
    return Math.max(0, lineTotal - get().extraDiscount);
  },

  getItemCount: () => get().items.length,
}));
