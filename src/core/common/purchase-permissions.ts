import { resolvePermissions, hasPermission } from './permissions';
import { PermissionError } from '../types/errors';

/** The user fields the check reads (UserPublic has them all). */
type CheckedUser = Parameters<typeof resolvePermissions>[0] & { role: string };

/**
 * Giving a matched product the invoice's units (Match step) edits the
 * product, so it needs the same permission as editing it in Inventory.
 * Purchases without such lines need nothing more than their own permission.
 */
export function assertProductUnitsAllowed(user: CheckedUser, items: unknown): void {
  if (!Array.isArray(items)) return;
  const changesUnits = items.some(i => !!i && typeof i === 'object' && !!(i as { product_units?: unknown }).product_units);
  if (!changesUnits) return;
  if (!hasPermission(user.role, resolvePermissions(user), 'inventory.products.manage')) {
    throw new PermissionError('Changing a product\'s units needs permission to manage products');
  }
}
