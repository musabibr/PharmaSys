import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind class names (Shadcn/ui convention) */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a money amount as whole SDG with thousands separator */
export function formatCurrency(amount: number | null | undefined, symbol = 'SDG'): string {
  const value = Math.round(Number(amount) || 0);
  return `${value.toLocaleString()} ${symbol}`;
}

/**
 * Parse a user-entered COST into a number rounded to 3 decimal places.
 * Cost is the only monetary value allowed to be fractional (SDG has no coins,
 * but per-unit purchase cost needs precision). Use this instead of
 * `Math.round(Number(...))` for cost inputs.
 */
export function parseCost(value: string | number | null | undefined): number {
  const n = parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

/**
 * Format a (possibly fractional) COST with up to 3 decimals + currency symbol.
 * Trailing zeros are trimmed (12.5 → "12.5 SDG", 12 → "12 SDG").
 */
export function formatCost(amount: number | null | undefined, symbol = 'SDG'): string {
  const n = Math.round((Number(amount) || 0) * 1000) / 1000;
  const value = n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return `${value} ${symbol}`;
}

// ── Expiry (entered/shown as MM/YY, stored as end-of-month ISO) ──────────────
/** Far-future sentinel meaning "never expires". Mirrors core/common/expiry.ts. */
export const NO_EXPIRY_SENTINEL = '2099-12-31';

/** True when an expiry ISO date means "no expiry" (blank or far future). */
export function isNoExpiry(iso: string | null | undefined): boolean {
  if (!iso) return true;
  return iso >= '2099-01-01';
}

/** Format a stored ISO expiry as MM/YY for display ('' when no expiry). */
export function formatExpiryMMYY(iso: string | null | undefined): string {
  if (isNoExpiry(iso)) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  if (!m) return String(iso ?? '');
  return `${m[2]}/${m[1].slice(2)}`;
}

/**
 * Parse a user-entered expiry (MM/YY, MM/YYYY, YYYY-MM, YYYY-MM-DD) to an
 * end-of-month ISO date. Returns '' when blank or not yet a complete value.
 */
export function parseExpiryToISO(input: string | null | undefined): string {
  if (!input) return '';
  const s = String(input).trim();
  if (!s) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const eom = (y: number, mo: number) => `${y}-${pad(mo)}-${pad(new Date(y, mo, 0).getDate())}`;
  let m = s.match(/^(\d{1,2})[/.\-](\d{2}|\d{4})$/);        // MM/YY or MM/YYYY
  if (m) { const mo = +m[1]; let y = +m[2]; if (y < 100) y += 2000; return mo >= 1 && mo <= 12 ? eom(y, mo) : ''; }
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);                    // YYYY-MM
  if (m) { const mo = +m[2]; return mo >= 1 && mo <= 12 ? eom(+m[1], mo) : ''; }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);              // YYYY-MM-DD → snap EOM
  if (m) { const mo = +m[2]; return mo >= 1 && mo <= 12 ? eom(+m[1], mo) : ''; }
  return '';
}

/** Format ISO date string (YYYY-MM-DD) as DD-MM-YYYY for display */
export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const [y, m, d] = isoString.split('-');
  if (!y || !m || !d) return isoString;
  return `${d}-${m}-${y}`;
}

/** Show invoice_reference if available, otherwise fall back to purchase_number */
export function displayInvoiceId(purchase: { invoice_reference?: string | null; purchase_number: string }): string {
  return purchase.invoice_reference?.trim() || purchase.purchase_number;
}

/**
 * Translate a stored unit name (e.g. "Box", "strip") for display.
 * Units are free-text user data, so this only maps the common names that have
 * translations (case-insensitively); unknown units pass through unchanged.
 */
export function unitLabel(
  unit: string | null | undefined,
  t: (key: string) => string,
  fallback = '',
): string {
  const u = (unit ?? '').trim();
  if (!u) return fallback;
  const norm = u.charAt(0).toUpperCase() + u.slice(1).toLowerCase();
  const translated = t(norm);
  return translated === norm ? u : translated;
}

/** Format base quantity into parent + child units */
export function formatQuantity(
  quantityBase: number,
  parentUnit: string,
  childUnit: string,
  conversionFactor: number
): string {
  const cf = conversionFactor || 1;
  if (cf <= 1) return `${quantityBase} ${parentUnit}`;

  const parents = Math.floor(quantityBase / cf);
  const children = quantityBase % cf;
  const parts: string[] = [];
  if (parents > 0) parts.push(`${parents} ${parentUnit}`);
  if (children > 0) parts.push(`${children} ${childUnit}`);
  return parts.length > 0 ? parts.join(' + ') : '0';
}
