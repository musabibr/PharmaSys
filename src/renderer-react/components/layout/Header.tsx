import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { useShiftStore } from '@/stores/shift.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useTourContext } from '@/tours/TourProvider';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import {
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  Key,
  LogOut,
  HelpCircle,
  Check,
  Play,
  RotateCcw,
  Server,
  Monitor,
  Minimize2,
  Maximize2,
  ScanLine,
} from 'lucide-react';

// ─── Breadcrumb mapping ────────────────────────────────────────────────────
const BREADCRUMB_MAP: Record<string, string> = {
  '/': 'Dashboard',
  '/pos': 'Point of Sale',
  '/inventory': 'Inventory',
  '/transactions': 'Transactions',
  '/expenses': 'Expenses',
  '/shifts': 'Shift Management',
  '/cash-flow': 'Cash Flow Report',
  '/profit-loss': 'Profit & Loss',
  '/users': 'User Management',
  '/audit': 'Audit Log',
  '/settings': 'Settings',
  '/purchases': 'Purchases',
};

interface HeaderProps {
  onChangePassword?: () => void;
}

export function Header({ onChangePassword }: HeaderProps) {
  const { pathname } = useLocation();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.dir() === 'rtl';
  const { currentUser, logout } = useAuthStore();
  const { theme, toggleTheme, sidebarCollapsed, toggleSidebar, density, cycleDensity } = useUiStore();
  const { currentShift } = useShiftStore();
  const shiftsEnabled = useSettingsStore((s) => s.getSetting('shifts_enabled') !== 'false');

  function handleLogout() {
    if (shiftsEnabled && currentShift) {
      const confirmed = window.confirm(
        t('You have an open shift. Are you sure you want to logout without closing it?')
      );
      if (!confirmed) return;
    }
    logout();
  }
  const { getAvailableTours, startTour, isCompleted, resetAllTours } = useTourContext();
  const conn = useConnectionStatus();

  // Resolve breadcrumb label from current path
  const breadcrumbLabel = BREADCRUMB_MAP[pathname] || 'Dashboard';

  // User display info
  const displayName = currentUser?.full_name || currentUser?.username || '';
  const userInitial = displayName.charAt(0).toUpperCase() || 'U';
  const userRole = currentUser?.role || '';

  const availableTours = getAvailableTours();

  return (
    <header className="flex h-header items-center justify-between border-b border-border px-4">
      {/* ── Left side: toggle + breadcrumb ── */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? t('Expand sidebar') : t('Collapse sidebar')}
        >
          {sidebarCollapsed
            ? (isRtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)
            : (isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />)
          }
        </Button>

        <Separator orientation="vertical" className="h-6" />

        <span className="text-sm font-medium text-muted-foreground">
          {t(breadcrumbLabel)}
        </span>
      </div>

      {/* ── Right side: help, theme, shift, user ── */}
      <div className="flex items-center gap-2">
        {/* Help / Tours dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-tour="header-help"
              variant="ghost"
              size="icon"
              aria-label={t('Guided Tours')}
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>{t('Guided Tours')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {availableTours.map((tour) => (
              <DropdownMenuItem
                key={tour.id}
                onClick={() => startTour(tour.id)}
                className="cursor-pointer gap-2"
              >
                {isCompleted(tour.id) ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Play className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{t(tour.name)}</p>
                  <p className="text-xs text-muted-foreground truncate">{t(tour.description)}</p>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={resetAllTours}
              className="cursor-pointer gap-2 text-muted-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="text-sm">{t('Reset All Tours')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Density toggle — cycles auto → compact → comfort */}
        <Button
          variant="ghost"
          size="icon"
          onClick={cycleDensity}
          aria-label={t('Display density') + `: ${density}`}
          title={`${t('Density')}: ${density}`}
        >
          {density === 'compact' ? (
            <Minimize2 className="h-4 w-4" />
          ) : density === 'comfort' ? (
            <Maximize2 className="h-4 w-4" />
          ) : (
            <ScanLine className="h-4 w-4" />
          )}
        </Button>

        {/* Theme toggle */}
        <Button
          data-tour="header-theme"
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')}
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>

        {/* Connection status badge */}
        {conn.mode === 'server' && (
          <>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Server className="h-3.5 w-3.5" />
              <span className="font-medium">{t('Server')}</span>
              <span className="font-mono">{conn.lanIp || '...'}</span>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            </div>
            <Separator orientation="vertical" className="h-6" />
          </>
        )}
        {conn.mode === 'client' && (
          <>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Monitor className="h-3.5 w-3.5" />
              <span className="font-medium">{t('Client')}</span>
              {conn.connected ? (
                <>
                  <span className="text-emerald-600 dark:text-emerald-400">{t('Connected')}</span>
                  <span className="relative flex h-2 w-2">
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                </>
              ) : (
                <>
                  <span className="text-destructive">{t('Disconnected')}</span>
                  <span className="relative flex h-2 w-2">
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
                  </span>
                </>
              )}
            </div>
          </>
        )}

        <Separator orientation="vertical" className="h-6" />

        {/* Shift status badge */}
        {currentShift ? (
          <Badge variant="success">{t('Shift Open')}</Badge>
        ) : (
          <Badge variant="warning">{t('No Shift')}</Badge>
        )}

        <Separator orientation="vertical" className="h-6" />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-tour="header-user" variant="ghost" size="sm" className="gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {userInitial}
              </div>
              <span className="text-sm">{displayName}</span>
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-56">
            {/* User info header */}
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium leading-none">{displayName}</p>
                <p className="text-xs leading-none text-muted-foreground capitalize">
                  {t(userRole)}
                </p>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            {/* Change password */}
            <DropdownMenuItem
              onClick={onChangePassword}
              className="cursor-pointer gap-2"
            >
              <Key className="h-4 w-4" />
              <span>{t('Change Password')}</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Logout */}
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer gap-2 text-destructive focus:text-destructive"
            >
              <LogOut className="h-4 w-4" />
              <span>{t('Logout')}</span>
            </DropdownMenuItem>

          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
