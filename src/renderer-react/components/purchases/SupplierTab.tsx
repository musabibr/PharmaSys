import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ChevronDown, ChevronRight, Building2, FileText,
  CheckCircle, Clock, CreditCard, Loader2, Search,
  AlertTriangle,
} from 'lucide-react';
import { api } from '@/api';
import type { Purchase, PurchasePayment, Supplier, ExpensePaymentMethod, PaymentAdjustmentStrategy } from '@/api/types';
import { Input } from '@/components/ui/input';
import { formatCurrency, formatDate, displayInvoiceId, cn } from '@/lib/utils';
import { useApiCall } from '@/api/hooks';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default',
  partial: 'secondary',
  unpaid: 'destructive',
};

interface SupplierWithTotals extends Supplier {
  totalDebt: number;
  totalPaid: number;
  invoiceCount: number;
}

type StatusFilter = 'all' | 'has_remaining' | 'fully_paid';
type SortBy = 'remaining' | 'name' | 'total';

export function SupplierTab() {
  const { t } = useTranslation();
  const canPay = usePermission('purchases.pay');
  const { data: suppliers, loading: suppliersLoading } = useApiCall(() => api.suppliers.getAll(), []);
  const [supplierData, setSupplierData] = useState<SupplierWithTotals[]>([]);
  const [expandedSupplier, setExpandedSupplier] = useState<number | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loadingPurchases, setLoadingPurchases] = useState(false);
  const [expandedPurchase, setExpandedPurchase] = useState<number | null>(null);
  const [purchaseDetail, setPurchaseDetail] = useState<Purchase | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [payingId, setPayingId] = useState<number | null>(null);
  // Per-payment state keyed by payment.id
  const [payMethods, setPayMethods] = useState<Record<number, ExpensePaymentMethod>>({});
  const [payRefs, setPayRefs] = useState<Record<number, string>>({});
  const [paidAmounts, setPaidAmounts] = useState<Record<number, number | null>>({});
  const [adjustmentStrategies, setAdjustmentStrategies] = useState<Record<number, PaymentAdjustmentStrategy>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('remaining');
  const debouncedSearch = useDebounce(searchQuery, 250);

  // Load all purchases to compute supplier totals
  useEffect(() => {
    if (!suppliers || suppliers.length === 0) {
      setSupplierData([]);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Fetch all purchases (large limit to get them all for summary)
        const result = await api.purchases.getAll({ limit: 9999 });
        if (cancelled) return;
        const all = Array.isArray(result.data) ? result.data : [];

        const map = new Map<number, { totalDebt: number; totalPaid: number; count: number }>();
        for (const p of all) {
          if (!p.supplier_id) continue;
          const entry = map.get(p.supplier_id) ?? { totalDebt: 0, totalPaid: 0, count: 0 };
          entry.totalDebt += p.total_amount;
          entry.totalPaid += p.total_paid;
          entry.count += 1;
          map.set(p.supplier_id, entry);
        }

        const enriched: SupplierWithTotals[] = suppliers
          .filter(s => map.has(s.id))
          .map(s => {
            const d = map.get(s.id)!;
            return {
              ...s,
              totalDebt: d.totalDebt,
              totalPaid: d.totalPaid,
              invoiceCount: d.count,
            };
          });

        setSupplierData(enriched);
      } catch {
        setSupplierData([]);
      }
    })();

    return () => { cancelled = true; };
  }, [suppliers, refreshKey]);

  // Filtered + sorted suppliers
  const filteredSuppliers = useMemo(() => {
    let list = supplierData;

    // Search filter
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.phone && s.phone.includes(q)) ||
        (s.address && s.address.toLowerCase().includes(q))
      );
    }

    // Status filter
    if (statusFilter === 'has_remaining') {
      list = list.filter(s => s.totalDebt - s.totalPaid > 0);
    } else if (statusFilter === 'fully_paid') {
      list = list.filter(s => s.totalDebt - s.totalPaid <= 0);
    }

    // Sort
    const sorted = [...list];
    if (sortBy === 'remaining') {
      sorted.sort((a, b) => (b.totalDebt - b.totalPaid) - (a.totalDebt - a.totalPaid));
    } else if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'total') {
      sorted.sort((a, b) => b.totalDebt - a.totalDebt);
    }

    return sorted;
  }, [supplierData, debouncedSearch, statusFilter, sortBy]);

  // Stats
  const totalRemaining = useMemo(() =>
    supplierData.reduce((sum, s) => sum + Math.max(0, s.totalDebt - s.totalPaid), 0),
    [supplierData]
  );
  const suppliersWithDebt = useMemo(() =>
    supplierData.filter(s => s.totalDebt - s.totalPaid > 0).length,
    [supplierData]
  );

  // When a supplier is expanded, load their purchases
  const handleToggleSupplier = useCallback(async (supplierId: number) => {
    if (expandedSupplier === supplierId) {
      setExpandedSupplier(null);
      setPurchases([]);
      setExpandedPurchase(null);
      setPurchaseDetail(null);
      return;
    }

    setExpandedSupplier(supplierId);
    setExpandedPurchase(null);
    setPurchaseDetail(null);
    setLoadingPurchases(true);

    try {
      const result = await api.purchases.getAll({ supplier_id: supplierId, limit: 9999 });
      setPurchases(Array.isArray(result.data) ? result.data : []);
    } catch {
      setPurchases([]);
    } finally {
      setLoadingPurchases(false);
    }
  }, [expandedSupplier]);

  // When an invoice is expanded, load its details (with payments)
  const handleTogglePurchase = useCallback(async (purchaseId: number) => {
    if (expandedPurchase === purchaseId) {
      setExpandedPurchase(null);
      setPurchaseDetail(null);
      return;
    }

    setExpandedPurchase(purchaseId);
    setLoadingDetail(true);

    try {
      const detail = await api.purchases.getById(purchaseId);
      setPurchaseDetail(detail);
    } catch {
      setPurchaseDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [expandedPurchase]);

  const handleMarkPaid = useCallback(async (payment: PurchasePayment) => {
    const method = payMethods[payment.id] ?? 'cash';
    const ref = payRefs[payment.id] ?? '';
    if (method === 'bank_transfer' && !ref.trim()) {
      toast.error(t('Reference number is required for bank transfers'));
      return;
    }
    const rawAmount = paidAmounts[payment.id] ?? payment.amount;
    const effectiveAmount = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : payment.amount;
    // Block overpayment on last remaining installment (frontend guard — backend also validates)
    const unpaidCount = purchaseDetail?.payments?.filter(p => !p.is_paid).length ?? 0;
    if (unpaidCount === 1 && effectiveAmount > payment.amount) {
      toast.error(t('Cannot overpay the last remaining installment'));
      return;
    }
    const strategy = adjustmentStrategies[payment.id] ?? 'next';
    const amountDiffers = effectiveAmount !== payment.amount;
    setPayingId(payment.id);
    try {
      await api.purchases.markPaymentPaid(
        payment.id, method,
        method === 'bank_transfer' ? ref.trim() : undefined,
        amountDiffers ? effectiveAmount : undefined,
        amountDiffers ? strategy : undefined
      );
      toast.success(t('Payment marked as paid'));
      // Clean up per-payment state for this row
      setPayMethods(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
      setPayRefs(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
      setPaidAmounts(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
      setAdjustmentStrategies(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
      if (expandedPurchase) {
        const detail = await api.purchases.getById(expandedPurchase);
        setPurchaseDetail(detail);
      }
      if (expandedSupplier) {
        const result = await api.purchases.getAll({ supplier_id: expandedSupplier, limit: 9999 });
        setPurchases(Array.isArray(result.data) ? result.data : []);
      }
      setRefreshKey(k => k + 1);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to mark payment'));
    } finally {
      setPayingId(null);
    }
  }, [payMethods, payRefs, paidAmounts, adjustmentStrategies, expandedPurchase, expandedSupplier, t]);

  if (suppliersLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Filter Bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          {/* Search */}
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('Search supplier name, phone...')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-9 ps-9"
            />
          </div>

          {/* Status filter */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('Status')}</span>
            <Select value={statusFilter} onValueChange={v => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All Suppliers')}</SelectItem>
                <SelectItem value="has_remaining">{t('Has Remaining')}</SelectItem>
                <SelectItem value="fully_paid">{t('Fully Paid')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Sort */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('Sort By')}</span>
            <Select value={sortBy} onValueChange={v => setSortBy(v as SortBy)}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="remaining">{t('Remaining')}</SelectItem>
                <SelectItem value="name">{t('Name')}</SelectItem>
                <SelectItem value="total">{t('Total')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Summary badges */}
          <div className="ms-auto flex items-center gap-3 text-sm">
            {suppliersWithDebt > 0 && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {suppliersWithDebt} {t('with debt')}
              </Badge>
            )}
            {totalRemaining > 0 && (
              <span className="font-semibold tabular-nums text-destructive">
                {formatCurrency(totalRemaining)} {t('remaining')}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Supplier List */}
      {filteredSuppliers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Building2 className="mb-2 h-10 w-10" />
          <p>{debouncedSearch || statusFilter !== 'all' ? t('No suppliers match your filters') : t('No suppliers with purchases')}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3">
          <p className="text-xs text-muted-foreground px-1">
            {filteredSuppliers.length} {t('suppliers')}
            {filteredSuppliers.length !== supplierData.length && ` / ${supplierData.length} ${t('total')}`}
          </p>

          {filteredSuppliers.map(supplier => {
            const isExpanded = expandedSupplier === supplier.id;
            const remaining = supplier.totalDebt - supplier.totalPaid;

            return (
              <Card key={supplier.id} className="overflow-hidden">
                {/* Supplier Header */}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 p-4 text-start hover:bg-muted/50 transition-colors"
                  onClick={() => handleToggleSupplier(supplier.id)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{supplier.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {supplier.invoiceCount} {t('invoices')}
                      {supplier.phone && ` · ${supplier.phone}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="text-end">
                      <p className="text-xs text-muted-foreground">{t('Total')}</p>
                      <p className="font-medium tabular-nums">{formatCurrency(supplier.totalDebt)}</p>
                    </div>
                    <div className="text-end">
                      <p className="text-xs text-muted-foreground">{t('Paid')}</p>
                      <p className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(supplier.totalPaid)}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className="text-xs text-muted-foreground">{t('Remaining')}</p>
                      <p className={cn(
                        'font-bold tabular-nums',
                        remaining > 0 ? 'text-destructive' : 'text-muted-foreground'
                      )}>
                        {formatCurrency(remaining)}
                      </p>
                    </div>
                  </div>
                </button>

                {/* Expanded: Invoices for this supplier */}
                {isExpanded && (
                  <div className="border-t bg-muted/30 px-4 py-3">
                    {loadingPurchases ? (
                      <div className="space-y-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : purchases.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">{t('No purchases found')}</p>
                    ) : (
                      <div className="space-y-2">
                        {purchases.map(p => {
                          const isPurchaseExpanded = expandedPurchase === p.id;
                          const pRemaining = p.total_amount - p.total_paid;

                          return (
                            <div key={p.id} className="rounded-md border bg-background">
                              {/* Invoice row */}
                              <button
                                type="button"
                                className="flex w-full items-center gap-3 p-3 text-start text-sm hover:bg-muted/50 transition-colors"
                                onClick={() => handleTogglePurchase(p.id)}
                              >
                                {isPurchaseExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium">{displayInvoiceId(p)}</span>
                                </div>
                                <span className="text-xs text-muted-foreground">{formatDate(p.purchase_date)}</span>
                                <span className="tabular-nums">{formatCurrency(p.total_amount)}</span>
                                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                                  {formatCurrency(p.total_paid)}
                                </span>
                                <span className={cn(
                                  'tabular-nums font-medium',
                                  pRemaining > 0 ? 'text-destructive' : 'text-muted-foreground'
                                )}>
                                  {pRemaining > 0 ? formatCurrency(pRemaining) : '-'}
                                </span>
                                <Badge variant={STATUS_BADGE[p.payment_status] ?? 'secondary'} className="ms-1">
                                  {t(p.payment_status)}
                                </Badge>
                              </button>

                              {/* Expanded: Installments for this invoice */}
                              {isPurchaseExpanded && (
                                <div className="border-t px-3 py-2">
                                  {loadingDetail ? (
                                    <div className="space-y-1">
                                      <Skeleton className="h-8 w-full" />
                                      <Skeleton className="h-8 w-full" />
                                    </div>
                                  ) : purchaseDetail?.payments && purchaseDetail.payments.length > 0 ? (
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead className="h-8 text-xs w-10 text-center">#</TableHead>
                                          <TableHead className="h-8 text-xs">{t('Due Date')}</TableHead>
                                          <TableHead className="h-8 text-xs text-end">{t('Amount')}</TableHead>
                                          <TableHead className="h-8 text-xs">{t('Status')}</TableHead>
                                          <TableHead className="h-8 text-xs">{t('Paid Date')}</TableHead>
                                          <TableHead className="h-8 text-xs">{t('Reference Number')}</TableHead>
                                          {canPay && <TableHead className="h-8 text-xs text-end">{t('Action')}</TableHead>}
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {purchaseDetail.payments.map((payment, pIdx) => (
                                          <TableRow key={payment.id}>
                                            <TableCell className="py-1.5 text-sm text-center text-muted-foreground">{pIdx + 1}</TableCell>
                                            <TableCell className="py-1.5 text-sm">{formatDate(payment.due_date)}</TableCell>
                                            <TableCell className="py-1.5 text-sm text-end tabular-nums">
                                              {payment.is_paid && payment.paid_amount === 0
                                                ? <span className="text-[10px] text-muted-foreground">{t('Covered by overpayment')}</span>
                                                : payment.is_paid && payment.paid_amount != null && payment.paid_amount > 0 && payment.paid_amount !== payment.amount
                                                  ? <>{formatCurrency(payment.paid_amount)} <span className="text-[10px] text-muted-foreground">/ {formatCurrency(payment.amount)}</span></>
                                                  : formatCurrency(payment.amount)}
                                            </TableCell>
                                            <TableCell className="py-1.5 text-sm">
                                              {payment.is_paid ? (
                                                <span className="flex items-center gap-1 text-green-600">
                                                  <CheckCircle className="h-3 w-3" /> {t('Paid')}
                                                </span>
                                              ) : (
                                                <span className="flex items-center gap-1 text-amber-600">
                                                  <Clock className="h-3 w-3" /> {t('Pending')}
                                                </span>
                                              )}
                                            </TableCell>
                                            <TableCell className="py-1.5 text-sm">{formatDate(payment.paid_date) || '-'}</TableCell>
                                            <TableCell className="py-1.5 text-xs text-muted-foreground">{payment.reference_number ?? '-'}</TableCell>
                                            {canPay && (
                                              <TableCell className="py-1.5 text-end">
                                                {!payment.is_paid && (() => {
                                                  const unpaidCount = (purchaseDetail!.payments ?? []).filter(p => !p.is_paid).length;
                                                  const isLastUnpaid = unpaidCount === 1;
                                                  return (
                                                  <div className="flex flex-col items-end gap-1.5">
                                                    {/* Amount first — most important input */}
                                                    <div className="flex flex-col items-end gap-0.5">
                                                      <div className="flex items-center gap-1.5">
                                                        <span className="text-[10px] text-muted-foreground">{t('Amount to Pay')}:</span>
                                                        <Input
                                                          type="number"
                                                          className="h-7 w-24 text-xs tabular-nums"
                                                          value={paidAmounts[payment.id] ?? payment.amount}
                                                          onChange={e => {
                                                            const val = e.target.value === '' ? null : Number(e.target.value);
                                                            setPaidAmounts(prev => ({ ...prev, [payment.id]: val }));
                                                          }}
                                                          min={1}
                                                          max={isLastUnpaid ? payment.amount : undefined}
                                                        />
                                                      </div>
                                                      {isLastUnpaid && (
                                                        <span className="text-[10px] text-muted-foreground">{t('Last installment — cannot overpay')}</span>
                                                      )}
                                                    </div>
                                                    {/* Method + Reference */}
                                                    <div className="flex items-center gap-2">
                                                      <Select
                                                        value={payMethods[payment.id] ?? 'cash'}
                                                        onValueChange={v => {
                                                          setPayMethods(prev => ({ ...prev, [payment.id]: v as ExpensePaymentMethod }));
                                                          if (v !== 'bank_transfer') setPayRefs(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
                                                        }}
                                                      >
                                                        <SelectTrigger className="h-7 w-28 text-xs">
                                                          <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                          <SelectItem value="cash">{t('Cash')}</SelectItem>
                                                          <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                                                        </SelectContent>
                                                      </Select>
                                                    </div>
                                                    {(payMethods[payment.id] ?? 'cash') === 'bank_transfer' && (
                                                      <Input
                                                        className="h-7 w-40 text-xs"
                                                        value={payRefs[payment.id] ?? ''}
                                                        onChange={e => setPayRefs(prev => ({ ...prev, [payment.id]: e.target.value }))}
                                                        placeholder={t('Enter reference number')}
                                                      />
                                                    )}
                                                    {/* Strategy (conditional) */}
                                                    {!isLastUnpaid && paidAmounts[payment.id] != null && paidAmounts[payment.id] !== payment.amount && (() => {
                                                      const isOverpay = paidAmounts[payment.id]! > payment.amount;
                                                      return (
                                                        <Select
                                                          value={adjustmentStrategies[payment.id] ?? 'next'}
                                                          onValueChange={v => setAdjustmentStrategies(prev => ({ ...prev, [payment.id]: v as PaymentAdjustmentStrategy }))}
                                                        >
                                                          <SelectTrigger className="h-7 w-48 text-xs">
                                                            <SelectValue />
                                                          </SelectTrigger>
                                                          <SelectContent>
                                                            <SelectItem value="next">{t('Adjust next installment')}</SelectItem>
                                                            <SelectItem value="spread">{t('Spread among remaining')}</SelectItem>
                                                            {!isOverpay && (
                                                              <SelectItem value="new_installment">{t('Create new installment')}</SelectItem>
                                                            )}
                                                          </SelectContent>
                                                        </Select>
                                                      );
                                                    })()}
                                                    {/* Pay button — last (confirms action) */}
                                                    <Button
                                                      size="sm"
                                                      className="h-7 text-xs"
                                                      onClick={() => handleMarkPaid(payment)}
                                                      disabled={payingId === payment.id}
                                                    >
                                                      {payingId === payment.id ? (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                      ) : (
                                                        <CreditCard className="me-1 h-3 w-3" />
                                                      )}
                                                      {t('Pay')}
                                                    </Button>
                                                  </div>
                                                  );
                                                })()}
                                              </TableCell>
                                            )}
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  ) : (
                                    <p className="text-sm text-muted-foreground py-2">
                                      {t('No installments for this invoice')}
                                    </p>
                                  )}

                                  {purchaseDetail?.notes && (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      {t('Notes')}: {purchaseDetail.notes}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
