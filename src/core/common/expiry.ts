/**
 * Expiry-date helpers.
 *
 * Expiry is entered and displayed as MM/YY (e.g. "06/28" = June 2028), but
 * STORED as a full ISO date (YYYY-MM-DD) so SQLite date() comparisons and FIFO
 * ordering keep working. The stored day is always the LAST day of the month
 * (a batch marked 06/28 is usable through 30 Jun 2028).
 *
 * "No expiry" (for products flagged as not requiring an expiry) is represented
 * by a far-future sentinel date so the batches.expiry_date NOT NULL column and
 * all date comparisons keep working without a schema rebuild — such batches
 * never expire and sort last in FIFO.
 */

/** Far-future sentinel meaning "never expires". */
export const NO_EXPIRY_SENTINEL = '2099-12-31';

/**
 * SQL fragment for "today" when comparing against expiry_date.
 *
 * SQLite's date('now') is always UTC, but every timestamp in this schema is
 * stored with datetime('now','localtime') (29 uses in migration.repository.ts).
 * Sudan is UTC+2, so between 00:00 and 02:00 local the UTC date is still
 * yesterday — a batch expiring "today" could be sellable in one query and
 * rejected by another depending on which clock it used (audit finding F4).
 * Use this constant everywhere expiry is compared so the two clocks can't
 * drift apart again.
 */
export const TODAY_SQL = "date('now','localtime')";

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Local-time "today" as YYYY-MM-DD — the JS-side counterpart of TODAY_SQL.
 * `new Date().toISOString().slice(0, 10)` is UTC and drifts from this by a
 * day during the same 00:00–02:00 window; always use this instead when
 * comparing against a stored expiry_date.
 */
export function todayLocalISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
}

/** Last day (28–31) of a given 1-based month. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** True when an ISO date represents "no expiry" (empty or the sentinel/far future). */
export function isNoExpiry(iso: string | null | undefined): boolean {
  if (!iso) return true;
  return iso >= '2099-01-01';
}

/**
 * Normalize any accepted expiry input to an end-of-month ISO date (YYYY-MM-DD).
 * Accepts: MM/YY, MM/YYYY, YYYY-MM, YYYY-MM-DD, or a Date. Returns '' if the
 * input is blank or cannot be parsed (caller decides whether to treat '' as
 * "no expiry" → NO_EXPIRY_SENTINEL).
 */
export function normalizeExpiry(input: string | Date | null | undefined): string {
  if (input == null) return '';
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return '';
    return endOfMonthISO(input.getFullYear(), input.getMonth() + 1);
  }
  const s = String(input).trim();
  if (!s) return '';

  // MM/YY or MM/YYYY  (also tolerates '-' or '.' separators)
  let m = s.match(/^(\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    let year = Number(m[2]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12) return '';
    return endOfMonthISO(year, month);
  }
  // YYYY-MM
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return '';
    return endOfMonthISO(year, month);
  }
  // YYYY-MM-DD (snap to end of month)
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return '';
    return endOfMonthISO(year, month);
  }
  return '';
}

/** End-of-month ISO date for a 1-based month. */
export function endOfMonthISO(year: number, month: number): string {
  return `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
}

/** Format a stored ISO date as MM/YY for display. Returns '' for no-expiry. */
export function formatExpiryMMYY(iso: string | null | undefined): string {
  if (isNoExpiry(iso)) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  if (!m) return String(iso ?? '');
  return `${m[2]}/${m[1].slice(2)}`;
}
