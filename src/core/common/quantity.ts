/**
 * Quantity formatter for displaying stock levels.
 * Works with INTEGER quantities only (base units).
 */
export const Quantity = {
  /** Simple English pluralization */
  _pluralize(qty: number, unit: string): string {
    if (qty === 1) return unit;
    if (
      unit.endsWith('ml') || unit.endsWith('mm') ||
      unit.endsWith('cm') || unit.endsWith('gram') || unit.endsWith('liter')
    ) {
      return unit;
    }
    const lower = unit.toLowerCase();
    if (
      lower.endsWith('x') || lower.endsWith('s') ||
      lower.endsWith('sh') || lower.endsWith('ch') || lower.endsWith('z')
    ) {
      return unit + 'es';
    }
    if (lower.endsWith('y') && lower.length > 1) {
      const beforeY = lower[lower.length - 2];
      if (!'aeiou'.includes(beforeY)) {
        return unit.slice(0, -1) + 'ies';
      }
    }
    return unit + 's';
  },

  /**
   * Format a quantity for display.
   * @param quantityParent - Quantity in parent units (integer)
   * @param parentUnit     - Parent unit name (e.g. "Box")
   * @param childUnit      - Child unit name (e.g. "Strip")
   * @param conversionFactor - How many children per parent
   * @param mode           - 'parent' | 'child' | 'both'
   */
  format(
    quantityParent: number,
    parentUnit = 'Unit',
    childUnit = 'Unit',
    conversionFactor = 1,
    mode: 'parent' | 'child' | 'both' = 'parent'
  ): string {
    const qty = Math.round(Number(quantityParent) || 0);
    const cf = Math.max(1, Math.round(Number(conversionFactor) || 1));

    if (mode === 'child' && cf > 1) {
      const totalChild = qty * cf;
      return `${totalChild} ${this._pluralize(totalChild, childUnit)}`;
    }

    if (mode === 'both' && cf > 1) {
      const totalChild = qty * cf;
      return `${qty} ${this._pluralize(qty, parentUnit)} (${totalChild} ${this._pluralize(totalChild, childUnit)})`;
    }

    // Default: parent mode
    return `${qty} ${this._pluralize(qty, parentUnit)}`;
  },

  /** Convert base (child) quantity to parent units (may be fractional) */
  baseToParent(quantityBase: number, conversionFactor: number): number {
    const cf = Math.max(1, conversionFactor);
    return quantityBase / cf;
  },

  /** Convert display quantity (parent or child) to base quantity */
  toBase(quantity: number, unitType: 'parent' | 'child', conversionFactor: number): number {
    if (unitType === 'parent') {
      return Math.round(quantity * Math.max(1, conversionFactor));
    }
    return Math.round(quantity);
  },
} as const;
