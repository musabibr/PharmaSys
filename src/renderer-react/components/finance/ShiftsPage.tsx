import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { useShiftStore } from '@/stores/shift.store';
import { useAuthStore } from '@/stores/auth.store';
import type { Shift, ShiftExpectedCash } from '@/api/types';
import { formatCurrency, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DataPagination } from '@/components/ui/data-pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Clock,
  Play,
  Lock,
  Banknote,
  ArrowDownToLine,
  CalendarDays,
  Filter,
  TrendingDown,
  TrendingUp,
  CheckCircle,
  AlertTriangle,
  User,
  Plus,
  Minus,
  Equal,
  Printer,
} from 'lucide-react';
import { CloseShiftDialog } from './CloseShiftDialog';
import { CashDropDialog } from './CashDropDialog';
import { printHtml } from '@/lib/print';
import { usePermission } from '@/hooks/usePermission';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function calcDuration(openedAt: string, closedAt: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const start = new Date(openedAt).getTime();
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return t('{{hours}}h {{minutes}}m', { hours, minutes });
  }
  return t('{{minutes}}m', { minutes });
}

function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

function defaultEndDate(): string {
  return new Date().toISOString().split('T')[0];
}

function varianceBadge(
  varianceType: string | null,
  variance: number | null,
  t: (key: string) => string
): React.ReactNode {
  if (varianceType === 'shortage') {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <TrendingDown className="h-3.5 w-3.5" />
        {formatCurrency(Math.abs(variance ?? 0))}
      </span>
    );
  }
  if (varianceType === 'overage') {
    return (
      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
        <TrendingUp className="h-3.5 w-3.5" />
        {formatCurrency(variance ?? 0)}
      </span>
    );
  }
  if (varianceType === 'balanced') {
    return (
      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <CheckCircle className="h-3.5 w-3.5" />
        {t('Balanced')}
      </span>
    );
  }
  return <span className="text-muted-foreground">{'\u2014'}</span>;
}

// ---------------------------------------------------------------------------
// CashDrop type (from api.cashDrops.getByShift — untyped in API)
// ---------------------------------------------------------------------------

interface CashDrop {
  id: number;
  amount: number;
  reason: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// OpenShiftDialog (inline, simple)
// ---------------------------------------------------------------------------

interface OpenShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function OpenShiftDialog({ open, onOpenChange }: OpenShiftDialogProps) {
  const { t } = useTranslation();
  const openShift = useShiftStore((s) => s.openShift);

  const [amount, setAmount] = useState('');
  const [lastCash, setLastCash] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingLast, setFetchingLast] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;

    setError('');
    setLoading(false);
    setFetchingLast(true);

    let cancelled = false;

    (async () => {
      try {
        const cash = await api.shifts.getLastCash();
        if (cancelled) return;
        setLastCash(cash);
        if (cash !== null && cash > 0) {
          setAmount(String(cash));
        } else {
          setAmount('');
        }
      } catch {
        if (!cancelled) {
          setLastCash(null);
          setAmount('');
        }
      } finally {
        if (!cancelled) setFetchingLast(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const parsed = parseInt(amount, 10);
    if (isNaN(parsed) || parsed < 0) {
      setError(t('Please enter a valid opening amount'));
      return;
    }

    setError('');
    setLoading(true);
    try {
      await openShift(parsed);
      toast.success(t('Shift opened successfully'));
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('Failed to open shift');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-5 w-5" />
            {t('Open New Shift')}
          </DialogTitle>
          <DialogDescription>
            {t('Enter the opening cash amount for this shift.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="shift-opening-amount">{t('Opening Amount')} (SDG)</Label>
            <Input
              id="shift-opening-amount"
              type="number"
              step="1"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              disabled={loading || fetchingLast}
              autoFocus
            />
            {lastCash !== null && lastCash > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('Last closing amount')}: {formatCurrency(lastCash)}
              </p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={loading || fetchingLast}>
              {loading ? t('Opening...') : t('Open Shift')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ShiftReportSheet
// ---------------------------------------------------------------------------

interface ShiftReportSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift: Shift | null;
}

function ShiftReportSheet({ open, onOpenChange, shift }: ShiftReportSheetProps) {
  const { t } = useTranslation();

  const [expected, setExpected] = useState<ShiftExpectedCash | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !shift) return;

    let cancelled = false;
    setLoading(true);
    setError('');

    (async () => {
      try {
        const data = await api.shifts.getExpectedCash(shift.id);
        if (!cancelled) setExpected(data);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('Failed to load shift report'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, shift, t]);

  if (!shift) return null;

  const duration = calcDuration(shift.opened_at, shift.closed_at, t);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5" />
            {t('Shift Report')} #{shift.id}
          </SheetTitle>
          <SheetDescription>
            {t('Detailed breakdown for this shift.')}
          </SheetDescription>
        </SheetHeader>

        <Separator className="my-2" />

        <ScrollArea className="flex-1">
          <div className="space-y-5 px-1 pb-4">
            {/* Shift Info */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground">{t('Shift Info')}</h3>
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Opened By')}</span>
                  <span className="font-medium">{shift.username ?? `User #${shift.user_id}`}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Opened At')}</span>
                  <span className="tabular-nums">{formatDateTime(shift.opened_at)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Closed At')}</span>
                  <span className="tabular-nums">
                    {shift.closed_at ? formatDateTime(shift.closed_at) : t('Still open')}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Duration')}</span>
                  <span>{duration}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Status')}</span>
                  <Badge variant={shift.status === 'open' ? 'success' : 'secondary'}>
                    {shift.status === 'open' ? t('Open') : t('Closed')}
                  </Badge>
                </div>
              </div>
            </div>

            {/* Cash Breakdown */}
            {loading && (
              <div className="space-y-3">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="flex justify-between">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                ))}
              </div>
            )}

            {error && !loading && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-center">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}

            {!loading && expected && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  {t('Cash Breakdown')}
                </h3>
                <div className="rounded-lg border p-3 space-y-1">
                  <ReportRow label={t('Opening Amount')} amount={expected.opening_amount} />
                  <ReportRow
                    label={t('Cash Sales')}
                    amount={expected.total_cash_sales}
                    sign="+"
                  />
                  <ReportRow
                    label={t('Cash Returns')}
                    amount={expected.total_cash_returns}
                    sign="-"
                  />
                  <ReportRow
                    label={t('Cash Expenses')}
                    amount={expected.total_cash_expenses}
                    sign="-"
                  />
                  <ReportRow
                    label={t('Cash Withdrawals')}
                    amount={expected.total_cash_drops}
                    sign="-"
                  />
                  <Separator className="my-1.5" />
                  <ReportRow
                    label={t('Expected Cash')}
                    amount={expected.expected_cash}
                    sign="="
                    bold
                    highlight
                  />
                </div>
              </div>
            )}

            {/* Actual / Variance (closed shifts only) */}
            {shift.status === 'closed' && shift.actual_cash !== null && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  {t('Closing Result')}
                </h3>
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Actual Cash')}</span>
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(shift.actual_cash)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Variance')}</span>
                    {varianceBadge(shift.variance_type, shift.variance, t)}
                  </div>
                  {shift.notes && (
                    <div className="pt-1">
                      <p className="text-xs text-muted-foreground">{t('Notes')}:</p>
                      <p className="text-sm">{shift.notes}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <Separator className="my-2" />
        <div className="flex justify-end px-1 pb-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              const rows = [
                { label: t('Opened By'), value: shift.username ?? `User #${shift.user_id}` },
                { label: t('Opened At'), value: formatDateTime(shift.opened_at) },
                { label: t('Closed At'), value: shift.closed_at ? formatDateTime(shift.closed_at) : t('Still open') },
                { label: t('Duration'), value: duration },
                { label: t('Status'), value: shift.status === 'open' ? t('Open') : t('Closed') },
              ];
              const cashRows = expected ? [
                { label: t('Opening Amount'), value: formatCurrency(expected.opening_amount) },
                { label: `+ ${t('Cash Sales')}`, value: formatCurrency(expected.total_cash_sales) },
                { label: `- ${t('Cash Returns')}`, value: formatCurrency(expected.total_cash_returns) },
                { label: `- ${t('Cash Expenses')}`, value: formatCurrency(expected.total_cash_expenses) },
                { label: `- ${t('Cash Withdrawals')}`, value: formatCurrency(expected.total_cash_drops) },
                { label: t('Expected Cash'), value: formatCurrency(expected.expected_cash) },
              ] : [];
              const closingRows = shift.status === 'closed' && shift.actual_cash !== null ? [
                { label: t('Actual Cash'), value: formatCurrency(shift.actual_cash) },
                { label: t('Variance'), value: shift.variance_type === 'shortage'
                    ? `-${formatCurrency(Math.abs(shift.variance ?? 0))}`
                    : shift.variance_type === 'overage'
                      ? `+${formatCurrency(shift.variance ?? 0)}`
                      : t('Balanced') },
              ] : [];

              const html = `
                <div class="header">
                  <h2>${t('Shift Report')} #${shift.id}</h2>
                </div>
                <div class="summary">
                  ${rows.map(r => `<p><strong>${r.label}:</strong> ${r.value}</p>`).join('')}
                </div>
                ${cashRows.length > 0 ? `
                  <h3>${t('Cash Breakdown')}</h3>
                  <table>
                    ${cashRows.map(r => `<tr><td>${r.label}</td><td class="num">${r.value}</td></tr>`).join('')}
                  </table>
                ` : ''}
                ${closingRows.length > 0 ? `
                  <h3>${t('Closing Result')}</h3>
                  <table>
                    ${closingRows.map(r => `<tr><td>${r.label}</td><td class="num">${r.value}</td></tr>`).join('')}
                  </table>
                ` : ''}
                ${shift.notes ? `<p><strong>${t('Notes')}:</strong> ${shift.notes}</p>` : ''}
              `;
              printHtml(html);
            }}
          >
            <Printer className="h-3.5 w-3.5" />
            {t('Print')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- Inline ReportRow for the Sheet ----
function ReportRow({
  label,
  amount,
  sign,
  bold,
  highlight,
}: {
  label: string;
  amount: number;
  sign?: '+' | '-' | '=';
  bold?: boolean;
  highlight?: boolean;
}) {
  const signIcon =
    sign === '+' ? <Plus className="h-3.5 w-3.5 text-emerald-500" /> :
    sign === '-' ? <Minus className="h-3.5 w-3.5 text-destructive" /> :
    sign === '=' ? <Equal className="h-3.5 w-3.5 text-primary" /> :
    null;

  return (
    <div
      className={cn(
        'flex items-center justify-between py-1.5',
        highlight && 'rounded-md bg-muted/50 px-2 -mx-2',
        bold && 'font-semibold'
      )}
    >
      <span className="flex items-center gap-2 text-sm">
        {signIcon}
        {label}
      </span>
      <span className={cn('tabular-nums text-sm', bold && 'font-bold')}>
        {formatCurrency(amount)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CurrentShiftCard
// ---------------------------------------------------------------------------

interface CurrentShiftCardProps {
  onOpenShift: () => void;
  onCloseShift: () => void;
  onCashDrop: () => void;
}

function CurrentShiftCard({ onOpenShift, onCloseShift, onCashDrop }: CurrentShiftCardProps) {
  const { t } = useTranslation();
  const currentShift = useShiftStore((s) => s.currentShift);
  const isLoading = useShiftStore((s) => s.isLoading);
  const canOpen = usePermission('finance.shifts.manage');
  const canClose = usePermission('finance.shifts.close');
  const canCashDrop = usePermission('finance.cash_drops.manage');

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-60" />
            <Skeleton className="h-4 w-48" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!currentShift) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-10 text-center">
          <Clock className="mb-3 h-12 w-12 text-muted-foreground/40" />
          <p className="text-lg font-medium text-muted-foreground">
            {t('No shift is currently open')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            {t('No active shift. Start a shift to begin tracking sales.')}
          </p>
          {canOpen && (
            <Button onClick={onOpenShift} className="mt-4 gap-2" data-tour="shift-open">
              <Play className="h-4 w-4" />
              {t('Open Shift')}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const duration = calcDuration(currentShift.opened_at, null, t);

  return (
    <Card className="border-emerald-500/50 bg-emerald-50/30 dark:bg-emerald-950/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="h-5 w-5 text-emerald-600" />
            {t('Current Shift')}
          </CardTitle>
          <Badge variant="success">{t('Open')}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Shift details grid */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">{t('Opened By')}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm font-medium">
              <User className="h-3.5 w-3.5" />
              {currentShift.username ?? `User #${currentShift.user_id}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('Opened At')}</p>
            <p className="mt-0.5 text-sm font-medium tabular-nums">
              {formatDateTime(currentShift.opened_at)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('Opening Amount')}</p>
            <p className="mt-0.5 text-sm font-medium tabular-nums">
              {formatCurrency(currentShift.opening_amount)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('Duration')}</p>
            <p className="mt-0.5 text-sm font-medium">{duration}</p>
          </div>
        </div>

        {/* Actions */}
        {(canClose || canCashDrop) && (
          <div className="flex flex-wrap gap-2">
            {canCashDrop && (
              <Button variant="outline" onClick={onCashDrop} className="gap-2">
                <ArrowDownToLine className="h-4 w-4" />
                {t('Cash Withdrawal')}
              </Button>
            )}
            {canClose && (
              <Button variant="default" onClick={onCloseShift} className="gap-2" data-tour="shift-close">
                <Lock className="h-4 w-4" />
                {t('Close Shift')}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CashDropsCard
// ---------------------------------------------------------------------------

interface CashDropsCardProps {
  refreshKey: number;
}

function CashDropsCard({ refreshKey }: CashDropsCardProps) {
  const { t } = useTranslation();
  const currentShift = useShiftStore((s) => s.currentShift);

  const [drops, setDrops] = useState<CashDrop[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchDrops = useCallback(async () => {
    if (!currentShift) return;
    setLoading(true);
    try {
      const data = await api.cashDrops.getByShift(currentShift.id);
      const items = Array.isArray(data) ? (data as CashDrop[]) : [];
      setDrops(items);
    } catch {
      setDrops([]);
    } finally {
      setLoading(false);
    }
  }, [currentShift]);

  useEffect(() => {
    fetchDrops();
  }, [fetchDrops, refreshKey]);

  if (!currentShift) return null;

  const total = drops.reduce((sum, d) => sum + (d.amount || 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">{t('Cash Withdrawals')}</CardTitle>
          {drops.length > 0 && (
            <Badge variant="secondary" className="ms-auto">
              {drops.length}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="space-y-2">
            {[1, 2].map((n) => (
              <Skeleton key={n} className="h-8 w-full" />
            ))}
          </div>
        )}

        {!loading && drops.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('No cash withdrawals recorded for this shift.')}
          </div>
        )}

        {!loading && drops.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Time')}</TableHead>
                  <TableHead>{t('Amount')}</TableHead>
                  <TableHead>{t('Reason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drops.map((drop) => (
                  <TableRow key={drop.id}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatTime(drop.created_at)}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {formatCurrency(drop.amount)}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {drop.reason || '\u2014'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Separator className="my-2" />
            <div className="flex justify-between text-sm font-semibold">
              <span>{t('Total Cash Withdrawals')}</span>
              <span className="tabular-nums">{formatCurrency(total)}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ShiftHistorySection
// ---------------------------------------------------------------------------

interface ShiftHistorySectionProps {
  onSelectShift: (shift: Shift) => void;
  refreshKey: number;
}

function ShiftHistorySection({ onSelectShift, refreshKey }: ShiftHistorySectionProps) {
  const { t } = useTranslation();

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [userFilter, setUserFilter] = useState('all');
  const [users, setUsers] = useState<Array<{ id: number; username: string }>>([]);

  // Fetch users for filter dropdown
  useEffect(() => {
    (async () => {
      try {
        const list = await api.users.getAll();
        setUsers(list.map((u: { id: number; username: string }) => ({ id: u.id, username: u.username })));
      } catch { /* ignore */ }
    })();
  }, []);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 15;

  const fetchShifts = useCallback(async () => {
    setLoading(true);
    try {
      const filters: Record<string, unknown> = { page, limit: PAGE_SIZE };
      if (startDate) filters.start_date = startDate;
      if (endDate) filters.end_date = endDate;
      if (statusFilter !== 'all') filters.status = statusFilter;
      if (userFilter !== 'all') filters.user_id = Number(userFilter);

      const result = await api.shifts.getAll(filters);
      setShifts(Array.isArray(result.data) ? result.data : []);
      setTotalPages(result.totalPages || 1);
      setTotal(result.total ?? 0);
    } catch {
      toast.error(t('Failed to load shift history'));
      setShifts([]);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, statusFilter, userFilter, page, t]);

  useEffect(() => {
    fetchShifts();
  }, [fetchShifts, refreshKey]);

  function handleApply() {
    setPage(1);
    fetchShifts();
  }

  function handlePrint() {
    if (shifts.length === 0) return;

    const rows = shifts.map((s) => {
      const duration = calcDuration(s.opened_at, s.closed_at, t);
      const variance = s.variance_type === 'shortage'
        ? `<span style="color:#dc2626">-${formatCurrency(Math.abs(s.variance ?? 0))}</span>`
        : s.variance_type === 'overage'
          ? `<span style="color:#d97706">+${formatCurrency(s.variance ?? 0)}</span>`
          : s.variance_type === 'balanced'
            ? `<span style="color:#16a34a">${t('Balanced')}</span>`
            : '\u2014';
      return `<tr>
        <td class="num">${s.id}</td>
        <td>${s.username ?? `User #${s.user_id}`}</td>
        <td>${formatDateTime(s.opened_at)}</td>
        <td>${formatDateTime(s.closed_at)}</td>
        <td>${duration}</td>
        <td class="num">${formatCurrency(s.opening_amount)}</td>
        <td class="num">${s.actual_cash !== null ? formatCurrency(s.actual_cash) : '\u2014'}</td>
        <td class="num">${variance}</td>
        <td>${s.status === 'open' ? t('Open') : t('Closed')}</td>
      </tr>`;
    }).join('');

    const filterInfo = `${startDate} — ${endDate}`;

    const html = `
      <div class="header">
        <h2>${t('Shift History')}</h2>
        <span>${filterInfo}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>${t('Opened By')}</th>
            <th>${t('Opened At')}</th>
            <th>${t('Closed At')}</th>
            <th>${t('Duration')}</th>
            <th>${t('Opening')}</th>
            <th>${t('Closing')}</th>
            <th>${t('Variance')}</th>
            <th>${t('Status')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    printHtml(html);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">{t('Shift History')}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter bar */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('From')}</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('To')}</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('Status')}</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as 'all' | 'open' | 'closed')}
            >
              <SelectTrigger className="h-9 w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All')}</SelectItem>
                <SelectItem value="open">{t('Open')}</SelectItem>
                <SelectItem value="closed">{t('Closed')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('User')}</Label>
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All')}</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={handleApply} className="h-9 gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            {t('Apply')}
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrint} disabled={shifts.length === 0} className="h-9 gap-1.5">
            <Printer className="h-3.5 w-3.5" />
            {t('Print')}
          </Button>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && shifts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <CalendarDays className="mb-2 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium">{t('No shifts found')}</p>
          </div>
        )}

        {/* Table */}
        {!loading && shifts.length > 0 && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]">#</TableHead>
                  <TableHead>{t('Opened By')}</TableHead>
                  <TableHead>{t('Opened At')}</TableHead>
                  <TableHead>{t('Closed At')}</TableHead>
                  <TableHead>{t('Duration')}</TableHead>
                  <TableHead className="text-end">{t('Opening')}</TableHead>
                  <TableHead className="text-end">{t('Closing')}</TableHead>
                  <TableHead className="text-end">{t('Variance')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts.map((shift) => (
                  <TableRow
                    key={shift.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => onSelectShift(shift)}
                  >
                    <TableCell className="font-medium tabular-nums">{shift.id}</TableCell>
                    <TableCell>{shift.username ?? `User #${shift.user_id}`}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatDateTime(shift.opened_at)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatDateTime(shift.closed_at)}
                    </TableCell>
                    <TableCell>
                      {calcDuration(shift.opened_at, shift.closed_at, t)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatCurrency(shift.opening_amount)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {shift.actual_cash !== null
                        ? formatCurrency(shift.actual_cash)
                        : '\u2014'}
                    </TableCell>
                    <TableCell className="text-end">
                      {varianceBadge(shift.variance_type, shift.variance, t)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={shift.status === 'open' ? 'success' : 'secondary'}>
                        {shift.status === 'open' ? t('Open') : t('Closed')}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        <DataPagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          className="mt-2"
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ShiftsPage — main export
// ---------------------------------------------------------------------------

export function ShiftsPage() {
  const { t } = useTranslation();
  const loadCurrentShift = useShiftStore((s) => s.loadCurrentShift);

  // Dialog/Sheet state
  const [openShiftOpen, setOpenShiftOpen] = useState(false);
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);
  const [cashDropOpen, setCashDropOpen] = useState(false);
  const [reportShift, setReportShift] = useState<Shift | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  // Refresh counter — bump to re-fetch child components
  const [refreshKey, setRefreshKey] = useState(0);

  // Ensure current shift is loaded on mount
  useEffect(() => {
    loadCurrentShift();
  }, [loadCurrentShift]);

  function handleShiftAction() {
    loadCurrentShift();
    setRefreshKey((k) => k + 1);
  }

  function handleSelectShift(shift: Shift) {
    setReportShift(shift);
    setReportOpen(true);
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('Shifts')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('Manage shift operations, cash withdrawals, and review shift history.')}
        </p>
      </div>

      {/* Current Shift Card */}
      <div data-tour="shift-status">
        <CurrentShiftCard
          onOpenShift={() => setOpenShiftOpen(true)}
          onCloseShift={() => setCloseShiftOpen(true)}
          onCashDrop={() => setCashDropOpen(true)}
        />
      </div>

      {/* Cash Drops (only if shift is open) */}
      <CashDropsCard refreshKey={refreshKey} />

      {/* Shift History */}
      <ShiftHistorySection
        onSelectShift={handleSelectShift}
        refreshKey={refreshKey}
      />

      {/* ---- Dialogs & Sheets ---- */}
      <OpenShiftDialog
        open={openShiftOpen}
        onOpenChange={(v) => {
          setOpenShiftOpen(v);
          if (!v) handleShiftAction();
        }}
      />

      <CloseShiftDialog
        open={closeShiftOpen}
        onOpenChange={setCloseShiftOpen}
        onComplete={handleShiftAction}
      />

      <CashDropDialog
        open={cashDropOpen}
        onOpenChange={setCashDropOpen}
        onComplete={() => {
          setRefreshKey((k) => k + 1);
        }}
      />

      <ShiftReportSheet
        open={reportOpen}
        onOpenChange={setReportOpen}
        shift={reportShift}
      />
    </div>
  );
}
