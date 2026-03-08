import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Transaction, TransactionType, PaymentMethod, User, Shift } from '@/api/types';
import { useAuthStore } from '@/stores/auth.store';
import { usePermission, useAnyPermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Search,
  RotateCcw,
  Filter,
  Eye,
  Ban,
  Undo2,
  TrendingUp,
  TrendingDown,
  DollarSign,
  FileText,
  Printer,
} from 'lucide-react';
import { printHtml } from '@/lib/print';
import { DataPagination } from '@/components/ui/data-pagination';
import { TransactionDetailSheet } from './TransactionDetailSheet';
import { ReturnDialog } from './ReturnDialog';
import { VoidDialog } from './VoidDialog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

function getDefaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().split('T')[0];
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return { from, to };
}

// ---------------------------------------------------------------------------
// Filter state interface
// ---------------------------------------------------------------------------

interface TransactionFilters {
  startDate: string;
  endDate: string;
  type: string;        // 'all' | TransactionType
  paymentMethod: string; // 'all' | PaymentMethod
  search: string;
  cashierId: string;   // '' = all
  shiftId: string;     // '' = all
  showVoided: boolean;
}

function createDefaultFilters(): TransactionFilters {
  const range = getDefaultDateRange();
  return {
    startDate: range.from,
    endDate: range.to,
    type: 'all',
    paymentMethod: 'all',
    search: '',
    cashierId: '',
    shiftId: '',
    showVoided: false,
  };
}

// ---------------------------------------------------------------------------
// TransactionsPage
// ---------------------------------------------------------------------------

export function TransactionsPage() {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.currentUser);
  const canVoid = usePermission('finance.transactions.void');
  const canReturnAll = usePermission('finance.transactions.return');
  const canReturnOwn = usePermission('finance.transactions.return_own');
  const canViewTotals = usePermission('finance.view_totals');

  // ---- Filter state ----
  const [filters, setFilters] = useState<TransactionFilters>(createDefaultFilters);
  const debouncedSearch = useDebounce(filters.search, 300);

  // ---- Filter options (users & shifts) ----
  const [users, setUsers] = useState<User[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);

  useEffect(() => {
    api.users.getAll().then((res) => setUsers(Array.isArray(res) ? res : [])).catch(() => {});
    api.shifts.getAll({ limit: 100 }).then((res) => {
      const list = Array.isArray((res as any).data) ? (res as any).data : [];
      setShifts(list);
    }).catch(() => {});
  }, []);

  // ---- Data state ----
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // ---- Detail sheet state ----
  const [detailTransactionId, setDetailTransactionId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // ---- Void / Return dialog state ----
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidTargetId, setVoidTargetId] = useState<number | null>(null);
  const [returnDialogOpen, setReturnDialogOpen] = useState(false);
  const [returnTargetId, setReturnTargetId] = useState<number | null>(null);

  // ---- Fetch transactions ----
  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const apiFilters: Record<string, unknown> = {
        start_date: filters.startDate,
        end_date: filters.endDate,
        page,
        limit: PAGE_SIZE,
      };
      if (filters.type !== 'all') apiFilters.transaction_type = filters.type;
      if (filters.paymentMethod !== 'all') apiFilters.payment_method = filters.paymentMethod;
      if (debouncedSearch.trim()) apiFilters.search = debouncedSearch.trim();
      if (filters.cashierId) apiFilters.user_id = Number(filters.cashierId);
      if (filters.shiftId) apiFilters.shift_id = Number(filters.shiftId);
      if (filters.showVoided) apiFilters.is_voided = true;

      const result = await api.transactions.getAll(apiFilters);
      setTransactions(Array.isArray(result.data) ? result.data : []);
      setTotalPages(result.totalPages ?? 1);
      setTotal(result.total ?? 0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load transactions'));
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }, [filters, debouncedSearch, page, t]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  // ---- Summary calculations ----
  const summary = useMemo(() => {
    let totalSales = 0;
    let totalReturns = 0;

    for (const txn of transactions) {
      if (txn.is_voided) continue;
      if (txn.transaction_type === 'sale') {
        totalSales += txn.total_amount;
      } else if (txn.transaction_type === 'return') {
        totalReturns += txn.total_amount;
      }
    }

    return {
      totalSales,
      totalReturns,
      netSales: totalSales - totalReturns,
    };
  }, [transactions]);

  // ---- Filter handlers ----
  function updateFilter<K extends keyof TransactionFilters>(key: K, value: TransactionFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  function handleApply() {
    setPage(1);
    fetchTransactions();
  }

  function handleReset() {
    setFilters(createDefaultFilters());
    setPage(1);
  }

  // ---- Action handlers ----
  function handleViewTransaction(id: number) {
    setDetailTransactionId(id);
    setDetailOpen(true);
  }

  function handleVoidTransaction(id: number) {
    setVoidTargetId(id);
    setVoidDialogOpen(true);
  }

  function handleReturnTransaction(id: number) {
    setReturnTargetId(id);
    setReturnDialogOpen(true);
  }

  function handleVoidComplete() {
    setVoidDialogOpen(false);
    setVoidTargetId(null);
    fetchTransactions();
  }

  function handleReturnComplete() {
    setReturnDialogOpen(false);
    setReturnTargetId(null);
    fetchTransactions();
  }

  // ---- Print handler ----
  function handlePrint() {
    if (transactions.length === 0) return;

    const rows = transactions
      .map((txn) => {
        let typeLabel: string = txn.transaction_type;
        let typeBadge = 'badge badge-green';
        if (txn.transaction_type === 'sale') {
          typeLabel = t('Sale');
          typeBadge = 'badge badge-green';
        } else if (txn.transaction_type === 'return') {
          typeLabel = t('Return');
          typeBadge = 'badge badge-yellow';
        } else if (txn.transaction_type === 'void') {
          typeLabel = t('Void');
          typeBadge = 'badge badge-red';
        }

        let paymentLabel = '\u2014';
        if (txn.payment_method === 'cash') paymentLabel = t('Cash');
        else if (txn.payment_method === 'bank_transfer') paymentLabel = t('Bank Transfer');
        else if (txn.payment_method === 'mixed') paymentLabel = t('Mixed');

        const statusLabel = txn.is_voided ? t('Voided') : t('Completed');
        const statusBadge = txn.is_voided ? 'badge badge-red' : 'badge badge-green';

        const cashAmt = txn.cash_tendered || 0;
        const bankAmt = (txn.total_amount || 0) - cashAmt;

        return `<tr>
          <td>${txn.transaction_number || '\u2014'}</td>
          <td style="white-space:nowrap">${formatDateTime(txn.created_at)}</td>
          <td>${txn.username || '\u2014'}</td>
          <td><span class="${typeBadge}">${typeLabel}</span></td>
          <td>${paymentLabel}</td>
          <td class="num">${cashAmt > 0 ? formatCurrency(cashAmt) : '\u2014'}</td>
          <td class="num">${bankAmt > 0 ? formatCurrency(bankAmt) : '\u2014'}</td>
          <td>${txn.bank_name || '\u2014'}</td>
          <td style="font-family:monospace;font-size:0.85em">${txn.reference_number || '\u2014'}</td>
          <td class="num">${formatCurrency(txn.total_amount)}</td>
          <td><span class="${statusBadge}">${statusLabel}</span></td>
        </tr>`;
      })
      .join('');

    const html = `
      <div class="header">
        <div>
          <h2>${t('Transactions Report')}</h2>
          <p>${filters.startDate} &mdash; ${filters.endDate}</p>
        </div>
      </div>
      <div class="summary">
        <p><strong>${t('Total Transactions')}:</strong> ${transactions.length}</p>
        <p><strong>${t('Total Sales')}:</strong> ${formatCurrency(summary.totalSales)}</p>
        <p><strong>${t('Total Returns')}:</strong> ${formatCurrency(summary.totalReturns)}</p>
        <p><strong>${t('Net Sales')}:</strong> ${formatCurrency(summary.netSales)}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>${t('#')}</th>
            <th>${t('Date')}</th>
            <th>${t('User')}</th>
            <th>${t('Type')}</th>
            <th>${t('Payment')}</th>
            <th class="num">${t('Cash')}</th>
            <th class="num">${t('Bank Amt')}</th>
            <th>${t('Bank')}</th>
            <th>${t('Reference')}</th>
            <th class="num">${t('Total')}</th>
            <th>${t('Status')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    printHtml(html);
  }

  // ---- Type badge variant mapping ----
  function getTypeBadgeVariant(type: TransactionType): 'default' | 'warning' | 'destructive' {
    switch (type) {
      case 'sale': return 'default';
      case 'return': return 'warning';
      case 'void': return 'destructive';
      default: return 'default';
    }
  }

  function getTypeLabel(type: TransactionType): string {
    switch (type) {
      case 'sale': return t('Sale');
      case 'return': return t('Return');
      case 'void': return t('Void');
      default: return type;
    }
  }

  function getPaymentLabel(method: PaymentMethod | null): string {
    switch (method) {
      case 'cash': return t('Cash');
      case 'bank_transfer': return t('Bank Transfer');
      case 'mixed': return t('Mixed');
      default: return '\u2014';
    }
  }

  function getPaymentBadgeVariant(method: PaymentMethod | null): 'secondary' | 'outline' {
    switch (method) {
      case 'cash': return 'secondary';
      case 'bank_transfer': return 'outline';
      case 'mixed': return 'outline';
      default: return 'secondary';
    }
  }

  // ---- Render ----
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* ---- Filter Bar ---- */}
      <Card data-tour="txn-filter">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            {/* Date range: From */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('From')}</Label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => updateFilter('startDate', e.target.value)}
                className="w-40"
              />
            </div>

            {/* Date range: To */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('To')}</Label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => updateFilter('endDate', e.target.value)}
                className="w-40"
              />
            </div>

            {/* Transaction type */}
            <div className="space-y-1.5">
              <Label className="text-xs">
                <Filter className="me-1 inline h-3 w-3" />
                {t('Type')}
              </Label>
              <Select
                value={filters.type}
                onValueChange={(v) => updateFilter('type', v)}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  <SelectItem value="sale">{t('Sale')}</SelectItem>
                  <SelectItem value="return">{t('Return')}</SelectItem>
                  <SelectItem value="void">{t('Void')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Payment method */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Payment')}</Label>
              <Select
                value={filters.paymentMethod}
                onValueChange={(v) => updateFilter('paymentMethod', v)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  <SelectItem value="cash">{t('Cash')}</SelectItem>
                  <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                  <SelectItem value="mixed">{t('Mixed')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Cashier */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Cashier')}</Label>
              <Select
                value={filters.cashierId || '__all__'}
                onValueChange={(v) => updateFilter('cashierId', v === '__all__' ? '' : v)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('All Cashiers')}</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Shift */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Shift')}</Label>
              <Select
                value={filters.shiftId || '__all__'}
                onValueChange={(v) => updateFilter('shiftId', v === '__all__' ? '' : v)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('All Shifts')}</SelectItem>
                  {shifts.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      #{s.id} — {s.status === 'open' ? t('Open') : t('Closed')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Show Voided */}
            <div className="flex items-center gap-2 self-end pb-1">
              <Switch
                id="show-voided"
                checked={filters.showVoided}
                onCheckedChange={(v) => updateFilter('showVoided', v)}
              />
              <Label htmlFor="show-voided" className="text-xs cursor-pointer">
                {t('Show Voided')}
              </Label>
            </div>

            {/* Search */}
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">{t('Search')}</Label>
              <div className="relative">
                <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filters.search}
                  onChange={(e) => updateFilter('search', e.target.value)}
                  placeholder={t('Transaction #, customer name...')}
                  className="ps-9"
                />
              </div>
            </div>

            {/* Apply */}
            <Button onClick={handleApply} className="shrink-0">
              <Filter className="me-1.5 h-4 w-4" />
              {t('Apply')}
            </Button>

            {/* Reset */}
            <Button variant="outline" onClick={handleReset} className="shrink-0">
              <RotateCcw className="me-1.5 h-4 w-4" />
              {t('Reset')}
            </Button>

            {/* Print */}
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrint}
              disabled={transactions.length === 0 || loading}
              className="shrink-0 gap-1.5"
            >
              <Printer className="h-4 w-4" />
              {t('Print')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ---- Summary Cards ---- */}
      {canViewTotals && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <TrendingUp className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Total Sales')}</p>
                <p className="text-lg font-bold tabular-nums">
                  {loading ? (
                    <Skeleton className="h-6 w-24" />
                  ) : (
                    formatCurrency(summary.totalSales)
                  )}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10">
                <TrendingDown className="h-5 w-5 text-warning" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Total Returns')}</p>
                <p className="text-lg font-bold tabular-nums">
                  {loading ? (
                    <Skeleton className="h-6 w-24" />
                  ) : (
                    formatCurrency(summary.totalReturns)
                  )}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
                <DollarSign className="h-5 w-5 text-success" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Net Sales')}</p>
                <p className="text-lg font-bold tabular-nums">
                  {loading ? (
                    <Skeleton className="h-6 w-24" />
                  ) : (
                    formatCurrency(summary.netSales)
                  )}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---- Transactions Table ---- */}
      <div data-tour="txn-list" className="flex-1 overflow-auto rounded-md border">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              {t('No transactions found')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              {t('Try adjusting your filters or date range.')}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('#')}</TableHead>
                <TableHead>{t('Date')}</TableHead>
                <TableHead>{t('User')}</TableHead>
                <TableHead>{t('Type')}</TableHead>
                <TableHead>{t('Payment')}</TableHead>
                <TableHead className="text-end">{t('Cash')}</TableHead>
                <TableHead className="text-end">{t('Bank Amt')}</TableHead>
                <TableHead>{t('Bank')}</TableHead>
                <TableHead>{t('Reference')}</TableHead>
                <TableHead className="text-end">{t('Total')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead className="text-end">{t('Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((txn) => (
                <TableRow key={txn.id} className={txn.is_voided ? 'opacity-50' : undefined}>
                  {/* # */}
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => handleViewTransaction(txn.id)}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {txn.transaction_number}
                    </button>
                  </TableCell>

                  {/* Date */}
                  <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                    {formatDateTime(txn.created_at)}
                  </TableCell>

                  {/* User */}
                  <TableCell className="text-sm">
                    {txn.username || '\u2014'}
                  </TableCell>

                  {/* Type */}
                  <TableCell>
                    <Badge variant={getTypeBadgeVariant(txn.transaction_type)}>
                      {getTypeLabel(txn.transaction_type)}
                    </Badge>
                  </TableCell>

                  {/* Payment */}
                  <TableCell>
                    {txn.payment_method ? (
                      <Badge variant={getPaymentBadgeVariant(txn.payment_method)}>
                        {getPaymentLabel(txn.payment_method)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{'\u2014'}</span>
                    )}
                  </TableCell>

                  {/* Cash */}
                  <TableCell className="text-end tabular-nums">
                    {(txn.cash_tendered || 0) > 0 ? (
                      <span className="text-green-600">{formatCurrency(txn.cash_tendered)}</span>
                    ) : (
                      <span className="text-muted-foreground">{'\u2014'}</span>
                    )}
                  </TableCell>

                  {/* Bank Amt */}
                  <TableCell className="text-end tabular-nums">
                    {(() => {
                      const bankAmt = (txn.total_amount || 0) - (txn.cash_tendered || 0);
                      return bankAmt > 0 ? (
                        <span className="text-blue-600">{formatCurrency(bankAmt)}</span>
                      ) : (
                        <span className="text-muted-foreground">{'\u2014'}</span>
                      );
                    })()}
                  </TableCell>

                  {/* Bank */}
                  <TableCell className="text-sm">
                    {txn.bank_name || '\u2014'}
                  </TableCell>

                  {/* Reference */}
                  <TableCell className="font-mono text-xs">
                    {txn.reference_number || '\u2014'}
                  </TableCell>

                  {/* Total */}
                  <TableCell className="text-end font-bold tabular-nums">
                    {formatCurrency(txn.total_amount)}
                  </TableCell>

                  {/* Status */}
                  <TableCell>
                    {txn.is_voided ? (
                      <Badge variant="destructive">{t('Voided')}</Badge>
                    ) : (
                      <Badge variant="success">{t('Completed')}</Badge>
                    )}
                  </TableCell>

                  {/* Actions */}
                  <TableCell className="text-end">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleViewTransaction(txn.id)}
                        title={t('View')}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>

                      {canVoid && txn.transaction_type === 'sale' && !txn.is_voided && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleVoidTransaction(txn.id)}
                          disabled={voidDialogOpen}
                          title={t('Void')}
                          className="text-destructive hover:text-destructive"
                        >
                          <Ban className="h-4 w-4" />
                        </Button>
                      )}

                      {txn.transaction_type === 'sale' && !txn.is_voided && (canReturnAll || (canReturnOwn && txn.user_id === currentUser?.id)) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleReturnTransaction(txn.id)}
                          title={t('Return')}
                          className="text-warning hover:text-warning"
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ---- Pagination ---- */}
      <DataPagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />

      {/* ---- Transaction Detail Sheet ---- */}
      <TransactionDetailSheet
        transactionId={detailTransactionId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onVoid={(id) => handleVoidTransaction(id)}
        onReturn={(id) => {
          // Close the sheet and open it again for the same transaction
          // to let the user see updated details after performing the return
          setDetailOpen(false);
          handleReturnTransaction(id);
        }}
      />

      {/* ---- Void Dialog ---- */}
      <VoidDialog
        transactionId={voidTargetId}
        open={voidDialogOpen}
        onOpenChange={setVoidDialogOpen}
        onComplete={handleVoidComplete}
      />

      {/* ---- Return Dialog ---- */}
      <ReturnDialog
        transactionId={returnTargetId}
        open={returnDialogOpen}
        onOpenChange={setReturnDialogOpen}
        onComplete={handleReturnComplete}
      />
    </div>
  );
}
