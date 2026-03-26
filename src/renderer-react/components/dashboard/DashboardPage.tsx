import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/api';
import type { DashboardStats, Batch, ReorderRecommendation } from '@/api/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { usePermission, useAnyPermission } from '@/hooks/usePermission';
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Package,
  CheckCircle,
  Calendar,
  Activity,
  CreditCard,
  Clock,
  ArrowUpRight,
  Sun,
  Sunset,
  Moon,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLongDate(locale: string): string {
  const now = new Date();
  return now.toLocaleDateString(locale === 'ar' ? 'ar-SD' : 'en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getGreeting(t: (k: string) => string): { text: string; Icon: LucideIcon } {
  const h = new Date().getHours();
  if (h < 12) return { text: t('Good Morning'), Icon: Sun };
  if (h < 17) return { text: t('Good Afternoon'), Icon: Sunset };
  return { text: t('Good Evening'), Icon: Moon };
}

function expiryVariant(expiryDate: string): 'destructive' | 'warning' | 'secondary' {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
  if (diffDays <= 0) return 'destructive';
  if (diffDays <= 7) return 'warning';
  return 'secondary';
}

function formatExpiry(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** Percentage with ceiling at 100 */
function pct(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.round((current / max) * 100));
}

// ---------------------------------------------------------------------------
// Animated number — counts up on mount
// ---------------------------------------------------------------------------
function AnimatedNumber({ value, prefix = '', suffix = '', duration = 800 }: {
  value: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const startVal = 0;
    const endVal = value;
    const step = () => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(startVal + (endVal - startVal) * eased));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [value, duration]);

  return <>{prefix}{display.toLocaleString()}{suffix}</>;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------
function DashboardSkeleton() {
  return (
    <div className="db-page space-y-6">
      {/* Hero skeleton */}
      <div className="db-hero rounded-lg p-8">
        <Skeleton className="h-6 w-48 bg-primary/20" />
        <Skeleton className="mt-2 h-12 w-64 bg-primary/20" />
        <div className="mt-6 flex gap-8">
          <Skeleton className="h-20 w-40 bg-primary/10" />
          <Skeleton className="h-20 w-40 bg-primary/10" />
          <Skeleton className="h-20 w-40 bg-primary/10" />
        </div>
      </div>
      {/* Grid skeleton */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}><CardContent className="p-5">
            <Skeleton className="mb-3 h-3 w-20" />
            <Skeleton className="mb-2 h-8 w-28" />
          </CardContent></Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
      <CheckCircle className="mb-3 h-10 w-10 text-success" strokeWidth={1.5} />
      <p className="text-[14px] font-bold">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardPage
// ---------------------------------------------------------------------------
export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.currentUser);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [expiring, setExpiring] = useState<Batch[]>([]);
  const [reorder, setReorder] = useState<ReorderRecommendation[]>([]);
  const [overdueSummary, setOverdueSummary] = useState<{ count: number; total: number } | null>(null);
  const [upcomingSummary, setUpcomingSummary] = useState<{ count: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canSeeExpiry = useAnyPermission(['inventory.batches.view', 'inventory.expiry_alerts']);
  const canSeeReorder = useAnyPermission(['inventory.reorder', 'inventory.low_stock']);
  const canSeePurchases = useAnyPermission(['purchases.view', 'purchases.manage']);
  const canViewTotals = usePermission('finance.view_totals');
  const canViewCosts = usePermission('inventory.view_costs');
  const canViewTransactions = useAnyPermission(['finance.transactions.view', 'finance.transactions.view_own']);
  const canViewInventory = useAnyPermission(['inventory.products.view', 'inventory.batches.view', 'inventory.expiry_alerts']);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statsData, expiringData, reorderData, overdueData, upcomingData] = await Promise.all([
          api.dashboard.stats(),
          canSeeExpiry ? api.batches.getExpiring(30) : Promise.resolve([]),
          canSeeReorder ? api.reports.reorderRecommendations() : Promise.resolve([]),
          canSeePurchases ? api.purchases.getOverdueSummary() : Promise.resolve(null),
          canSeePurchases ? api.purchases.getUpcomingSummary() : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setStats(statsData);
        setExpiring(Array.isArray(expiringData) ? expiringData : []);
        setReorder(Array.isArray(reorderData) ? reorderData : []);
        setOverdueSummary(overdueData);
        setUpcomingSummary(upcomingData);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canSeeExpiry, canSeeReorder, canSeePurchases]);

  const greeting = useMemo(() => getGreeting(t), [t]);
  const firstName = currentUser?.full_name?.split(' ')[0] ?? currentUser?.username ?? '';
  const dateStr = formatLongDate(i18n.language);
  const roleLabel =
    currentUser?.role === 'admin' ? t('Administrator') :
    currentUser?.role === 'pharmacist' ? t('Pharmacist') :
    currentUser?.role === 'cashier' ? t('Cashier') : '';

  if (loading) return <DashboardSkeleton />;

  if (error || !stats) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
        <p className="text-lg font-bold">{error ?? t('Failed to load dashboard')}</p>
        <button
          onClick={() => {
            setLoading(true);
            setError(null);
            Promise.all([
              api.dashboard.stats(),
              canSeeExpiry ? api.batches.getExpiring(30) : Promise.resolve([]),
              canSeeReorder ? api.reports.reorderRecommendations() : Promise.resolve([]),
            ] as [Promise<DashboardStats>, Promise<Batch[]>, Promise<ReorderRecommendation[]>])
              .then(([s, e, r]) => { setStats(s); setExpiring(Array.isArray(e) ? e : []); setReorder(Array.isArray(r) ? r : []); })
              .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard'))
              .finally(() => setLoading(false));
          }}
          className="mt-4 text-sm font-bold text-primary underline hover:no-underline"
        >
          {t('Try again')}
        </button>
      </div>
    );
  }

  // Inventory health score (0-100)
  const totalAlerts = stats.low_stock_count + stats.expired_count + stats.expiring_soon_count;
  const healthScore = totalAlerts === 0 ? 100 : Math.max(0, 100 - totalAlerts * 5);

  return (
    <div className="db-page space-y-6">

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/*  HERO BANNER — Dramatic primary block with key metric                  */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div data-tour="dashboard-hero" className="db-hero relative overflow-hidden rounded-lg">
        {/* Geometric decorations */}
        <div className="db-hero-circle db-hero-circle-1" />
        <div className="db-hero-circle db-hero-circle-2" />
        <div className="db-hero-stripe" />

        <div className="relative z-10 p-6 sm:p-8">
          {/* Top row: greeting + role badge */}
          <div className="flex items-center gap-3">
            <greeting.Icon className="h-5 w-5 text-primary-foreground/70" strokeWidth={2} />
            <span className="text-[14px] font-bold uppercase tracking-[0.1em] text-primary-foreground/60">
              {greeting.text}
            </span>
            <Badge className="ms-auto db-hero-badge">
              <ShieldCheck className="me-1.5 h-3.5 w-3.5" />
              {roleLabel}
            </Badge>
          </div>

          {/* Name */}
          <h1 className="mt-2 text-[32px] font-black leading-none text-primary-foreground sm:text-[40px]">
            {firstName}
          </h1>
          <p className="mt-1.5 text-[13px] font-bold uppercase tracking-[0.08em] text-primary-foreground/50">
            {dateStr}
          </p>

          {/* Hero metrics strip */}
          {canViewTotals && (
            <div className="mt-6 flex flex-wrap gap-6 sm:gap-10">
              {/* Today's Sales — THE hero number */}
              <div onClick={canViewTransactions ? () => navigate('/transactions') : undefined} className={`text-start ${canViewTransactions ? 'cursor-pointer group' : ''}`}>
                <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary-foreground/55">
                  {t("Today's Sales")}
                  <span className="ms-1.5 normal-case tracking-normal font-medium text-primary-foreground/35">
                    {new Date().toLocaleDateString(i18n.language === 'ar' ? 'ar-SD' : 'en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </p>
                <p className="mt-1 text-[36px] font-black leading-none tracking-tight text-primary-foreground sm:text-[48px]">
                  <AnimatedNumber value={stats.today_net_sales} />
                  <span className="ms-1.5 text-[16px] font-bold text-primary-foreground/50 sm:text-[20px]">SDG</span>
                </p>
                <p className="mt-1.5 text-[12px] font-medium text-primary-foreground/45">
                  {stats.today_transactions} {t('txns')}
                  {stats.today_returns > 0 && (
                    <> &middot; {formatCurrency(stats.today_returns)} {t('returns')}</>
                  )}
                </p>
              </div>

              {/* Divider */}
              <div className="hidden w-px self-stretch bg-primary-foreground/10 sm:block" />

              {/* Monthly */}
              <div onClick={canViewTransactions ? () => navigate('/transactions') : undefined} className={`text-start ${canViewTransactions ? 'cursor-pointer group' : ''}`}>
                <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary-foreground/55">
                  {t('Monthly Sales')}
                  <span className="ms-1.5 normal-case tracking-normal font-medium text-primary-foreground/35">
                    {(() => {
                      const locale = i18n.language === 'ar' ? 'ar-SD' : 'en-US';
                      const fmt = { month: 'short' as const, day: 'numeric' as const };
                      const end = new Date();
                      const start = new Date(end.getFullYear(), end.getMonth(), 1);
                      return `${start.toLocaleDateString(locale, fmt)} — ${end.toLocaleDateString(locale, fmt)}`;
                    })()}
                  </span>
                </p>
                <p className="mt-1 text-[28px] font-black leading-none tracking-tight text-primary-foreground sm:text-[36px]">
                  <AnimatedNumber value={stats.month_net_sales} />
                  <span className="ms-1.5 text-[14px] font-bold text-primary-foreground/50">SDG</span>
                </p>
                <p className="mt-1.5 text-[12px] font-medium text-primary-foreground/45">
                  {stats.month_transactions} {t('txns')}
                </p>
              </div>

              {/* Divider */}
              <div className="hidden w-px self-stretch bg-primary-foreground/10 sm:block" />

              {/* Inventory Health Ring */}
              <div className="text-start">
                <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary-foreground/55">
                  {t('Inventory Health')}
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <div className="db-health-ring relative flex h-14 w-14 items-center justify-center">
                    <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
                      <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor"
                        className="text-primary-foreground/10" strokeWidth="3" />
                      <circle cx="18" cy="18" r="16" fill="none"
                        className={healthScore >= 70 ? 'text-emerald-400' : healthScore >= 40 ? 'text-amber-400' : 'text-red-400'}
                        strokeWidth="3" strokeLinecap="round"
                        strokeDasharray={`${healthScore} ${100 - healthScore}`}
                        style={{ transition: 'stroke-dasharray 1s ease-out' }}
                      />
                    </svg>
                    <span className="absolute text-[15px] font-black text-primary-foreground">
                      {healthScore}
                    </span>
                  </div>
                  <div>
                    <p className={`text-[14px] font-black ${healthScore >= 70 ? 'text-emerald-400' : healthScore >= 40 ? 'text-amber-400' : 'text-red-400'}`}>
                      {healthScore >= 70 ? t('Healthy') : healthScore >= 40 ? t('Warning') : t('Critical')}
                    </p>
                    <p className="text-[12px] text-primary-foreground/45">
                      {totalAlerts} {t('alerts')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/*  BENTO GRID — Mixed-size metric cards                                  */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div data-tour="dashboard-bento" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:gap-4">
        {/* Purchase Alerts — Installment Notifications */}
        {canSeePurchases && (
          <Card
            className="db-bento-card group cursor-pointer border-s-[3px] border-s-accent transition-all duration-150 hover:translate-y-[-2px] hover:shadow-lg"
            onClick={() => navigate('/purchases', { state: { tab: 'aging' } })}
          >
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="db-metric-label">{t('Purchase Alerts')}</p>
                  <p className="mt-2 text-[32px] font-black leading-none">
                    <AnimatedNumber value={(overdueSummary?.count ?? 0) + (upcomingSummary?.count ?? 0)} duration={600} />
                  </p>
                  <p className="mt-1.5 text-[12px] font-medium text-muted-foreground">
                    {overdueSummary && overdueSummary.count > 0
                      ? <span className="text-destructive font-bold">{overdueSummary.count} {t('overdue')}</span>
                      : t('Installments')}
                    {overdueSummary && overdueSummary.count > 0 && upcomingSummary && upcomingSummary.count > 0 && (
                      <span> · {upcomingSummary.count} {t('upcoming')}</span>
                    )}
                  </p>
                </div>
                <div className={`db-icon-block ${overdueSummary && overdueSummary.count > 0 ? 'bg-destructive/10' : 'bg-accent/10'}`}>
                  <CreditCard className={`h-5 w-5 ${overdueSummary && overdueSummary.count > 0 ? 'text-destructive' : 'text-accent'}`} strokeWidth={2.2} />
                </div>
              </div>
              <div className="mt-3 db-card-arrow">
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.5} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Low Stock */}
        {canSeeReorder && (
          <Card
            className={`db-bento-card group cursor-pointer border-s-[3px] transition-all duration-150 hover:translate-y-[-2px] hover:shadow-lg ${stats.low_stock_count > 0 ? 'border-s-destructive' : 'border-s-primary'}`}
            onClick={() => navigate('/inventory', { state: { tab: 'reorder' } })}
          >
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="db-metric-label">{t('Low Stock Items')}</p>
                  <p className={`mt-2 text-[32px] font-black leading-none ${stats.low_stock_count > 0 ? 'text-destructive' : ''}`}>
                    <AnimatedNumber value={stats.low_stock_count} duration={600} />
                  </p>
                  <p className="mt-1.5 text-[12px] font-medium text-muted-foreground">{t('Items')}</p>
                </div>
                <div className={`db-icon-block ${stats.low_stock_count > 0 ? 'bg-destructive/10' : 'bg-primary/10'}`}>
                  <Package className={`h-5 w-5 ${stats.low_stock_count > 0 ? 'text-destructive' : 'text-primary'}`} strokeWidth={2.2} />
                </div>
              </div>
              <div className="mt-3 db-card-arrow">
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.5} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Inventory Cost */}
        {canViewCosts && (
          <Card className="db-bento-card border-s-[3px] border-s-primary">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="db-metric-label">{t('Inventory Cost Value')}</p>
                  <p className="mt-2 text-[24px] font-black leading-none tracking-tight">
                    <AnimatedNumber value={stats.inventory_cost_value} duration={900} />
                    <span className="ms-1 text-[12px] font-bold text-muted-foreground">SDG</span>
                  </p>
                </div>
                <div className="db-icon-block bg-primary/10">
                  <TrendingDown className="h-5 w-5 text-primary" strokeWidth={2.2} />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Inventory Retail */}
        {canViewCosts && (
          <Card className="db-bento-card border-s-[3px] border-s-success">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="db-metric-label">{t('Inventory Retail Value')}</p>
                  <p className="mt-2 text-[24px] font-black leading-none tracking-tight text-success">
                    <AnimatedNumber value={stats.inventory_retail_value} duration={900} />
                    <span className="ms-1 text-[12px] font-bold text-success/60">SDG</span>
                  </p>
                </div>
                <div className="db-icon-block bg-success/10">
                  <TrendingUp className="h-5 w-5 text-success" strokeWidth={2.2} />
                </div>
              </div>
              {/* Profit margin bar */}
              {stats.inventory_cost_value > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.04em] text-muted-foreground">
                    <span>{t('Margin')}</span>
                    <span className="text-success">{pct(stats.inventory_retail_value - stats.inventory_cost_value, stats.inventory_retail_value)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-muted">
                    <div
                      className="h-full rounded-sm bg-success transition-all duration-1000 ease-out"
                      style={{ width: `${pct(stats.inventory_retail_value - stats.inventory_cost_value, stats.inventory_retail_value)}%` }}
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Expired count — full width alert bar if any */}
      {canSeeExpiry && stats.expired_count > 0 && (
        <div className="db-alert-bar db-alert-bar-danger flex items-center gap-3 rounded-md px-5 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0" strokeWidth={2.2} />
          <span className="text-[14px] font-black uppercase tracking-[0.03em]">
            {stats.expired_count} {t('Expired Batches')}
          </span>
          <span className="text-[13px] font-medium opacity-70">{t('require immediate attention')}</span>
          <button
            onClick={() => navigate('/inventory', { state: { tab: 'expiry' } })}
            className="ms-auto flex items-center gap-1.5 text-[12px] font-black uppercase tracking-[0.04em] opacity-80 hover:opacity-100"
          >
            {t('Review')} <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/*  BAUHAUS DIVIDER                                                       */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-2">
        <div className="h-[3px] w-6 bg-primary" />
        <div className="h-[3px] w-6 bg-accent" />
        <div className="h-[3px] w-3 bg-destructive" />
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/*  ALERT TABLES + PAYMENT CARDS                                          */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Expiring Soon Table */}
        {canSeeExpiry && (
          <Card data-tour="dashboard-expiring">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                <div className="db-icon-block-sm bg-accent/10">
                  <Calendar className="h-4 w-4 text-accent" strokeWidth={2.2} />
                </div>
                <CardTitle className="db-card-title">{t('Expiring Soon (by Date)')}</CardTitle>
                {expiring.length > 0 && (
                  <Badge variant="warning" className="ms-auto">{expiring.length}</Badge>
                )}
                <button
                  onClick={() => navigate('/inventory', { state: { tab: 'expiry' } })}
                  className="ms-2 db-view-all-btn"
                >
                  {t('View All')} <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {expiring.length === 0 ? (
                <EmptyState message={t('No items expiring soon')} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="db-th">{t('Product')}</TableHead>
                      <TableHead className="db-th">{t('Batch')}</TableHead>
                      <TableHead className="db-th">{t('Expiry Date')}</TableHead>
                      <TableHead className="db-th text-end">{t('Qty')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expiring.slice(0, 5).map((batch) => (
                      <TableRow key={batch.id}>
                        <TableCell className="font-bold text-[14px]">{batch.product_name ?? `#${batch.product_id}`}</TableCell>
                        <TableCell className="text-muted-foreground text-[13px]">{batch.batch_number ?? '\u2014'}</TableCell>
                        <TableCell>
                          <Badge variant={expiryVariant(batch.expiry_date)}>{formatExpiry(batch.expiry_date)}</Badge>
                        </TableCell>
                        <TableCell className="text-end tabular-nums font-bold">
                          {formatQuantity(batch.quantity_base, batch.parent_unit ?? 'unit', batch.child_unit ?? 'pc', batch.conversion_factor ?? 1)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Reorder Required Table */}
        {canSeeReorder && (
          <Card data-tour="dashboard-alerts">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                <div className="db-icon-block-sm bg-destructive/10">
                  <Package className="h-4 w-4 text-destructive" strokeWidth={2.2} />
                </div>
                <CardTitle className="db-card-title">{t('Reorder Required')}</CardTitle>
                {reorder.length > 0 && (
                  <Badge variant="destructive" className="ms-auto">{reorder.length}</Badge>
                )}
                <button
                  onClick={() => navigate('/inventory', { state: { tab: 'reorder' } })}
                  className="ms-2 db-view-all-btn"
                >
                  {t('View All')} <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {reorder.length === 0 ? (
                <EmptyState message={t('All items in stock')} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="db-th">{t('Product')}</TableHead>
                      <TableHead className="db-th text-end">{t('Stock')}</TableHead>
                      <TableHead className="db-th text-end">{t('Velocity/day')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reorder.slice(0, 5).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-bold text-[14px]">{item.name}</TableCell>
                        <TableCell className="text-end tabular-nums font-bold text-[14px]">
                          {formatQuantity(item.current_stock_base, item.parent_unit, item.child_unit, item.conversion_factor)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums text-[13px]">{item.daily_velocity_base.toFixed(1)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Upcoming Payments */}
        {canSeePurchases && upcomingSummary && upcomingSummary.count > 0 && (
          <Card className="border-s-[3px] border-s-accent">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                <div className="db-icon-block-sm bg-accent/10">
                  <Clock className="h-4 w-4 text-accent" strokeWidth={2.2} />
                </div>
                <CardTitle className="db-card-title">{t('Upcoming Payments')}</CardTitle>
                <Badge variant="warning" className="ms-auto">{upcomingSummary.count}</Badge>
                <button onClick={() => navigate('/purchases', { state: { tab: 'aging' } })} className="ms-2 db-view-all-btn">
                  {t('View All')} <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between rounded-md bg-accent/5 p-4">
                <div>
                  <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-muted-foreground">
                    {upcomingSummary.count} {t('upcoming installments')}
                  </p>
                  <p className="mt-1.5 text-[28px] font-black leading-none text-accent">
                    <AnimatedNumber value={upcomingSummary.total} duration={700} />
                    <span className="ms-1 text-[12px] font-bold text-accent/50">SDG</span>
                  </p>
                </div>
                <div className="db-icon-block bg-accent/10">
                  <Clock className="h-6 w-6 text-accent" strokeWidth={1.8} />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Overdue Payments */}
        {canSeePurchases && overdueSummary && overdueSummary.count > 0 && (
          <Card className="border-s-[3px] border-s-destructive">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                <div className="db-icon-block-sm bg-destructive/10">
                  <CreditCard className="h-4 w-4 text-destructive" strokeWidth={2.2} />
                </div>
                <CardTitle className="db-card-title">{t('Overdue Payments')}</CardTitle>
                <Badge variant="destructive" className="ms-auto">{overdueSummary.count}</Badge>
                <button onClick={() => navigate('/purchases', { state: { tab: 'aging' } })} className="ms-2 db-view-all-btn">
                  {t('View All')} <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between rounded-md bg-destructive/5 p-4">
                <div>
                  <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-muted-foreground">
                    {overdueSummary.count} {t('overdue installments')}
                  </p>
                  <p className="mt-1.5 text-[28px] font-black leading-none text-destructive">
                    <AnimatedNumber value={overdueSummary.total} duration={700} />
                    <span className="ms-1 text-[12px] font-bold text-destructive/50">SDG</span>
                  </p>
                </div>
                <div className="db-icon-block bg-destructive/10">
                  <AlertTriangle className="h-6 w-6 text-destructive" strokeWidth={1.8} />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
