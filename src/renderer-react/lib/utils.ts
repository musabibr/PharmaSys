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
