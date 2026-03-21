import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { resolvePermissions, hasPermission, hasAnyPermission } from '@/lib/permissions';
import type { PermissionKey } from '@/lib/permissions';
import type { UserRole } from '@/api/types';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Require a specific micro-permission (admin bypasses) */
  permission?: PermissionKey;
  /** Require ANY of these micro-permissions (admin bypasses) */
  anyPermission?: PermissionKey[];
  /** Require admin role */
  adminOnly?: boolean;
  /** Require one of these roles */
  roles?: UserRole[];
}

/** Route guard — redirects to / with a toast if access is denied. */
export function ProtectedRoute({ children, permission, anyPermission, adminOnly, roles }: ProtectedRouteProps) {
  const { t } = useTranslation();
  // Subscribe to currentUser directly so we re-render when it changes
  const currentUser = useAuthStore((s) => s.currentUser);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated || !currentUser) {
    return <Navigate to="/" replace />;
  }

  const isAdmin = currentUser.role === 'admin';

  if (adminOnly && !isAdmin) {
    toast.error(t('Access denied'));
    return <Navigate to="/" replace />;
  }

  if (permission && !isAdmin) {
    const perms = resolvePermissions(currentUser);
    if (!hasPermission(currentUser.role, perms, permission)) {
      toast.error(t('Access denied'));
      return <Navigate to="/" replace />;
    }
  }

  if (anyPermission && !isAdmin) {
    const perms = resolvePermissions(currentUser);
    if (!hasAnyPermission(currentUser.role, perms, anyPermission)) {
      toast.error(t('Access denied'));
      return <Navigate to="/" replace />;
    }
  }

  if (roles && !roles.includes(currentUser.role)) {
    toast.error(t('Access denied'));
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
