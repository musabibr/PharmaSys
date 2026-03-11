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

function calcLineTotal(item: CartItem): number {
  const gross = item.unit_price * item.quantity;
  const discount = Math.floor(gross * item.discount_percent / 100);
  return gross - discount;
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
    if (items[index]) items[index] = { ...items[index], quantity: qty };
    set({ items });
  },

  updateDiscount: (index, discount) => {
    const items = [...get().items];
    if (items[index]) items[index] = { ...items[index], discount_percent: discount };
    set({ items });
  },

  setExtraDiscount: (amount) => set({ extraDiscount: amount }),

  clear: () => set({ items: [], extraDiscount: 0 }),

  getSubtotal: () => get().items.reduce((s, i) => s + i.unit_price * i.quantity, 0),

  getDiscountTotal: () => {
    const lineDiscounts = get().items.reduce((s, i) => {
      const gross = i.unit_price * i.quantity;
      return s + Math.floor(gross * i.discount_percent / 100);
    }, 0);
    return lineDiscounts + get().extraDiscount;
  },

  getTotal: () => {
    const lineTotal = get().items.reduce((s, i) => s + calcLineTotal(i), 0);
    return Math.max(0, lineTotal - get().extraDiscount);
  },

  getItemCount: () => get().items.length,
}));
