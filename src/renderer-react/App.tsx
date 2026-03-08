import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DirectionProvider } from '@radix-ui/react-direction';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useShiftStore } from '@/stores/shift.store';
import { TourProvider } from '@/tours/TourProvider';
import { LoginPage } from '@/components/auth/LoginPage';
import { DeviceSetupWizard } from '@/components/setup/DeviceSetupWizard';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { DashboardPage } from '@/components/dashboard/DashboardPage';
import { POSPage } from '@/components/pos/POSPage';
import { InventoryPage } from '@/components/inventory/InventoryPage';
import { TransactionsPage } from '@/components/finance/TransactionsPage';
import { ExpensesPage } from '@/components/finance/ExpensesPage';
import { ShiftsPage } from '@/components/finance/ShiftsPage';
import { AuditPage } from '@/components/admin/AuditPage';
import { SettingsPage } from '@/components/admin/SettingsPage';
import { UsersPage } from '@/components/admin/UsersPage';
import { DeviceSetupPage } from '@/components/admin/DeviceSetupPage';
import PurchasesPage from '@/components/purchases/PurchasesPage';
import type { DeviceMode } from '@/api/types';

// Lazy-load report pages (Recharts is ~200KB — defer until user navigates to reports)
const CashFlowPage = lazy(() => import('@/components/reports/CashFlowPage').then(m => ({ default: m.CashFlowPage })));
const ProfitLossPage = lazy(() => import('@/components/reports/ProfitLossPage').then(m => ({ default: m.ProfitLossPage })));

function LazyFallback() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

/** Root app component — handles initialization, theme, and routing. */
export function App() {
  const { i18n } = useTranslation();
  const { isAuthenticated, isLoading, checkSession, loadAppInfo } = useAuthStore();
  const theme = useUiStore((s) => s.theme);
  const { loadSettings, isLoaded: settingsLoaded } = useSettingsStore();
  const storedLanguage = useSettingsStore((s) => s.settings['language'] || 'en');
  const { loadCurrentShift } = useShiftStore();

  // Device mode — show setup wizard on fresh install (standalone mode)
  const [deviceMode, setDeviceMode] = useState<DeviceMode | null>(null);

  useEffect(() => {
    if (window.api?.device?.getConfig) {
      window.api.device.getConfig()
        .then((config) => setDeviceMode(config.mode))
        .catch(() => setDeviceMode('standalone'));
    } else {
      setDeviceMode('standalone');
    }
  }, []);

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(theme);
  }, [theme]);

  // Initialize on mount
  useEffect(() => {
    checkSession();
    loadAppInfo();
  }, [checkSession, loadAppInfo]);

  // Load settings + shift when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadSettings();
      loadCurrentShift();
    }
  }, [isAuthenticated, loadSettings, loadCurrentShift]);

  // Sync language from settings — reacts to actual stored value changes
  useEffect(() => {
    if (settingsLoaded && storedLanguage) {
      i18n.changeLanguage(storedLanguage);
      document.documentElement.dir = storedLanguage === 'ar' ? 'rtl' : 'ltr';
      document.documentElement.lang = storedLanguage;
      try { localStorage.setItem('pharmasys-lang', storedLanguage); } catch { /* ignore */ }
    }
  }, [settingsLoaded, storedLanguage, i18n]);

  // Session activity tracker
  useEffect(() => {
    if (!isAuthenticated || !window.api?.session) return;

    let lastTrack = 0;
    const track = () => {
      const now = Date.now();
      if (now - lastTrack > 60_000) {
        lastTrack = now;
        window.api.session.trackActivity().catch(() => {});
      }
    };

    window.addEventListener('mousemove', track);
    window.addEventListener('keydown', track);
    return () => {
      window.removeEventListener('mousemove', track);
      window.removeEventListener('keydown', track);
    };
  }, [isAuthenticated]);

  // Session expiry listener
  useEffect(() => {
    if (!window.api?.auth?.onSessionExpired) return;
    const cleanup = window.api.auth.onSessionExpired(() => {
      useAuthStore.getState().setUser(null);
    });
    return cleanup;
  }, []);

  // Radix UI needs an explicit DirectionProvider — without it, all Radix
  // components (ScrollArea, Select, Popover…) default to "ltr" regardless
  // of the HTML dir attribute.
  const dir = i18n.dir();

  // Loading screen
  if (isLoading || deviceMode === null) {
    return (
      <DirectionProvider dir={dir}>
        <div className="flex h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        </div>
      </DirectionProvider>
    );
  }

  // Fresh install (standalone mode) → show setup wizard before anything
  if (deviceMode === 'standalone') {
    return (
      <DirectionProvider dir={dir}>
        <DeviceSetupWizard />
        <Toaster
          position={dir === 'rtl' ? 'top-left' : 'top-right'}
          dir={dir}
          richColors
          closeButton
          toastOptions={{ duration: 4000, className: 'text-sm' }}
        />
      </DirectionProvider>
    );
  }

  // Not logged in → show login page
  if (!isAuthenticated) {
    return (
      <DirectionProvider dir={dir}>
        <LoginPage />
      </DirectionProvider>
    );
  }

  // Authenticated → show app shell with routes
  return (
    <DirectionProvider dir={dir}>
    <TourProvider>
    <TooltipProvider delayDuration={300}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />

          {/* Phase 2 — POS */}
          <Route path="/pos" element={
            <ProtectedRoute permission="pos.sales">
              <POSPage />
            </ProtectedRoute>
          } />

          {/* Phase 3 — Inventory */}
          <Route path="/inventory" element={
            <ProtectedRoute anyPermission={['inventory.products.view', 'inventory.batches.view', 'inventory.categories.view', 'inventory.valuation', 'inventory.expiry_alerts', 'inventory.low_stock']}>
              <InventoryPage />
            </ProtectedRoute>
          } />

          {/* Phase 4 — Finance */}
          <Route path="/transactions" element={
            <ProtectedRoute anyPermission={['finance.transactions.view', 'finance.transactions.view_own']}>
              <TransactionsPage />
            </ProtectedRoute>
          } />
          <Route path="/expenses" element={
            <ProtectedRoute permission="finance.expenses.view">
              <ExpensesPage />
            </ProtectedRoute>
          } />
          <Route path="/shifts" element={
            <ProtectedRoute anyPermission={['finance.shifts.view', 'finance.shifts.view_own']}>
              <ShiftsPage />
            </ProtectedRoute>
          } />
          <Route path="/purchases" element={
            <ProtectedRoute anyPermission={['purchases.view', 'purchases.manage']}>
              <PurchasesPage />
            </ProtectedRoute>
          } />

          {/* Phase 5 — Reports */}
          <Route path="/cash-flow" element={
            <ProtectedRoute permission="reports.cash_flow">
              <Suspense fallback={<LazyFallback />}><CashFlowPage /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/profit-loss" element={
            <ProtectedRoute permission="reports.profit_loss">
              <Suspense fallback={<LazyFallback />}><ProfitLossPage /></Suspense>
            </ProtectedRoute>
          } />
          {/* Phase 5 — Admin */}
          <Route path="/users" element={
            <ProtectedRoute adminOnly>
              <UsersPage />
            </ProtectedRoute>
          } />
          <Route path="/audit" element={
            <ProtectedRoute adminOnly>
              <AuditPage />
            </ProtectedRoute>
          } />
          <Route path="/settings" element={
            <ProtectedRoute adminOnly>
              <SettingsPage />
            </ProtectedRoute>
          } />
          <Route path="/device-setup" element={
            <ProtectedRoute adminOnly>
              <DeviceSetupPage />
            </ProtectedRoute>
          } />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
    </TourProvider>
    <Toaster
      position={dir === 'rtl' ? 'top-left' : 'top-right'}
      dir={dir}
      richColors
      closeButton
      toastOptions={{
        duration: 4000,
        className: 'text-sm',
      }}
    />
    </DirectionProvider>
  );
}
