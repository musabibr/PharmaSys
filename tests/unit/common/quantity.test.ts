import { Quantity } from '@core/common/quantity';

describe('Quantity', () => {
  // ─── baseToParent ───────────────────────────────────────────────────────────
  describe('baseToParent', () => {
    it('converts base to parent units (cf=10)', () => {
      expect(Quantity.baseToParent(30, 10)).toBe(3);
    });
    it('handles non-even division', () => {
      expect(Quantity.baseToParent(25, 10)).toBe(2.5);
    });
    it('handles cf=1', () => {
      expect(Quantity.baseToParent(5, 1)).toBe(5);
    });
    it('handles zero', () => {
      expect(Quantity.baseToParent(0, 10)).toBe(0);
    });
  });

  // ─── toBase ─────────────────────────────────────────────────────────────────
  describe('toBase', () => {
    it('converts parent to base (cf=10)', () => {
      expect(Quantity.toBase(3, 'parent', 10)).toBe(30);
    });
    it('child stays as base', () => {
      expect(Quantity.toBase(5, 'child', 10)).toBe(5);
    });
    it('converts parent with cf=1 (no children)', () => {
      expect(Quantity.toBase(5, 'parent', 1)).toBe(5);
    });
    it('handles zero', () => {
      expect(Quantity.toBase(0, 'parent', 10)).toBe(0);
    });
  });

  // ─── format ─────────────────────────────────────────────────────────────────
  describe('format', () => {
    it('formats parent mode', () => {
      const result = Quantity.format(3, 'Box', 'Tablet', 10, 'parent');
      expect(result).toContain('3');
      expect(result).toContain('Box');
    });
    it('formats child mode', () => {
      const result = Quantity.format(3, 'Box', 'Tablet', 10, 'child');
      expect(result).toContain('Tablet');
    });
    it('formats both mode', () => {
      const result = Quantity.format(3, 'Box', 'Tablet', 10, 'both');
      expect(result).toContain('Box');
    });
    it('handles single unit (no child)', () => {
      const result = Quantity.format(5, 'Piece');
      expect(result).toContain('5');
    });
    it('handles zero quantity', () => {
      const result = Quantity.format(0, 'Box', 'Tab', 10);
      expect(result).toContain('0');
    });
  });
});
