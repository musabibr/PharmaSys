import { toIpcError } from '@transport/middleware/error-handler';
import { NotFoundError, ValidationError } from '@core/types/errors';

/**
 * H7: an untranslated UNIQUE-constraint violation used to fall through every
 * AppError check and become "An unexpected error occurred" (code
 * INTERNAL_ERROR, status 500) in a packaged build — no field, nothing the
 * user could act on. The transport layer is the last chance to catch one a
 * service didn't translate.
 */
describe('toIpcError', () => {
  const realEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = realEnv; });

  it('passes AppErrors through with their own status and code', () => {
    const res = toIpcError(new NotFoundError('Product', 7));
    expect(res.statusCode).toBe(404);
    expect(res.success).toBe(false);
  });

  it('reports a ValidationError as 400 with its field', () => {
    const res = toIpcError(new ValidationError('Bad name', 'name'));
    expect(res.statusCode).toBe(400);
    expect(res.field).toBe('name');
  });

  it('translates an unhandled UNIQUE violation into a 400 field error, not a 500', () => {
    const res = toIpcError(
      new Error("UNIQUE constraint failed: index 'idx_products_name_unique'")
    );
    expect(res.statusCode).toBe(400);
    expect(res.field).toBe('name');
    expect(res.code).not.toBe('INTERNAL_ERROR');
    expect(res.error).toMatch(/already exists/i);
  });

  it('keeps that translation in production, where the raw message is hidden', () => {
    process.env.NODE_ENV = 'production';
    const res = toIpcError(
      new Error("UNIQUE constraint failed: index 'idx_products_name_unique'")
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toMatch(/already exists/i);
    expect(res.error).not.toMatch(/unexpected error/i);
  });

  it('still hides genuinely unexpected errors in production', () => {
    process.env.NODE_ENV = 'production';
    const res = toIpcError(new Error('database is locked'));
    expect(res.statusCode).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
    expect(res.error).toBe('An unexpected error occurred');
  });
});
