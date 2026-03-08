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
