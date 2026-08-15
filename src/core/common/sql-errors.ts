/**
 * SQLite constraint-error translation (audit finding H7).
 *
 * A UNIQUE-constraint violation is a *user* error — "that product name is
 * already taken" — but SQLite reports it as a generic Error whose message is
 * an internal index name. Those fall through every AppError check in
 * `toIpcError`/`expressErrorHandler` and, in a packaged build (NODE_ENV=
 * production), get replaced with an untranslated "An unexpected error
 * occurred" with nothing the user can act on. Renaming a product onto an
 * existing name is the common way to hit this.
 *
 * Mapping them to `ValidationError` here — with the offending field — means
 * they reach the UI as a normal, translatable field error on both transports,
 * instead of depending on the generic handler leaking a raw message in dev
 * and hiding it entirely in production.
 *
 * `BatchService.create` already did this inline for the batch-number index;
 * this generalises that approach so every constraint gets the same treatment.
 */

import { ValidationError, ConflictError } from '../types/errors';

/** index/constraint fragment → the ValidationError it should surface as. */
interface ConstraintRule {
  /** Matched case-insensitively against the driver's error message. */
  match: string;
  field: string;
  message: string;
}

/**
 * Only constraints that actually exist in the schema are listed — a rule for
 * a column that isn't UNIQUE (e.g. products.barcode, suppliers.name, both of
 * which are plain columns with non-unique indexes) would be dead code that
 * reads as a guarantee the database doesn't make.
 *
 * SQLite reports column-level constraints as "UNIQUE constraint failed:
 * users.username" and index-level ones as "…: index 'idx_products_name_unique'",
 * so both forms are matched as substrings.
 */
const CONSTRAINT_RULES: ConstraintRule[] = [
  {
    match: 'idx_products_name_unique',
    field: 'name',
    message: 'A product with this name already exists. Use a different name, or edit the existing product.',
  },
  {
    match: 'idx_batches_product_batch',
    field: 'batch_number',
    message: 'This batch number already exists for this product.',
  },
  {
    match: 'users.username',
    field: 'username',
    message: 'This username is already taken.',
  },
  {
    match: 'expense_categories.name',
    field: 'name',
    message: 'An expense category with this name already exists.',
  },
  {
    // Must come after expense_categories.name — "categories.name" is a
    // substring of it, so the more specific rule has to match first.
    match: 'categories.name',
    field: 'name',
    message: 'A category with this name already exists.',
  },
];

/** True when the driver reported a UNIQUE-constraint violation. */
function isUniqueViolation(message: string): boolean {
  const m = message.toLowerCase();
  // better-sqlite3: "UNIQUE constraint failed: …"
  // pg:            "duplicate key value violates unique constraint …"
  return m.includes('unique constraint failed') || m.includes('duplicate key value');
}

/**
 * Translate a driver error into a domain error, or return it unchanged.
 *
 * Call this in a service's `catch` before rethrowing, so the transport layer
 * receives a typed error it already knows how to serialise:
 *
 *   try { await this.repo.create(data); }
 *   catch (err) { throw translateSqlError(err); }
 */
export function translateSqlError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message || !isUniqueViolation(message)) return err;

  const lower = message.toLowerCase();
  const rule = CONSTRAINT_RULES.find(r => lower.includes(r.match.toLowerCase()));
  if (rule) return new ValidationError(rule.message, rule.field);

  // A UNIQUE violation we have no specific copy for is still a duplicate,
  // not an "unexpected error" — surface it as a 409 rather than a 500 so the
  // client can tell a conflict from a genuine server fault.
  return new ConflictError('That value is already in use.');
}
