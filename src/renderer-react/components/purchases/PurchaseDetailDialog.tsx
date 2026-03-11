import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, CheckCircle, Clock, CreditCard, AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import { api } from '@/api';
import type { Purchase, PurchasePayment, ExpensePaymentMethod } from '@/api/types';
import { Input } from '@/components/ui/input';
import { formatCurrency, cn } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EditPurchaseDialog } from './EditPurchaseDialog';
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

interface PurchaseDetailDialogProps {
  purchase: Purchase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaymentMade: () => void;
  onDeleted?: () => void;
}

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default',
  partial: 'secondary',
  unpaid: 'destructive',
};

function isOverdue(dueDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

export function PurchaseDetailDialog({ purchase: initialPurchase, open, onOpenChange, onPaymentMade, onDeleted }: PurchaseDetailDialogProps) {
  const { t } = useTranslation();
  const canPay = usePermission('purchases.pay');
  const canEdit = usePermission('purchases.edit');
  const canDelete = usePermission('purchases.delete');
  const [payingId, setPayingId] = useState<number | null>(null);
  const [expandedPayId, setExpandedPayId] = useState<number | null>(null);
  const [payMethod, setPayMethod] = useState<ExpensePaymentMethod>('cash');
  const [payRef, setPayRef] = useState('');
  const [purchase, setPurchase] = useState<Purchase | null>(initialPurchase);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync with parent when a new purchase is selected
  useEffect(() => {
    setPurchase(initialPurchase);
    setExpandedPayId(null);
    setPayRef('');
    setEditOpen(false);
    setDeleteConfirmOpen(false);
  }, [initialPurchase]);

  const refreshPurchase = useCallback(async (id: number) => {
    try {
      const updated = await api.purchases.getById(id);
      setPurchase(updated);
    } catch {
      // Silently fail — data stays as-is
    }
  }, []);

  const handleDelete = async () => {
    if (!purchase) return;
    setDeleting(true);
    try {
      await api.purchases.delete(purchase.id);
      toast.success(t('Purchase deleted successfully'));
      setDeleteConfirmOpen(false);
      onOpenChange(false);
      onDeleted?.();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete purchase'));
    } finally {
      setDeleting(false);
    }
  };

  const handleEditSaved = () => {
    if (purchase) refreshPurchase(purchase.id);
    onPaymentMade(); // Refresh parent lists
  };

  if (!purchase) return null;

  const hasPaidPayments = purchase.payments?.some(p => p.is_paid) ?? false;

  const handleMarkPaid = async (payment: PurchasePayment) => {
    if (payMethod === 'bank_transfer' && !payRef.trim()) {
      toast.error(t('Reference number is required for bank transfers'));
      return;
    }
    setPayingId(payment.id);
    try {
      await api.purchases.markPaymentPaid(
        payment.id, payMethod,
        payMethod === 'bank_transfer' ? payRef.trim() : undefined
      );
      toast.success(t('Payment marked as paid'));
      setPayRef('');
      setExpandedPayId(null);
      await refreshPurchase(purchase.id);
      onPaymentMade();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to mark payment'));
    } finally {
      setPayingId(null);
    }
  };

  const remaining = purchase.total_amount - purchase.total_paid;
  const paidPct = purchase.total_amount > 0
    ? Math.min(100, Math.round((purchase.total_paid / purchase.total_amount) * 100))
    : 0;
  const paidCount = purchase.payments?.filter(p => p.is_paid).length ?? 0;
  const totalCount = purchase.payments?.length ?? 0;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              {purchase.purchase_number}
              <Badge variant={STATUS_BADGE[purchase.payment_status] ?? 'secondary'}>
                {t(purchase.payment_status)}
              </Badge>
            </DialogTitle>
            <div className="flex items-center gap-1">
              {canEdit && (
                <Button variant="ghost" size="sm" className="gap-1 h-8" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('Edit')}
                </Button>
              )}
              {canDelete && !hasPaidPayments && (
                <Button variant="ghost" size="sm" className="gap-1 h-8 text-destructive hover:text-destructive" onClick={() => setDeleteConfirmOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('Delete')}
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Header Info */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">{t('Supplier')}:</span>{' '}
            <span className="font-medium">{purchase.supplier_name ?? t('N/A')}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Date')}:</span>{' '}
            <span className="font-medium">{purchase.purchase_date}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Invoice Number')}:</span>{' '}
            <span className="font-medium">{purchase.invoice_reference ?? t('N/A')}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Created By')}:</span>{' '}
            <span className="font-medium">{purchase.username}</span>
          </div>
        </div>

        {/* Payment Progress */}
        <div className="rounded-md border p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">{t('Payment Progress')}</span>
            <span className="text-muted-foreground">
              {paidCount}/{totalCount} {t('installments')}
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500 ease-out',
                paidPct >= 100 ? 'bg-emerald-500' : paidPct > 0 ? 'bg-primary' : 'bg-muted'
              )}
              style={{ width: `${paidPct}%` }}
            />
          </div>

          {/* Summary Numbers */}
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-muted-foreground">{t('Total')}</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(purchase.total_amount)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('Paid')}</p>
              <p className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{formatCurrency(purchase.total_paid)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('Remaining')}</p>
              <p className={cn(
                'text-lg font-bold tabular-nums',
                remaining > 0 ? 'text-destructive' : 'text-muted-foreground'
              )}>
                {formatCurrency(remaining)}
              </p>
            </div>
          </div>
        </div>

        {/* Items Table — only shown if there are items */}
        {purchase.items && purchase.items.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('Items')}</h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Product')}</TableHead>
                    <TableHead className="text-end">{t('Qty')}</TableHead>
                    <TableHead className="text-end">{t('Cost')}</TableHead>
                    <TableHead className="text-end">{t('Sell Price')}</TableHead>
                    <TableHead className="text-end">{t('Total')}</TableHead>
                    <TableHead>{t('Expiry Date')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchase.items.map(item => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.product_name}</TableCell>
                      <TableCell className="text-end">{item.quantity_received}</TableCell>
                      <TableCell className="text-end">{formatCurrency(item.cost_per_parent)}</TableCell>
                      <TableCell className="text-end">{formatCurrency(item.selling_price_parent)}</TableCell>
                      <TableCell className="text-end">{formatCurrency(item.line_total)}</TableCell>
                      <TableCell>{item.expiry_date ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Payment Schedule — Clean card-based layout */}
        {purchase.payments && purchase.payments.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('Payment Schedule')}</h3>
            <div className="space-y-2">
              {purchase.payments.map((payment, idx) => {
                const overdue = !payment.is_paid && isOverdue(payment.due_date);
                const isExpanded = expandedPayId === payment.id;

                return (
                  <div
                    key={payment.id}
                    className={cn(
                      'rounded-md border p-3 transition-colors',
                      payment.is_paid && 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900',
                      !payment.is_paid && overdue && 'bg-destructive/5 border-destructive/30',
                      !payment.is_paid && !overdue && 'bg-background',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      {/* Status icon */}
                      {payment.is_paid ? (
                        <CheckCircle className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : overdue ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                      ) : (
                        <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold tabular-nums">
                            {formatCurrency(payment.amount)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            #{idx + 1} &middot; {payment.due_date}
                          </span>
                          {payment.is_paid && (
                            <Badge variant="default" className="text-[10px] px-1.5 py-0">
                              {t('Paid')} {payment.paid_date}
                            </Badge>
                          )}
                          {overdue && !payment.is_paid && (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                              {t('Overdue')}
                            </Badge>
                          )}
                        </div>
                        {payment.reference_number && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t('Ref')}: {payment.reference_number}
                          </p>
                        )}
                      </div>

                      {/* Pay button */}
                      {canPay && !payment.is_paid && (
                        <Button
                          variant={isExpanded ? 'secondary' : 'outline'}
                          size="sm"
                          className="shrink-0 gap-1"
                          onClick={() => {
                            setExpandedPayId(isExpanded ? null : payment.id);
                            setPayRef('');
                            setPayMethod('cash');
                          }}
                        >
                          <CreditCard className="h-3.5 w-3.5" />
                          {t('Pay')}
                        </Button>
                      )}
                    </div>

                    {/* Expanded pay form */}
                    {canPay && isExpanded && !payment.is_paid && (
                      <div className="mt-3 pt-3 border-t flex items-end gap-2 flex-wrap">
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">{t('Method')}</label>
                          <Select
                            value={payMethod}
                            onValueChange={v => { setPayMethod(v as ExpensePaymentMethod); if (v !== 'bank_transfer') setPayRef(''); }}
                          >
                            <SelectTrigger className="h-8 w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cash">{t('Cash')}</SelectItem>
                              <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {payMethod === 'bank_transfer' && (
                          <div className="space-y-1 flex-1 min-w-[140px]">
                            <label className="text-xs text-muted-foreground">{t('Reference Number')}</label>
                            <Input
                              className="h-8"
                              value={payRef}
                              onChange={e => setPayRef(e.target.value)}
                              placeholder={t('Enter reference number')}
                            />
                          </div>
                        )}
                        <Button
                          size="sm"
                          className="gap-1"
                          onClick={() => handleMarkPaid(payment)}
                          disabled={payingId === payment.id}
                        >
                          {payingId === payment.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3.5 w-3.5" />
                          )}
                          {t('Confirm Payment')}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {purchase.notes && (
          <div>
            <span className="text-sm text-muted-foreground">{t('Notes')}:</span>
            <p className="text-sm">{purchase.notes}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* Edit Dialog */}
    <EditPurchaseDialog
      purchase={purchase}
      open={editOpen}
      onOpenChange={setEditOpen}
      onSaved={handleEditSaved}
    />

    {/* Delete Confirmation Dialog */}
    <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Delete Purchase')}</DialogTitle>
          <DialogDescription>
            {t('Are you sure you want to delete purchase')} <strong>{purchase.purchase_number}</strong>?
            {' '}{t('This action cannot be undone.')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>
            {t('Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
