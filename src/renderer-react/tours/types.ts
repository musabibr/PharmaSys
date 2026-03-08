import type { UserRole } from '@/api/types';
import type { PermissionKey } from '@/lib/permissions';

export interface TourStepDef {
  id: string;
  /** CSS selector for the target element, e.g. '[data-tour="sidebar"]' */
  target?: string;
  /** i18n key — English text used as fallback */
  title: string;
  /** i18n key — English text used as fallback */
  text: string;
  position?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  /** Only show this step for specific roles */
  requiredRole?: UserRole[];
  /** Only show this step if user has this permission */
  requiredPermission?: PermissionKey;
}

export interface TourDefinition {
  id: string;
  /** i18n key for display name */
  name: string;
  /** i18n key for description */
  description: string;
  /** Route to navigate to before starting the tour */
  route: string;
  /** Only show this tour for specific roles */
  requiredRole?: UserRole[];
  /** Only show this tour if user has this permission */
  requiredPermission?: PermissionKey;
  steps: TourStepDef[];
}
