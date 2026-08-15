import { translateSqlError } from '@core/common/sql-errors';
import { ValidationError, ConflictError, NotFoundError } from '@core/types/errors';

describe('translateSqlError', () => {
  describe('UNIQUE constraint violations', () => {
    it('maps the product-name index to a ValidationError on "name"', () => {
      const err = translateSqlError(
        new Error("UNIQUE constraint failed: index 'idx_products_name_unique'")
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('name');
      expect((err as ValidationError).message).toMatch(/product with this name already exists/i);
    });

    it('maps the batch-number index to a ValidationError on "batch_number"', () => {
      const err = translateSqlError(
        new Error("UNIQUE constraint failed: index 'idx_batches_product_batch'")
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('batch_number');
    });

    it('maps a column-level constraint (users.username) to a ValidationError', () => {
      const err = translateSqlError(new Error('UNIQUE constraint failed: users.username'));
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('username');
    });

    // "categories.name" is a substring of "expense_categories.name", so rule
    // order matters — the more specific one has to win.
    it('does not mistake expense_categories.name for categories.name', () => {
      const err = translateSqlError(
        new Error('UNIQUE constraint failed: expense_categories.name')
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/expense category/i);
    });

    it('maps categories.name to the category message', () => {
      const err = translateSqlError(new Error('UNIQUE constraint failed: categories.name'));
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/^A category with this name/i);
    });

    it('recognises the PostgreSQL wording too', () => {
      const err = translateSqlError(
        new Error('duplicate key value violates unique constraint "users.username"')
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('username');
    });

    // An unmapped duplicate is still a conflict, not a 500 — the whole point
    // of H7 is that it must not reach the generic "unexpected error" handler.
    it('falls back to ConflictError for an unmapped unique violation', () => {
      const err = translateSqlError(
        new Error("UNIQUE constraint failed: index 'idx_something_new'")
      );
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).not.toBeInstanceOf(ValidationError);
    });
  });

  describe('pass-through', () => {
    it('returns non-constraint errors unchanged', () => {
      const original = new Error('database is locked');
      expect(translateSqlError(original)).toBe(original);
    });

    it('returns existing AppErrors unchanged', () => {
      const original = new NotFoundError('Product', 5);
      expect(translateSqlError(original)).toBe(original);
    });

    it('handles non-Error values without throwing', () => {
      expect(translateSqlError('some string')).toBe('some string');
      expect(translateSqlError(undefined)).toBeUndefined();
      expect(translateSqlError(null)).toBeNull();
    });
  });
});
