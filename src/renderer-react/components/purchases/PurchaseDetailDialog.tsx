import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, CheckCircle, Clock, CreditCard, AlertTriangle, Pencil, Trash2, Download } from 'lucide-react';
import { api } from '@/api';
import type { Purchase, PurchasePayment, ExpensePaymentMethod, PaymentAdjustmentStrategy } from '@/api/types';
import { Input } from '@/components/ui/input';
import { formatCurrency, formatDate, displayInvoiceId, cn } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { useAuthStore } from '@/stores/auth.store';
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

const ITEMS_PAGE_SIZE = 20;

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
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [payingId, setPayingId] = useState<number | null>(null);
  const [expandedPayId, setExpandedPayId] = useState<number | null>(null);
  const [payMethod, setPayMethod] = useState<ExpensePaymentMethod>('cash');
  const [payRef, setPayRef] = useState('');
  // Per-payment state keyed by payment.id
  const [paidAmounts, setPaidAmounts] = useState<Record<number, number | null>>({});
  const [adjustmentStrategies, setAdjustmentStrategies] = useState<Record<number, PaymentAdjustmentStrategy>>({});
  const [purchase, setPurchase] = useState<Purchase | null>(initialPurchase);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Inline item editing state
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editQty, setEditQty] = useState(0);
  const [editCost, setEditCost] = useState(0);
  const [editSell, setEditSell] = useState(0);
  const [savingItem, setSavingItem] = useState(false);
  const [itemsPage, setItemsPage] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Clean up saved timer on unmount
  useEffect(() => {
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); };
  }, []);

  // Sync with parent when a new purchase is selected, and auto-fetch full details
  useEffect(() => {
    setPurchase(initialPurchase);
    setExpandedPayId(null);
    setPayRef('');
    setEditOpen(false);
    setDeleteConfirmOpen(false);
    setItemsPage(0);
    setJustSaved(false);

    // Auto-fetch full purchase (with payments/items) when dialog opens.
    // The list-level purchase from getAll() doesn't include payments/items.
    if (initialPurchase && open) {
      api.purchases.getById(initialPurchase.id)
        .then(full => setPurchase(full))
        .catch(() => {/* keep what we have */});
    }
  }, [initialPurchase, open]);

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
      await api.purchases.delete(purchase.id, isAdmin);
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

  const handleExport = async () => {
    if (!purchase) return;
    try {
      // Fetch full purchase with items + payments
      const full = await api.purchases.getById(purchase.id);
      const exportData = {
        _version: 1,
        _type: 'pharmasys_purchase' as const,
        exported_at: new Date().toISOString(),
        supplier_name: full.supplier_name ?? null,
        invoice_reference: full.invoice_reference ?? null,
        purchase_date: full.purchase_date,
        alert_days_before: full.alert_days_before,
        notes: full.notes ?? null,
        items: (full.items ?? []).map(item => ({
          product_name: item.product_name ?? '',
          generic_name: '',
          category_name: '',
          parent_unit: item.parent_unit ?? 'Unit',
          child_unit: item.child_unit ?? '',
          conversion_factor: item.conversion_factor ?? 1,
          quantity: item.quantity_received,
          cost_per_parent: item.cost_per_parent,
          selling_price_parent: item.selling_price_parent,
          selling_price_child: (item.conversion_factor ?? 1) > 1 ? Math.floor(item.selling_price_parent / (item.conversion_factor ?? 1)) : 0,
          expiry_date: item.expiry_date ?? '',
          batch_number: item.batch_number ?? '',
          usage_instructions: '',
        })),
        payment_plan: {
          type: (full.payments && full.payments.length === 1 && !full.payments[0].due_date ? 'full' : 'installments') as 'full' | 'installments',
          installments: (full.payments ?? []).filter(p => !p.is_paid).map(p => ({
            due_date: p.due_date,
            amount: p.amount,
          })),
        },
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `purchase-${full.purchase_number ?? full.id}-${full.purchase_date}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('Purchase exported'));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Export failed'));
    }
  };

  const handleEditSaved = () => {
    if (purchase) refreshPurchase(purchase.id);
    onPaymentMade(); // Refresh parent lists
    // Flash green check to confirm save
    setJustSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setJustSaved(false), 2500);
  };

  if (!purchase) return null;

  const hasPaidPayments = purchase.payments?.some(p => p.is_paid) ?? false;

  const handleMarkPaid = async (payment: PurchasePayment) => {
    if (payMethod === 'bank_transfer' && !payRef.trim()) {
      toast.error(t('Reference number is required for bank transfers'));
      return;
    }
    const rawAmount = paidAmounts[payment.id] ?? payment.amount;
    const effectiveAmount = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : payment.amount;
    // Backend allows overpayment on last installment (common: rounding, settling accounts)
    const strategy = adjustmentStrategies[payment.id] ?? 'next';
    const amountDiffers = effectiveAmount !== payment.amount;
    setPayingId(payment.id);
    try {
      await api.purchases.markPaymentPaid(
        payment.id, payMethod,
        payMethod === 'bank_transfer' ? payRef.trim() : undefined,
        amountDiffers ? effectiveAmount : undefined,
        amountDiffers ? strategy : undefined
      );
      toast.success(t('Payment marked as paid'));
      setPayRef('');
      setPaidAmounts(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
      setAdjustmentStrategies(prev => { const next = { ...prev }; delete next[payment.id]; return next; });
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

  const allItems = purchase.items ?? [];
  const itemsTotalPages = Math.max(1, Math.ceil(allItems.length / ITEMS_PAGE_SIZE));
  const paginatedItems = allItems.slice(itemsPage * ITEMS_PAGE_SIZE, (itemsPage + 1) * ITEMS_PAGE_SIZE);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader className="pe-8">
          <DialogTitle className="flex items-center gap-2">
            {displayInvoiceId(purchase)}
            <Badge variant={STATUS_BADGE[purchase.payment_status] ?? 'secondary'}>
              {t(purchase.payment_status)}
            </Badge>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('Purchase details for')} {displayInvoiceId(purchase)}
          </DialogDescription>
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1">
              {canEdit && (
                <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-3 w-3" />
                  {t('Edit')}
                </Button>
              )}
              <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={handleExport}>
                <Download className="h-3 w-3" />
                {t('Export')}
              </Button>
              {justSaved && (
                <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 animate-in fade-in">
                  <CheckCircle className="h-3.5 w-3.5" />
                  {t('Saved')}
                </span>
              )}
            </div>
            {canDelete && (!hasPaidPayments || isAdmin) && (
              <Button variant="ghost" size="sm" className="gap-1 h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteConfirmOpen(true)}>
                <Trash2 className="h-3 w-3" />
                {t('Delete')}
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* Header Info — identification first, then people */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">{t('Date')}:</span>{' '}
            <span className="font-medium">{formatDate(purchase.purchase_date)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Invoice Number')}:</span>{' '}
            <span className="font-medium">{purchase.invoice_reference ?? t('N/A')}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Supplier')}:</span>{' '}
            <span className="font-medium">{purchase.supplier_name ?? t('N/A')}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Created By')}:</span>{' '}
            <span className="font-medium">{purchase.username}</span>
          </div>
        </div>

        {/* Items Table — what was purchased (shown before financials) */}
        {purchase.items && purchase.items.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('Items')}</h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 text-center">#</TableHead>
                    <TableHead>{t('Product')}</TableHead>
                    <TableHead className="text-end">{t('Qty')}</TableHead>
                    <TableHead className="text-end">{t('Cost')}</TableHead>
                    <TableHead className="text-end">{t('Sell Price')}</TableHead>
                    <TableHead className="text-end">{t('Total')}</TableHead>
                    <TableHead>{t('Expiry Date')}</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedItems.map((item, idx) => {
                    const isEditing = editingItemId === item.id;
                    return (
                    <TableRow key={item.id}>
                      <TableCell className="text-center text-muted-foreground">{itemsPage * ITEMS_PAGE_SIZE + idx + 1}</TableCell>
                      <TableCell className="font-medium">{item.product_name}</TableCell>
                      <TableCell className="text-end">
                        {isEditing ? (
                          <Input type="number" min={1} className="h-7 w-20 text-end" value={editQty}
                            onChange={e => setEditQty(Math.max(1, parseInt(e.target.value, 10) || 1))} />
                        ) : item.quantity_received}
                      </TableCell>
                      <TableCell className="text-end">
                        {isEditing ? (
                          <Input type="number" min={0} className="h-7 w-24 text-end" value={editCost}
                            onChange={e => setEditCost(Math.max(0, parseInt(e.target.value, 10) || 0))} />
                        ) : formatCurrency(item.cost_per_parent)}
                      </TableCell>
                      <TableCell className="text-end">
                        {isEditing ? (
                          <Input type="number" min={0} className="h-7 w-24 text-end" value={editSell}
                            onChange={e => setEditSell(Math.max(0, parseInt(e.target.value, 10) || 0))} />
                        ) : formatCurrency(item.selling_price_parent)}
                      </TableCell>
                      <TableCell className="text-end">{formatCurrency(isEditing ? editQty * editCost : item.line_total)}</TableCell>
                      <TableCell>{formatDate(item.expiry_date) || '-'}</TableCell>
                      <TableCell>
                        {isEditing ? (
                          <div className="flex gap-1">
                            <Button size="sm" className="h-7 px-2 text-xs" disabled={savingItem}
                              onClick={async () => {
                                const updates: Record<string, number> = {};
                                if (editQty !== item.quantity_received) updates.quantity_received = editQty;
                                if (editCost !== item.cost_per_parent) updates.cost_per_parent = editCost;
                                if (editSell !== item.selling_price_parent) updates.selling_price_parent = editSell;
                                if (Object.keys(updates).length === 0) { setEditingItemId(null); return; }
                                setSavingItem(true);
                                try {
                                  await api.purchases.updateItem(item.id, updates);
                                  toast.success(t('Item updated'));
                                  setEditingItemId(null);
                                  refreshPurchase(purchase.id);
                                } catch (err: unknown) {
                                  toast.error(err instanceof Error ? err.message : t('Failed'));
                                } finally { setSavingItem(false); }
                              }}
                            >{savingItem ? <Loader2 className="h-3 w-3 animate-spin" /> : t('Save')}</Button>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={savingItem}
                              onClick={() => setEditingItemId(null)}
                            >{t('Cancel')}</Button>
                          </div>
                        ) : (
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" title={t('Edit item')}
                              onClick={() => {
                                setEditingItemId(item.id);
                                setEditQty(item.quantity_received);
                                setEditCost(item.cost_per_parent);
                                setEditSell(item.selling_price_parent);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title={t('Delete item')}
                              onClick={async () => {
                                if (!window.confirm(t('Delete this item and its stock batch? This cannot be undone.'))) return;
                                try {
                                  await api.purchases.deleteItem(item.id);
                                  toast.success(t('Item deleted'));
                                  refreshPurchase(purchase.id);
                                } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('Failed')); }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {itemsTotalPages > 1 && (
              <div className="flex items-center justify-between mt-2 text-sm">
                <span className="text-muted-foreground">
                  {t('Page')} {itemsPage + 1} / {itemsTotalPages} ({allItems.length} {t('items')})
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={itemsPage <= 0} onClick={() => setItemsPage(p => p - 1)}>
                    {t('Previous')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={itemsPage >= itemsTotalPages - 1} onClick={() => setItemsPage(p => p + 1)}>
                    {t('Next')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Payment Progress — financial overview */}
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

        {/* Payment Schedule — Clean card-based layout */}
        {purchase.payments && purchase.payments.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('Payment Schedule')}</h3>
            <div className="space-y-2">
              {purchase.payments.map((payment, idx) => {
                const overdue = !payment.is_paid && isOverdue(payment.due_date);
                const isExpanded = expandedPayId === payment.id;
                const unpaidCount = purchase.payments!.filter(p => !p.is_paid).length;
                const isLastUnpaid = !payment.is_paid && unpaidCount === 1;

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
                            {payment.is_paid && payment.paid_amount === 0
                              ? <span className="text-xs text-muted-foreground font-normal">{t('Covered by overpayment')}</span>
                              : payment.is_paid && payment.paid_amount != null && payment.paid_amount > 0 && payment.paid_amount !== payment.amount
                                ? <>{formatCurrency(payment.paid_amount)} <span className="text-xs text-muted-foreground font-normal">/ {formatCurrency(payment.amount)}</span></>
                                : formatCurrency(payment.amount)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            #{idx + 1} &middot; {formatDate(payment.due_date)}
                          </span>
                          {payment.is_paid && (
                            <Badge variant="default" className="text-[10px] px-1.5 py-0">
                              {t('Paid')} {formatDate(payment.paid_date)}
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

                    {/* Expanded pay form — Amount first, then method, reference, strategy */}
                    {canPay && isExpanded && !payment.is_paid && (
                      <div className="mt-3 pt-3 border-t space-y-2">
                        <div className="flex items-end gap-2 flex-wrap">
                          <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">{t('Amount to Pay')}</label>
                            <Input
                              type="number"
                              className="h-8 w-32 tabular-nums"
                              value={paidAmounts[payment.id] ?? payment.amount}
                              onChange={e => {
                                const val = e.target.value === '' ? null : Number(e.target.value);
                                setPaidAmounts(prev => ({ ...prev, [payment.id]: val }));
                              }}
                              min={1}
                              autoFocus
                            />
                          </div>
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
                        </div>
                        {paidAmounts[payment.id] != null && paidAmounts[payment.id] !== payment.amount && (() => {
                          const isOverpay = paidAmounts[payment.id]! > payment.amount;
                          return (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">{t('Difference Strategy')}:</span>
                              <Select
                                value={adjustmentStrategies[payment.id] ?? 'next'}
                                onValueChange={v => setAdjustmentStrategies(prev => ({ ...prev, [payment.id]: v as PaymentAdjustmentStrategy }))}
                              >
                                <SelectTrigger className="h-8 w-56">
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
                            </div>
                          );
                        })()}
                        <div>
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
            {t('Are you sure you want to delete purchase')} <strong>{displayInvoiceId(purchase)}</strong>?
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
