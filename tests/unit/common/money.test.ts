import { Money } from '@core/common/money';

describe('Money', () => {
  // ─── toMinor (identity for SDG — no minor units) ────────────────────────────
  describe('toMinor', () => {
    it('returns the same whole number', () => {
      expect(Money.toMinor(10)).toBe(10);
    });
    it('rounds a decimal to nearest integer', () => {
      expect(Money.toMinor(10.50)).toBe(11);
    });
    it('rounds a string number', () => {
      expect(Money.toMinor('25')).toBe(25);
    });
    it('returns 0 for NaN input', () => {
      expect(Money.toMinor(NaN)).toBe(0);
    });
    it('returns 0 for non-numeric string', () => {
      expect(Money.toMinor('abc')).toBe(0);
    });
    it('handles zero', () => {
      expect(Money.toMinor(0)).toBe(0);
    });
    it('handles negative values', () => {
      expect(Money.toMinor(-5)).toBe(-5);
    });
    it('handles very large values', () => {
      expect(Money.toMinor(999999)).toBe(999999);
    });
  });

  // ─── fromMinor (identity for SDG — no minor units) ─────────────────────────
  describe('fromMinor', () => {
    it('returns the same value', () => {
      expect(Money.fromMinor(1050)).toBe(1050);
    });
    it('handles zero', () => {
      expect(Money.fromMinor(0)).toBe(0);
    });
    it('handles negative', () => {
      expect(Money.fromMinor(-525)).toBe(-525);
    });
  });

  // ─── format ─────────────────────────────────────────────────────────────────
  describe('format', () => {
    it('formats with default currency (no decimals)', () => {
      const result = Money.format(1050);
      expect(result).toContain('1,050');
      expect(result).toContain('SDG');
    });
    it('formats zero', () => {
      const result = Money.format(0);
      expect(result).toContain('0');
      expect(result).toContain('SDG');
    });
    it('formats negative', () => {
      const result = Money.format(-525);
      expect(result).toContain('525');
      expect(result).toContain('SDG');
    });
    it('does not include decimals', () => {
      const result = Money.format(500);
      expect(result).not.toContain('.00');
    });
  });

  // ─── add / subtract ────────────────────────────────────────────────────────
  describe('add', () => {
    it('adds two values', () => {
      expect(Money.add(1050, 250)).toBe(1300);
    });
    it('adds to zero', () => {
      expect(Money.add(0, 500)).toBe(500);
    });
    it('adds negatives', () => {
      expect(Money.add(-100, 200)).toBe(100);
    });
  });

  describe('subtract', () => {
    it('subtracts correctly', () => {
      expect(Money.subtract(1050, 250)).toBe(800);
    });
    it('produces negative', () => {
      expect(Money.subtract(100, 300)).toBe(-200);
    });
  });

  // ─── multiply ───────────────────────────────────────────────────────────────
  describe('multiply', () => {
    it('multiplies price by integer quantity', () => {
      expect(Money.multiply(500, 3)).toBe(1500);
    });
    it('multiplies price by 0', () => {
      expect(Money.multiply(500, 0)).toBe(0);
    });
    it('multiplies price by fractional quantity', () => {
      expect(Money.multiply(1000, 1.5)).toBe(1500);
    });
    it('rounds result to integer', () => {
      const result = Money.multiply(333, 3);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  // ─── percent ────────────────────────────────────────────────────────────────
  describe('percent', () => {
    it('calculates 100%', () => {
      expect(Money.percent(1000, 100)).toBe(1000);
    });
    it('calculates 50%', () => {
      expect(Money.percent(1000, 50)).toBe(500);
    });
    it('calculates 0%', () => {
      expect(Money.percent(1000, 0)).toBe(0);
    });
    it('calculates with decimal percent (33.33%)', () => {
      const result = Money.percent(1000, 33.33);
      expect(result).toBe(333);
    });
    it('returns integer', () => {
      const result = Money.percent(1001, 50);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  // ─── round ──────────────────────────────────────────────────────────────────
  describe('round', () => {
    it('rounds down', () => {
      expect(Money.round(10.3)).toBe(10);
    });
    it('rounds up', () => {
      expect(Money.round(10.7)).toBe(11);
    });
    it('rounds 0.5 up (Math.round)', () => {
      expect(Money.round(10.5)).toBe(11);
    });
    it('handles already-integer', () => {
      expect(Money.round(42)).toBe(42);
    });
  });

  // ─── markup ─────────────────────────────────────────────────────────────────
  describe('markup', () => {
    it('applies 100% markup', () => {
      expect(Money.markup(1000, 100)).toBe(2000);
    });
    it('applies 50% markup', () => {
      expect(Money.markup(1000, 50)).toBe(1500);
    });
    it('applies 0% markup', () => {
      expect(Money.markup(1000, 0)).toBe(1000);
    });
    it('returns integer', () => {
      const result = Money.markup(999, 33);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  // ─── divide ────────────────────────────────────────────────────────────────
  describe('divide', () => {
    it('rounds by default', () => {
      expect(Money.divide(1000, 3)).toBe(333);
    });
    it('floors when mode=floor', () => {
      expect(Money.divide(1000, 3, 'floor')).toBe(333);
    });
    it('ceils when mode=ceil', () => {
      expect(Money.divide(1000, 3, 'ceil')).toBe(334);
    });
    it('rounds when mode=round', () => {
      expect(Money.divide(750, 2, 'round')).toBe(375);
    });
    it('handles divisor of 0 (defaults to 1)', () => {
      expect(Money.divide(1000, 0)).toBe(1000);
    });
    it('divides evenly', () => {
      expect(Money.divide(1000, 5)).toBe(200);
    });
  });

  // ─── divideToChild ──────────────────────────────────────────────────────────
  describe('divideToChild', () => {
    it('divides evenly', () => {
      expect(Money.divideToChild(1000, 10)).toBe(100);
    });
    it('floors on uneven division (prevents ghost inventory)', () => {
      const result = Money.divideToChild(1000, 3);
      // FLOOR: 1000 / 3 = 333.33… → 333
      expect(result).toBe(333);
    });
    it('handles cf=1', () => {
      expect(Money.divideToChild(500, 1)).toBe(500);
    });
    it('prevents divide by zero', () => {
      expect(() => Money.divideToChild(1000, 0)).not.toThrow();
    });
  });

  // ─── denominationBreakdown ──────────────────────────────────────────────────
  describe('denominationBreakdown', () => {
    it('breaks down exact denomination amount', () => {
      const { notes, remainder } = Money.denominationBreakdown(2000);
      expect(notes[2000]).toBe(1);
      expect(remainder).toBe(0);
    });
    it('breaks down mixed denomination amount', () => {
      const { notes, remainder } = Money.denominationBreakdown(1700);
      expect(notes[1000]).toBe(1);
      expect(notes[500]).toBe(1);
      expect(notes[200]).toBe(1);
      expect(remainder).toBe(0);
    });
    it('reports remainder for amounts below smallest denomination', () => {
      const { remainder } = Money.denominationBreakdown(50);
      expect(remainder).toBe(50);
    });
    it('handles zero', () => {
      const { notes, remainder } = Money.denominationBreakdown(0);
      expect(Object.keys(notes).length).toBe(0);
      expect(remainder).toBe(0);
    });
  });

  // ─── DENOMINATIONS constant ─────────────────────────────────────────────────
  describe('DENOMINATIONS', () => {
    it('lists SDG denominations', () => {
      expect(Money.DENOMINATIONS).toEqual([100, 200, 500, 1000, 2000]);
    });
  });
});
