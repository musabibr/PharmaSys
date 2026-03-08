import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { useShiftStore } from '@/stores/shift.store';
import { resolvePermissions, hasAnyPermission } from '@/lib/permissions';
import type { PermissionKey } from '@/lib/permissions';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  FileText,
  Wallet,
  Clock,
  TrendingUp,
  BarChart3,
  Users,
  ScrollText,
  Settings,
  Monitor,
  ShoppingBag,
  ChevronsLeft,
  ChevronsRight,
  Zap,
  type LucideIcon,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  icon: LucideIcon;
  path: string;
  visible?: boolean; // defaults to true — set false to hide individual links
}

interface NavSection {
  title: string;
  items: NavItem[];
  visible: () => boolean;
}

// ─── Route & section definitions ──────────────────────────────────────────────

function useNavSections(): NavSection[] {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isAdmin = currentUser?.role === 'admin';
  const perms = currentUser ? resolvePermissions(currentUser) : new Set<PermissionKey>();
  const hasAnyPerm = (keys: PermissionKey[]) =>
    isAdmin || hasAnyPermission(currentUser?.role ?? '', perms, keys);
  const hasPerm = (key: PermissionKey) =>
    isAdmin || perms.has(key);

  const canViewTransactions = hasAnyPerm(['finance.transactions.view', 'finance.transactions.view_own']);
  const canViewExpenses     = hasPerm('finance.expenses.view');
  const canViewShifts       = hasAnyPerm(['finance.shifts.view', 'finance.shifts.view_own']);
  const canViewPurchases    = hasAnyPerm(['purchases.view', 'purchases.manage']);
  const canSales            = hasPerm('pos.sales');
  const canCashFlow         = hasPerm('reports.cash_flow');
  const canProfitLoss       = hasPerm('reports.profit_loss');

  return [
    {
      title: 'MAIN',
      items: [
        { label: 'Dashboard', icon: LayoutDashboard, path: '/' },
        { label: 'Point of Sale', icon: ShoppingCart, path: '/pos', visible: canSales },
      ],
      visible: () => true,
    },
    {
      title: 'INVENTORY',
      items: [
        { label: 'Inventory', icon: Package, path: '/inventory' },
      ],
      visible: () => hasAnyPerm([
        'inventory.products.view', 'inventory.batches.view',
        'inventory.categories.view', 'inventory.valuation',
        'inventory.expiry_alerts', 'inventory.low_stock',
      ]),
    },
    {
      title: 'FINANCE',
      items: [
        { label: 'Transactions', icon: FileText, path: '/transactions', visible: canViewTransactions },
        { label: 'Expenses', icon: Wallet, path: '/expenses', visible: canViewExpenses },
        { label: 'Purchases', icon: ShoppingBag, path: '/purchases', visible: canViewPurchases },
        { label: 'Shifts', icon: Clock, path: '/shifts', visible: canViewShifts },
      ],
      visible: () => canViewTransactions || canViewExpenses || canViewShifts || canViewPurchases,
    },
    {
      title: 'REPORTS',
      items: [
        { label: 'Cash Flow', icon: TrendingUp, path: '/cash-flow', visible: canCashFlow },
        { label: 'Profit & Loss', icon: BarChart3, path: '/profit-loss', visible: canProfitLoss },
      ],
      visible: () => canCashFlow || canProfitLoss,
    },
    {
      title: 'ADMIN',
      items: [
        { label: 'Users', icon: Users, path: '/users' },
        { label: 'Audit Log', icon: ScrollText, path: '/audit' },
        { label: 'Settings', icon: Settings, path: '/settings' },
        { label: 'Device Setup', icon: Monitor, path: '/device-setup' },
      ],
      visible: () => isAdmin,
    },
  ];
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

function SidebarNavItem({
  item,
  isActive,
  collapsed,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const { t, i18n } = useTranslation();
  const tooltipSide = i18n.dir() === 'rtl' ? 'left' as const : 'right' as const;
  const Icon = item.icon;

  const button = (
    <button
      onClick={onClick}
      className={cn(
        'sb-nav-item group relative flex w-full items-center transition-all duration-150',
        collapsed
          ? 'justify-center rounded-md p-3'
          : 'gap-3.5 rounded-md px-4 py-2.5',
        isActive
          ? 'sb-nav-active'
          : 'sb-nav-idle'
      )}
    >
      {/* Active accent edge — Bauhaus yellow stripe */}
      {isActive && !collapsed && (
        <span className="sb-accent-bar absolute inset-y-1 start-0" />
      )}
      {/* Icon */}
      <span
        className={cn(
          'sb-nav-icon relative z-10 flex shrink-0 items-center justify-center rounded-md transition-all duration-150',
          collapsed ? 'h-10 w-10' : 'h-8 w-8',
        )}
      >
        <Icon className={cn(collapsed ? 'h-5 w-5' : 'h-[17px] w-[17px]')} strokeWidth={2.2} />
      </span>
      {/* Label */}
      {!collapsed && (
        <span className="sb-nav-label relative z-10 truncate text-[14px] font-semibold">
          {t(item.label)}
        </span>
      )}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltipSide} className="text-[13px] font-bold">
          {t(item.label)}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

// ─── Section ──────────────────────────────────────────────────────────────────

function SidebarSection({
  section,
  collapsed,
  currentPath,
  onNavigate,
  isFirst,
}: {
  section: NavSection;
  collapsed: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  isFirst: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className={cn(!isFirst && 'mt-3')}>
      {/* Section title */}
      {!collapsed && !isFirst && (
        <div className="mb-1.5 px-4 pt-3">
          <span className="sb-section-title text-[10px] font-black uppercase tracking-[0.22em]">
            {t(section.title)}
          </span>
        </div>
      )}
      {/* Collapsed divider */}
      {collapsed && !isFirst && (
        <div className="sb-section-divider mx-auto my-3 h-px w-6" />
      )}
      <div className="space-y-1">
        {section.items.filter((item) => item.visible !== false).map((item) => (
          <SidebarNavItem
            key={item.path}
            item={item}
            isActive={currentPath === item.path}
            collapsed={collapsed}
            onClick={() => onNavigate(item.path)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────

export function Sidebar() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser } = useAuthStore();
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const { currentShift } = useShiftStore();

  const sections = useNavSections();
  const isRtl = i18n.dir() === 'rtl';
  const tooltipSide = isRtl ? 'left' as const : 'right' as const;

  const userInitial = currentUser?.full_name
    ? currentUser.full_name.charAt(0).toUpperCase()
    : currentUser?.username?.charAt(0).toUpperCase() ?? '?';

  const displayName = currentUser?.full_name || currentUser?.username || '';
  const visibleSections = sections.filter((s) => s.visible());

  const roleLabel =
    currentUser?.role === 'admin' ? 'Administrator' :
    currentUser?.role === 'pharmacist' ? 'Pharmacist' :
    currentUser?.role === 'cashier' ? 'Cashier' : '';

  return (
    <aside
      className={cn(
        'sb-root flex h-full flex-col transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
        sidebarCollapsed ? 'w-[76px]' : 'w-[272px]'
      )}
    >
      {/* ── Brand header ──────────────────────────────────────────────── */}
      <div className={cn(
        'flex shrink-0 items-center',
        sidebarCollapsed ? 'h-20 justify-center' : 'h-20 justify-between px-5'
      )}>
        <div className="flex items-center gap-3 overflow-hidden">
          {/* Logo — flat Bauhaus block */}
          <div className="sb-logo relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[15px] font-black">
            P
          </div>
          {!sidebarCollapsed && (
            <div className="flex flex-col">
              <span className="text-[17px] font-black leading-tight tracking-[-0.02em] uppercase text-sidebar-foreground">
                {t('PharmaSys')}
              </span>
              <span className="sb-subtitle text-[9px] font-bold uppercase tracking-[0.16em]">
                {t('Pharmacy Management')}
              </span>
            </div>
          )}
        </div>
        {!sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="sb-collapse-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all duration-150"
          >
            {isRtl
              ? <ChevronsRight className="h-4 w-4" />
              : <ChevronsLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Collapsed expand */}
      {sidebarCollapsed && (
        <div className="flex shrink-0 justify-center pb-1">
          <button
            onClick={toggleSidebar}
            className="sb-collapse-btn flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150"
          >
            {isRtl
              ? <ChevronsLeft className="h-4 w-4" />
              : <ChevronsRight className="h-4 w-4" />}
          </button>
        </div>
      )}

      {/* ── Navigation ────────────────────────────────────────────────── */}
      <ScrollArea className="flex-1">
        <nav data-tour="sidebar" className={cn('px-3 pb-2', sidebarCollapsed && 'px-2')}>
          {visibleSections.map((section, idx) => (
            <SidebarSection
              key={section.title}
              section={section}
              collapsed={sidebarCollapsed}
              currentPath={location.pathname}
              onNavigate={(path) => navigate(path)}
              isFirst={idx === 0}
            />
          ))}
        </nav>
      </ScrollArea>

      {/* ── Shift status ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pb-2">
        {sidebarCollapsed ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <div className="flex justify-center py-2">
                <span
                  className={cn(
                    'h-3 w-3 rounded-full',
                    currentShift ? 'sb-shift-dot-active' : 'sb-shift-dot-idle'
                  )}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide}>
              {currentShift ? t('Shift Open') : t('No Shift')}
            </TooltipContent>
          </Tooltip>
        ) : (
          <div className={cn(
            'sb-shift-card flex items-center gap-3 rounded-md px-4 py-2.5',
            currentShift ? 'sb-shift-open' : 'sb-shift-closed'
          )}>
            <Zap className={cn(
              'h-4 w-4 shrink-0',
              currentShift ? 'sb-shift-icon-active' : 'sb-shift-icon-idle'
            )} />
            <span className="text-[13px] font-bold">
              {currentShift ? t('Shift Open') : t('No Shift')}
            </span>
          </div>
        )}
      </div>

      {/* ── User profile ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pb-4">
        {sidebarCollapsed ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <div className="flex justify-center py-1">
                <div className="sb-avatar-collapsed relative flex h-10 w-10 items-center justify-center rounded-md text-[14px] font-black">
                  {userInitial}
                  <span className={cn(
                    'absolute -bottom-0.5 -end-0.5 h-3.5 w-3.5 rounded-full border-[2.5px]',
                    'sb-status-dot',
                    currentShift ? 'sb-status-online' : 'sb-status-offline'
                  )} />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide}>
              <div className="space-y-1">
                <p className="text-[13px] font-bold">{displayName}</p>
                <p className="text-xs text-muted-foreground">{t(roleLabel)}</p>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <div className="sb-user-card flex items-center gap-3 rounded-md px-4 py-3">
            {/* Avatar */}
            <div className="sb-avatar relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[14px] font-black">
              {userInitial}
              <span className={cn(
                'absolute -bottom-0.5 -end-0.5 h-3.5 w-3.5 rounded-full border-[2.5px]',
                'sb-status-dot',
                currentShift ? 'sb-status-online' : 'sb-status-offline'
              )} />
            </div>
            {/* Info */}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-bold sb-user-name">
                {displayName}
              </p>
              <p className="sb-user-role mt-0.5 text-[11px] font-bold uppercase tracking-[0.06em]">
                {t(roleLabel)}
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
