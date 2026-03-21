import { Validate } from '@core/common/validation';
import { ValidationError } from '@core/types/errors';

describe('Validate', () => {
  // ─── requiredString ─────────────────────────────────────────────────────────
  describe('requiredString', () => {
    it('returns trimmed string', () => {
      expect(Validate.requiredString('  hello  ', 'name')).toBe('hello');
    });
    it('throws on empty string', () => {
      expect(() => Validate.requiredString('', 'name')).toThrow(ValidationError);
    });
    it('throws on whitespace-only string', () => {
      expect(() => Validate.requiredString('   ', 'name')).toThrow(ValidationError);
    });
    it('throws on null', () => {
      expect(() => Validate.requiredString(null, 'name')).toThrow(ValidationError);
    });
    it('throws on undefined', () => {
      expect(() => Validate.requiredString(undefined, 'name')).toThrow(ValidationError);
    });
    it('throws on number', () => {
      expect(() => Validate.requiredString(42, 'name')).toThrow(ValidationError);
    });
    it('enforces maxLen', () => {
      expect(() => Validate.requiredString('a'.repeat(201), 'name', 200)).toThrow(ValidationError);
    });
    it('allows string at maxLen', () => {
      expect(Validate.requiredString('a'.repeat(200), 'name', 200)).toHaveLength(200);
    });
    it('includes field name in error', () => {
      try { Validate.requiredString('', 'Username'); } catch (e: any) {
        expect(e.message).toContain('Username');
      }
    });
  });

  // ─── optionalString ─────────────────────────────────────────────────────────
  describe('optionalString', () => {
    it('returns trimmed string', () => {
      expect(Validate.optionalString('  hi  ', 'x')).toBe('hi');
    });
    it('returns null for empty string', () => {
      expect(Validate.optionalString('', 'x')).toBeNull();
    });
    it('returns null for null', () => {
      expect(Validate.optionalString(null, 'x')).toBeNull();
    });
    it('returns null for undefined', () => {
      expect(Validate.optionalString(undefined, 'x')).toBeNull();
    });
    it('enforces maxLen', () => {
      expect(() => Validate.optionalString('a'.repeat(300), 'x', 200)).toThrow(ValidationError);
    });
  });

  // ─── positiveNumber ─────────────────────────────────────────────────────────
  describe('positiveNumber', () => {
    it('returns positive number', () => {
      expect(Validate.positiveNumber(5, 'amt')).toBe(5);
    });
    it('returns positive decimal', () => {
      expect(Validate.positiveNumber(0.5, 'amt')).toBe(0.5);
    });
    it('throws on zero', () => {
      expect(() => Validate.positiveNumber(0, 'amt')).toThrow(ValidationError);
    });
    it('throws on negative', () => {
      expect(() => Validate.positiveNumber(-1, 'amt')).toThrow(ValidationError);
    });
    it('throws on NaN', () => {
      expect(() => Validate.positiveNumber(NaN, 'amt')).toThrow(ValidationError);
    });
    it('coerces valid numeric string', () => {
      expect(Validate.positiveNumber('5' as any, 'amt')).toBe(5);
    });
    it('throws on non-numeric string', () => {
      expect(() => Validate.positiveNumber('abc' as any, 'amt')).toThrow(ValidationError);
    });
    it('throws on Infinity', () => {
      expect(() => Validate.positiveNumber(Infinity, 'amt')).toThrow(ValidationError);
    });
  });

  // ─── nonNegativeNumber ──────────────────────────────────────────────────────
  describe('nonNegativeNumber', () => {
    it('returns zero', () => {
      expect(Validate.nonNegativeNumber(0, 'x')).toBe(0);
    });
    it('returns positive', () => {
      expect(Validate.nonNegativeNumber(10, 'x')).toBe(10);
    });
    it('throws on negative', () => {
      expect(() => Validate.nonNegativeNumber(-1, 'x')).toThrow(ValidationError);
    });
  });

  // ─── positiveInteger ────────────────────────────────────────────────────────
  describe('positiveInteger', () => {
    it('returns integer', () => {
      expect(Validate.positiveInteger(5, 'qty')).toBe(5);
    });
    it('throws on decimal', () => {
      expect(() => Validate.positiveInteger(1.5, 'qty')).toThrow(ValidationError);
    });
    it('throws on zero', () => {
      expect(() => Validate.positiveInteger(0, 'qty')).toThrow(ValidationError);
    });
    it('throws on negative', () => {
      expect(() => Validate.positiveInteger(-3, 'qty')).toThrow(ValidationError);
    });
  });

  // ─── id ─────────────────────────────────────────────────────────────────────
  describe('id', () => {
    it('returns valid id', () => {
      expect(Validate.id(1)).toBe(1);
    });
    it('throws on zero', () => {
      expect(() => Validate.id(0)).toThrow(ValidationError);
    });
    it('throws on decimal', () => {
      expect(() => Validate.id(1.5)).toThrow(ValidationError);
    });
    it('throws on null', () => {
      expect(() => Validate.id(null)).toThrow(ValidationError);
    });
    it('throws on string', () => {
      expect(() => Validate.id('1' as any)).toThrow(ValidationError);
    });
    it('uses custom field name', () => {
      try { Validate.id(0, 'Product'); } catch (e: any) {
        expect(e.message).toContain('Product');
      }
    });
  });

  // ─── dateString ─────────────────────────────────────────────────────────────
  describe('dateString', () => {
    it('accepts YYYY-MM-DD', () => {
      expect(Validate.dateString('2026-01-15', 'date')).toBe('2026-01-15');
    });
    it('throws on invalid format', () => {
      expect(() => Validate.dateString('15-01-2026', 'date')).toThrow(ValidationError);
    });
    it('throws on empty', () => {
      expect(() => Validate.dateString('', 'date')).toThrow(ValidationError);
    });
    it('throws on null', () => {
      expect(() => Validate.dateString(null, 'date')).toThrow(ValidationError);
    });
    it('throws on number', () => {
      expect(() => Validate.dateString(20260115, 'date')).toThrow(ValidationError);
    });
    it('throws on partial date', () => {
      expect(() => Validate.dateString('2026-01', 'date')).toThrow(ValidationError);
    });
  });

  // ─── enum ───────────────────────────────────────────────────────────────────
  describe('enum', () => {
    const ROLES = ['admin', 'pharmacist', 'cashier'] as const;

    it('accepts valid value', () => {
      expect(Validate.enum('admin', ROLES, 'role')).toBe('admin');
    });
    it('throws on invalid value', () => {
      expect(() => Validate.enum('manager', ROLES, 'role')).toThrow(ValidationError);
    });
    it('throws on null', () => {
      expect(() => Validate.enum(null, ROLES, 'role')).toThrow(ValidationError);
    });
    it('throws on empty string', () => {
      expect(() => Validate.enum('', ROLES, 'role')).toThrow(ValidationError);
    });
    it('error message lists allowed values', () => {
      try { Validate.enum('x', ROLES, 'role'); } catch (e: any) {
        expect(e.message).toContain('admin');
      }
    });
  });

  // ─── passwordString ────────────────────────────────────────────────────────
  describe('passwordString', () => {
    it('returns valid password', () => {
      expect(Validate.passwordString('mypassword', 'Password')).toBe('mypassword');
    });
    it('returns password at exactly 8 chars', () => {
      expect(Validate.passwordString('12345678', 'Password')).toBe('12345678');
    });
    it('throws on short password', () => {
      expect(() => Validate.passwordString('short', 'Password')).toThrow(ValidationError);
    });
    it('throws on empty string', () => {
      expect(() => Validate.passwordString('', 'Password')).toThrow(ValidationError);
    });
    it('throws on null', () => {
      expect(() => Validate.passwordString(null, 'Password')).toThrow(ValidationError);
    });
    it('throws on undefined', () => {
      expect(() => Validate.passwordString(undefined, 'Password')).toThrow(ValidationError);
    });
    it('throws on whitespace-only under 8 chars', () => {
      expect(() => Validate.passwordString('       ', 'Password')).toThrow(ValidationError);
    });
  });

  // ─── escapeLike ─────────────────────────────────────────────────────────────
  describe('escapeLike', () => {
    it('escapes %', () => {
      expect(Validate.escapeLike('50%')).toBe('50\\%');
    });
    it('escapes _', () => {
      expect(Validate.escapeLike('test_val')).toBe('test\\_val');
    });
    it('escapes backslash', () => {
      expect(Validate.escapeLike('a\\b')).toBe('a\\\\b');
    });
    it('leaves normal string unchanged', () => {
      expect(Validate.escapeLike('hello')).toBe('hello');
    });
    it('handles empty string', () => {
      expect(Validate.escapeLike('')).toBe('');
    });
    it('escapes multiple special chars', () => {
      expect(Validate.escapeLike('%_\\')).toBe('\\%\\_\\\\');
    });
  });
});
