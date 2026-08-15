/**
 * Money helper — all amounts stored as INTEGER whole SDG.
 * SDG (Sudanese Pound) has no minor units (no piastres/cents).
 * Available denominations: 100, 200, 500, 1000, 2000 SDG.
 * NEVER use floating-point for money calculations.
 */
export const Money = {
  /** SDG denominations in circulation (ascending) */
  DENOMINATIONS: [100, 200, 500, 1000, 2000] as readonly number[],

  /** Convert display value → storage value (identity for SDG — no minor units) */
  toMinor(amount: number | string): number {
    return Math.round(Number(amount) || 0);
  },

  /** Convert storage value → display value (identity for SDG — no minor units) */
  fromMinor(minor: number): number {
    return Math.round(Number(minor) || 0);
  },

  /** Format for display with currency symbol */
  format(amount: number, currency = 'SDG'): string {
    const value = Math.round(Number(amount) || 0);
    return `${value.toLocaleString()} ${currency}`;
  },

  /** Integer addition (rounds inputs to nearest whole SDG — consistent with round()) */
  add(a: number, b: number): number {
    return (Math.round(Number(a)) || 0) + (Math.round(Number(b)) || 0);
  },

  /** Integer subtraction (rounds inputs to nearest whole SDG — consistent with round()) */
  subtract(a: number, b: number): number {
    return (Math.round(Number(a)) || 0) - (Math.round(Number(b)) || 0);
  },

  /**
   * Multiply amount by a quantity (integer or fractional).
   * Result is rounded to the nearest whole SDG.
   */
  multiply(amount: number, qty: number): number {
    const m = Math.trunc(Number(amount)) || 0;
    const q = Number(qty) || 0;
    return Math.round(m * q);
  },

  /** Calculate percentage of an amount using integer math (floor) */
  percent(amount: number, percentage: number): number {
    const m = Math.trunc(Number(amount)) || 0;
    const p = Number(percentage) || 0;
    return Math.floor((m * p) / 100);
  },

  /** Round to nearest whole SDG (ensures integer type) */
  round(value: number): number {
    return Math.round(Number(value) || 0);
  },

  /**
   * Apply markup percentage: cost × (1 + markup/100).
   * Example: 750 SDG at 20% markup = 900 SDG.
   */
  markup(cost: number, markupPercent: number): number {
    const c = Math.trunc(Number(cost)) || 0;
    const pct = Number(markupPercent) || 0;
    return Math.round((c * (100 + pct)) / 100);
  },

  /**
   * Divide an SDG amount by a divisor with configurable rounding.
   * Default: 'round' (nearest whole SDG).
   * Use 'floor' for child price splitting (prevents ghost inventory).
   */
  divide(
    amount: number,
    divisor: number,
    mode: 'ceil' | 'round' | 'floor' = 'round'
  ): number {
    const d = Math.trunc(Number(divisor)) || 1;
    const result = Math.trunc(Number(amount)) / d;
    return mode === 'ceil' ? Math.ceil(result)
         : mode === 'floor' ? Math.floor(result)
         : Math.round(result);
  },

  /**
   * Divide parent price by child count using FLOOR division.
   *
   * CRITICAL: Must use floor (not ceil or round) to prevent "Ghost Inventory" —
   * where child unit prices sum to MORE than the parent price.
   *
   * Example: 1 box at 751 SDG containing 10 strips:
   *   ceil(751/10) = 76 per strip -> 76 x 10 = 760 > 751 (ghost inventory!)
   *   floor(751/10) = 75 per strip -> 75 x 10 = 750 <= 751 (correct)
   *
   * The remainder is absorbed at the parent level.
   */
  divideToChild(parentPrice: number, childCount: number): number {
    const parent = Math.trunc(Number(parentPrice)) || 0;
    const count = Math.trunc(Number(childCount)) || 1;
    if (count <= 0) return parent;
    return Math.floor(parent / count);
  },

  /**
   * COST prices are the ONLY monetary values allowed to be fractional
   * (up to 3 decimal places). Selling prices, totals, and cash remain whole SDG.
   * Real-world purchases often have fractional per-unit costs (e.g. a box cost
   * split across many units), and forcing them to integers loses money.
   */
  COST_DECIMALS: 3,

  /** Round a COST value to 3 decimal places (e.g. roundCost(12.3456) → 12.346). */
  roundCost(value: number | string): number {
    const n = Number(value) || 0;
    return Math.round(n * 1000) / 1000;
  },

  /**
   * Per-child COST from a (possibly fractional) parent cost.
   * Floored to 3 dp so child costs never sum above the parent — the cost
   * counterpart of divideToChild (which is integer-only for selling prices).
   */
  costPerChild(parentCost: number, childCount: number): number {
    const parent = Number(parentCost) || 0;
    const count = Math.trunc(Number(childCount)) || 1;
    if (count <= 0) return Math.round(parent * 1000) / 1000;
    return Math.floor((parent / count) * 1000) / 1000;
  },

  /**
   * Round an amount to the nearest available SDG denomination.
   * Useful for cash change calculation.
   * Example: roundToDenomination(350) → 200 + 100 + (50 remainder)
   */
  denominationBreakdown(amount: number): { notes: Record<number, number>; remainder: number } {
    let remaining = Math.abs(Math.round(Number(amount) || 0));
    const notes: Record<number, number> = {};
    const denoms = [...Money.DENOMINATIONS].reverse(); // largest first
    for (const d of denoms) {
      if (remaining >= d) {
        notes[d] = Math.floor(remaining / d);
        remaining = remaining % d;
      }
    }
    return { notes, remainder: remaining };
  },
} as const;

export type MoneyHelper = typeof Money;
