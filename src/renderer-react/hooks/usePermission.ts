import { useAuthStore } from '@/stores/auth.store';
import { resolvePermissions, hasPermission, hasAnyPermission } from '@/lib/permissions';
import type { PermissionKey } from '@/lib/permissions';
import type { UserRole } from '@/api/types';

/** Check if the current user has a specific micro-permission (admin bypasses) */
export function usePermission(permission: PermissionKey): boolean {
  return useAuthStore((s) => {
    const user = s.currentUser;
    if (!user) return false;
    const perms = resolvePermissions(user);
    return hasPermission(user.role, perms, permission);
  });
}

/** Check if the current user has ANY of the given micro-permissions */
export function useAnyPermission(permissions: PermissionKey[]): boolean {
  return useAuthStore((s) => {
    const user = s.currentUser;
    if (!user) return false;
    const perms = resolvePermissions(user);
    return hasAnyPermission(user.role, perms, permissions);
  });
}

/** Check if the current user has a specific role */
export function useHasRole(role: UserRole): boolean {
  return useAuthStore((s) => s.currentUser?.role === role);
}

/** Check if the current user is an admin */
export function useIsAdmin(): boolean {
  return useAuthStore((s) => s.currentUser?.role === 'admin');
}
