/**
 * Calendar-date helpers shared by the server and the React renderer.
 *
 * Storage rule for business date columns: canonical ISO `YYYY-MM-DD`, zero
 * padded and calendar-valid.
 *
 * Pure module: no Node or DOM APIs, so the renderer can import it.
 */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Arabic-Indic and Persian digits (٠-٩, ۰-۹) as ASCII digits. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * True for a canonical, calendar-valid ISO date (YYYY-MM-DD, zero-padded):
 * rejects "2027-2-11", "2028-02-30" and "202-04-30" alike.
 */
export function isCanonicalISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Day-first (DD/MM/YYYY, the regional default) or month-first reading of `a/b/yyyy`. */
export type DateOrder = 'dmy' | 'mdy';

export type DateParseResult =
  | { ok: true; iso: string }
  | { ok: false; reason: 'empty' | 'format' | 'calendar' };

/** Build a canonical ISO date, or null if the parts are not a real calendar day. */
export function isoFromParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2199) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return isCanonicalISODate(iso) ? iso : null;
}

/**
 * Parse a calendar date typed by a person or read from an import.
 *
 * Accepts (separators `/`, `-`, `.`; spaces ignored; Arabic-Indic digits ok):
 *   YYYY-MM-DD · YYYY-M-D · DD/MM/YYYY (or MM/DD/YYYY with order 'mdy') ·
 *   DD/MM/YY (two-digit years are 2000–2099).
 * Anchored: trailing text is rejected, never half-read.
 */
export function parseCalendarDate(input: unknown, order: DateOrder = 'dmy'): DateParseResult {
  if (input == null) return { ok: false, reason: 'empty' };
  const s = toAsciiDigits(String(input)).replace(/\s+/g, '');
  if (!s) return { ok: false, reason: 'empty' };

  let m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (m) {
    const iso = isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { ok: true, iso } : { ok: false, reason: 'calendar' };
  }

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [day, month] = order === 'dmy' ? [a, b] : [b, a];
    const iso = isoFromParts(year, month, day);
    return iso ? { ok: true, iso } : { ok: false, reason: 'calendar' };
  }

  return { ok: false, reason: 'format' };
}

/**
 * Decide the day/month order for a whole column of imported dates at once.
 * If any value can only be read day-first (first part > 12) the column is
 * day-first; if any can only be read month-first, month-first. Otherwise the
 * `fallback` (a supplier's remembered format, or the regional default) wins.
 * Reading each cell independently can mix both orders within one invoice.
 */
export function inferDateOrder(values: readonly unknown[], fallback: DateOrder = 'dmy'): DateOrder {
  let dayFirst = false;
  let monthFirst = false;
  for (const v of values) {
    if (v == null) continue;
    const m = toAsciiDigits(String(v)).replace(/\s+/g, '').match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return 'dmy';
  if (monthFirst && !dayFirst) return 'mdy';
  return fallback;
}

/** Local-time calendar date for a JS Date as canonical ISO (never UTC). */
export function toLocalISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Add whole days to a canonical ISO date (calendar arithmetic, DST-safe). */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Whole days from `from` to `to` (both canonical ISO); negative if `to` is earlier. */
export function daysBetweenISO(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}
