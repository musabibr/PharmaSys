import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Transaction, TransactionType, PaymentMethod } from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Receipt,
  Ban,
  Undo2,
  Printer,
  AlertTriangle,
  Clock,
  User,
  CreditCard,
  Building2,
  Hash,
  Phone,
  StickyNote,
  Link2,
  Layers,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TransactionDetailSheetProps {
  transactionId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVoid?: (id: number) => void;
  onReturn?: (id: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function getTypeBadgeVariant(type: TransactionType): 'default' | 'warning' | 'destructive' {
  switch (type) {
    case 'sale': return 'default';
    case 'return': return 'warning';
    case 'void': return 'destructive';
    default: return 'default';
  }
}

function getTypeLabel(type: TransactionType, t: (key: string) => string): string {
  switch (type) {
    case 'sale': return t('Sale');
    case 'return': return t('Return');
    case 'void': return t('Void');
    default: return type;
  }
}

function getPaymentLabel(method: PaymentMethod | null, t: (key: string) => string): string {
  switch (method) {
    case 'cash': return t('Cash');
    case 'bank_transfer': return t('Bank Transfer');
    case 'mixed': return t('Mixed');
    default: return '\u2014';
  }
}

function getUnitLabel(
  unitType: 'parent' | 'child',
  parentUnit: string | undefined,
  childUnit: string | undefined,
  t: (key: string) => string
): string {
  if (unitType === 'parent') return parentUnit || t('Parent');
  return childUnit || t('Child');
}

// ---------------------------------------------------------------------------
// InfoRow — helper for the info grid
// ---------------------------------------------------------------------------

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  if (!value || value === '\u2014') {
    return null;
  }
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <div className="mt-0.5 shrink-0 text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function DetailSkeleton() {
  return (
    <div className="space-y-4 px-1">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-32" />
      <Separator />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>
      <Separator />
      <Skeleton className="h-4 w-20" />
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
      <Separator />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TransactionDetailSheet
// ---------------------------------------------------------------------------

export function TransactionDetailSheet({
  transactionId,
  open,
  onOpenChange,
  onVoid,
  onReturn,
}: TransactionDetailSheetProps) {
  const { t } = useTranslation();

  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(false);

  // ---- Fetch transaction details ----
  const fetchTransaction = useCallback(async (id: number) => {
    setLoading(true);
    setTransaction(null);
    try {
      const data = await api.transactions.getById(id);
      setTransaction(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load transaction'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open && transactionId != null) {
      fetchTransaction(transactionId);
    }
    if (!open) {
      setTransaction(null);
    }
  }, [open, transactionId, fetchTransaction]);

  // ---- Action handlers ----
  function handleVoid() {
    if (transaction && onVoid) {
      onOpenChange(false);
      onVoid(transaction.id);
    }
  }

  function handleReturn() {
    if (transaction && onReturn) {
      onOpenChange(false);
      onReturn(transaction.id);
    }
  }

  function handlePrint() {
    window.print();
  }

  // ---- Derive display values ----
  const items = transaction?.items ?? [];
  const isSale = transaction?.transaction_type === 'sale';
  const isVoided = transaction?.is_voided === 1;
  const canVoid = isSale && !isVoided && onVoid != null;
  const canReturn = isSale && !isVoided && onReturn != null;
  const isReturnTxn = transaction?.transaction_type === 'return';
  const hasParent = transaction?.parent_transaction_id != null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            {loading ? (
              <Skeleton className="h-5 w-36" />
            ) : transaction ? (
              transaction.transaction_number
            ) : (
              t('Transaction Details')
            )}
          </SheetTitle>
          <SheetDescription>
            {loading ? (
              <Skeleton className="h-4 w-48" />
            ) : transaction ? (
              <span className="flex items-center gap-2">
                <Badge variant={getTypeBadgeVariant(transaction.transaction_type)}>
                  {getTypeLabel(transaction.transaction_type, t)}
                </Badge>
                {isVoided ? (
                  <Badge variant="destructive">{t('Voided')}</Badge>
                ) : (
                  <Badge variant="success">{t('Completed')}</Badge>
                )}
              </span>
            ) : (
              t('Loading transaction details...')
            )}
          </SheetDescription>
        </SheetHeader>

        <Separator className="my-2" />

        {/* ---- Loading state ---- */}
        {loading && <DetailSkeleton />}

        {/* ---- Error / empty state ---- */}
        {!loading && !transaction && transactionId != null && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive" />
            <p className="text-sm font-medium text-muted-foreground">
              {t('Transaction not found')}
            </p>
          </div>
        )}

        {/* ---- Transaction content ---- */}
        {!loading && transaction && (
          <ScrollArea className="flex-1">
            <div className="space-y-4 px-1 pb-4">
              {/* ---- Void alert ---- */}
              {isVoided && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-destructive">
                        {t('This transaction has been voided')}
                      </p>
                      {transaction.voided_at && (
                        <p className="mt-1 text-xs text-destructive/80">
                          {t('Voided at')}: {formatDateTime(transaction.voided_at)}
                        </p>
                      )}
                      {transaction.voided_by != null && (
                        <p className="text-xs text-destructive/80">
                          {t('Voided by')}: {t('User')} #{transaction.voided_by}
                        </p>
                      )}
                      {transaction.void_reason && (
                        <p className="mt-1 text-xs text-destructive/80">
                          {t('Reason')}: {transaction.void_reason}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ---- Related transaction link ---- */}
              {hasParent && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/50">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      {isReturnTxn
                        ? t('Return of transaction')
                        : t('Related to transaction')}{' '}
                      <span className="font-semibold">#{transaction.parent_transaction_id}</span>
                    </p>
                  </div>
                </div>
              )}

              {/* ---- Info Grid ---- */}
              <div className="grid grid-cols-2 gap-x-4">
                <InfoRow
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label={t('Date / Time')}
                  value={formatDateTime(transaction.created_at)}
                />
                <InfoRow
                  icon={<User className="h-3.5 w-3.5" />}
                  label={t('Cashier')}
                  value={transaction.username ?? `${t('User')} #${transaction.user_id}`}
                />
                <InfoRow
                  icon={<Layers className="h-3.5 w-3.5" />}
                  label={t('Shift ID')}
                  value={transaction.shift_id != null ? `#${transaction.shift_id}` : null}
                />
                <InfoRow
                  icon={<CreditCard className="h-3.5 w-3.5" />}
                  label={t('Payment Method')}
                  value={getPaymentLabel(transaction.payment_method, t)}
                />
                {transaction.bank_name && (
                  <InfoRow
                    icon={<Building2 className="h-3.5 w-3.5" />}
                    label={t('Bank Name')}
                    value={transaction.bank_name}
                  />
                )}
                {transaction.reference_number && (
                  <InfoRow
                    icon={<Hash className="h-3.5 w-3.5" />}
                    label={t('Bank Reference')}
                    value={transaction.reference_number}
                  />
                )}
                {transaction.customer_name && (
                  <InfoRow
                    icon={<User className="h-3.5 w-3.5" />}
                    label={t('Customer Name')}
                    value={transaction.customer_name}
                  />
                )}
                {transaction.customer_phone && (
                  <InfoRow
                    icon={<Phone className="h-3.5 w-3.5" />}
                    label={t('Customer Phone')}
                    value={transaction.customer_phone}
                  />
                )}
                {transaction.notes && (
                  <InfoRow
                    icon={<StickyNote className="h-3.5 w-3.5" />}
                    label={t('Notes')}
                    value={transaction.notes}
                  />
                )}
              </div>

              <Separator />

              {/* ---- Items Table ---- */}
              <div>
                <p className="mb-2 text-sm font-semibold">
                  {t('Items')} ({items.length})
                </p>

                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('No items')}</p>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('Product')}</TableHead>
                          <TableHead className="text-center">{t('Qty')}</TableHead>
                          <TableHead className="text-end">{t('Unit Price')}</TableHead>
                          <TableHead className="text-end">{t('Disc %')}</TableHead>
                          <TableHead className="text-end">{t('Line Total')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell>
                              <div>
                                <p className="font-medium text-sm">
                                  {item.product_name ?? `#${item.product_id}`}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="text-center tabular-nums">
                              <span>{item.quantity_base}</span>
                              <span className="ms-1 text-xs text-muted-foreground">
                                ({getUnitLabel(item.unit_type, item.parent_unit, item.child_unit, t)})
                              </span>
                            </TableCell>
                            <TableCell className="text-end tabular-nums">
                              {formatCurrency(item.unit_price)}
                            </TableCell>
                            <TableCell className="text-end tabular-nums">
                              {item.discount_percent > 0
                                ? `${item.discount_percent}%`
                                : '\u2014'}
                            </TableCell>
                            <TableCell className="text-end font-medium tabular-nums">
                              {formatCurrency(item.line_total)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              <Separator />

              {/* ---- Totals Section ---- */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('Subtotal')}</span>
                  <span className="tabular-nums">{formatCurrency(transaction.subtotal)}</span>
                </div>
                {transaction.discount_amount > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('Discount')}</span>
                    <span className="tabular-nums text-destructive">
                      -{formatCurrency(transaction.discount_amount)}
                    </span>
                  </div>
                )}
                {transaction.tax_amount > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('Tax')}</span>
                    <span className="tabular-nums">{formatCurrency(transaction.tax_amount)}</span>
                  </div>
                )}
                <Separator />
                <div className="flex items-center justify-between text-base font-bold">
                  <span>{t('Total')}</span>
                  <span className="tabular-nums">{formatCurrency(transaction.total_amount)}</span>
                </div>
                {transaction.cash_tendered > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('Cash Tendered')}</span>
                    <span className="tabular-nums">
                      {formatCurrency(transaction.cash_tendered)}
                    </span>
                  </div>
                )}
                {transaction.payment_method === 'cash' && transaction.cash_tendered > transaction.total_amount && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('Change')}</span>
                    <span className="tabular-nums">
                      {formatCurrency(transaction.cash_tendered - transaction.total_amount)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        )}

        {/* ---- Action Buttons ---- */}
        {!loading && transaction && (
          <>
            <Separator className="my-2" />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrint}
                className="gap-1.5"
              >
                <Printer className="h-4 w-4" />
                {t('Print Receipt')}
              </Button>

              <div className="flex-1" />

              {canReturn && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReturn}
                  className="gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/50"
                >
                  <Undo2 className="h-4 w-4" />
                  {t('Return Items')}
                </Button>
              )}

              {canVoid && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleVoid}
                  className="gap-1.5"
                >
                  <Ban className="h-4 w-4" />
                  {t('Void Transaction')}
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
