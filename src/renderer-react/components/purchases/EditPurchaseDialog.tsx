import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, SplitSquareHorizontal, Bookmark, ChevronDown, ChevronRight, Pencil, Download, CheckCircle2, Undo2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { api, throwIfError } from '@/api';
import type { Purchase, PurchasePendingItem, CreatePurchaseItemInput } from '@/api/types';
import { useApiCall } from '@/api/hooks';
import { formatCurrency, formatDate } from '@/lib/utils';
import { PendingItemEditDialog, parseDraft, draftToRaw } from './PendingItemEditDialog';
import type { PendingItemDraft } from './PendingItemEditDialog';

function isoToDisplay(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y.slice(-2)}`;
}

function displayToIso(display: string): string {
  const match = display.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return '';
  const [, d, m, y] = match;
  const fullYear = y.length === 2 ? `20${y}` : y;
  return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface EditPurchaseDialogProps {
  purchase: Purchase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

interface EditablePayment {
  id: number;
  amount: number;
  due_date: string;
  is_paid: boolean;
  paid_amount: number | null;
  original_amount: number;
  original_due_date: string;
}

interface NewInstallment {
  _key: string;
  amount: number;
  due_date: string;
}


export function EditPurchaseDialog({ purchase, open, onOpenChange, onSaved }: EditPurchaseDialogProps) {
  const { t } = useTranslation();
  const { data: suppliers } = useApiCall(() => api.suppliers.getAll(), []);
  const [saving, setSaving] = useState(false);

  const [supplierId, setSupplierId] = useState<string>('none');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [dateDisplay, setDateDisplay] = useState('');
  const [notes, setNotes] = useState('');
  const [alertDays, setAlertDays] = useState(7);
  const [editablePayments, setEditablePayments] = useState<EditablePayment[]>([]);
  const [newInstallments, setNewInstallments] = useState<NewInstallment[]>([]);
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());
  const [pendingItems, setPendingItems] = useState<PurchasePendingItem[]>([]);
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const [deletingPendingId, setDeletingPendingId] = useState<number | null>(null);
  const [completingPendingId, setCompletingPendingId] = useState<number | null>(null);
  const [savingPendingId, setSavingPendingId] = useState<number | null>(null);
  // Edit dialog for parked items
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingPendingItem, setEditingPendingItem] = useState<PurchasePendingItem | null>(null);
  const [editingPendingDraft, setEditingPendingDraft] = useState<PendingItemDraft | null>(null);
  // Inline paid payment editing
  const [editingPaidId, setEditingPaidId] = useState<number | null>(null);
  const [editPaidAmount, setEditPaidAmount] = useState(0);
  const [savingPaid, setSavingPaid] = useState(false);

  useEffect(() => {
    if (purchase && open) {
      setSupplierId(purchase.supplier_id ? String(purchase.supplier_id) : 'none');
      setInvoiceRef(purchase.invoice_reference ?? '');
      setPurchaseDate(purchase.purchase_date);
      setDateDisplay(isoToDisplay(purchase.purchase_date));
      setNotes(purchase.notes ?? '');
      setAlertDays(purchase.alert_days_before ?? 7);

      const payments = (purchase.payments ?? []).map(p => ({
        id: p.id,
        amount: p.amount,
        due_date: p.due_date,
        is_paid: !!p.is_paid,
        paid_amount: p.paid_amount,
        original_amount: p.amount,
        original_due_date: p.due_date,
      }));
      setEditablePayments(payments);
      setNewInstallments([]);
      setRemovedIds(new Set());
      setPendingItems([]);
      setPendingExpanded(false);
      setEditDialogOpen(false);
      setEditingPendingItem(null);
      setEditingPendingDraft(null);

      // Load pending items asynchronously
      api.purchases.getPendingItems(purchase.id).then(items => {
        setPendingItems(items);
        if (items.length > 0) setPendingExpanded(true);
      }).catch(() => { /* non-critical */ });
    }
  }, [purchase, open]);

  if (!purchase) return null;

  const paidPayments = editablePayments.filter(p => p.is_paid);
  const unpaidPayments = editablePayments.filter(p => !p.is_paid && !removedIds.has(p.id));
  const hasPayments = editablePayments.length > 0 || newInstallments.length > 0;
  const hasStructuralChanges = newInstallments.length > 0 || removedIds.size > 0;

  const paidScheduledTotal = useMemo(() =>
    paidPayments.reduce((sum, p) => sum + p.amount, 0),
    [paidPayments]
  );

  const unpaidTotal = useMemo(() =>
    unpaidPayments.reduce((sum, p) => sum + p.amount, 0) +
    newInstallments.reduce((sum, p) => sum + p.amount, 0),
    [unpaidPayments, newInstallments]
  );

  const scheduleTotal = paidScheduledTotal + unpaidTotal;
  const isScheduleValid = scheduleTotal === purchase.total_amount;
  const remainingToAllocate = purchase.total_amount - paidScheduledTotal - unpaidTotal;

  const hasScheduleChanges = useMemo(() =>
    hasStructuralChanges ||
    editablePayments.some(p =>
      !p.is_paid && !removedIds.has(p.id) && (p.amount !== p.original_amount || p.due_date !== p.original_due_date)
    ),
    [editablePayments, hasStructuralChanges, removedIds]
  );

  const updatePayment = (id: number, field: 'amount' | 'due_date', value: string | number) => {
    setEditablePayments(prev => prev.map(p => {
      if (p.id !== id || p.is_paid) return p;
      return { ...p, [field]: field === 'amount' ? Math.max(0, Math.round(Number(value) || 0)) : value };
    }));
  };

  const removeUnpaidPayment = (id: number) => {
    setRemovedIds(prev => new Set(prev).add(id));
  };

  const addNewInstallment = () => {
    setNewInstallments(prev => [...prev, {
      _key: `new-${Date.now()}`,
      amount: Math.max(0, remainingToAllocate),
      due_date: '',
    }]);
  };

  const updateNewInstallment = (key: string, field: 'amount' | 'due_date', value: string | number) => {
    setNewInstallments(prev => prev.map(inst =>
      inst._key === key
        ? { ...inst, [field]: field === 'amount' ? Math.max(0, Math.round(Number(value) || 0)) : value }
        : inst
    ));
  };

  const removeNewInstallment = (key: string) => {
    setNewInstallments(prev => prev.filter(i => i._key !== key));
  };

  const autoAdjustLast = () => {
    if (remainingToAllocate === 0) return;
    // Prefer adjusting last new installment, then last unpaid existing
    if (newInstallments.length > 0) {
      setNewInstallments(prev => {
        const last = prev[prev.length - 1];
        const newAmount = last.amount + remainingToAllocate;
        if (newAmount <= 0) {
          toast.error(t('Cannot adjust: result would be zero or negative'));
          return prev;
        }
        return prev.map((inst, idx) =>
          idx === prev.length - 1 ? { ...inst, amount: newAmount } : inst
        );
      });
    } else if (unpaidPayments.length > 0) {
      const lastId = unpaidPayments[unpaidPayments.length - 1].id;
      setEditablePayments(prev => prev.map(p => {
        if (p.id !== lastId) return p;
        const newAmount = p.amount + remainingToAllocate;
        if (newAmount <= 0) {
          toast.error(t('Cannot adjust: result would be zero or negative'));
          return p;
        }
        return { ...p, amount: newAmount };
      }));
    }
  };

  /** Evenly distribute remaining amount across all unpaid + new installments */
  const splitEvenlyUnpaid = () => {
    const total = unpaidTotal + remainingToAllocate;
    const count = unpaidPayments.length + newInstallments.length;
    if (count === 0 || total <= 0) return;
    const base = Math.floor(total / count);
    const remainder = total - base * count;
    let added = 0;
    setEditablePayments(prev => prev.map(p => {
      if (p.is_paid || removedIds.has(p.id)) return p;
      const extra = added < remainder ? 1 : 0;
      added++;
      return { ...p, amount: base + extra };
    }));
    setNewInstallments(prev => prev.map((inst, idx) => {
      const extra = (unpaidPayments.length + idx) < remainder ? 1 : 0;
      return { ...inst, amount: base + extra };
    }));
  };

  const handleSave = async () => {
    if (hasScheduleChanges && !isScheduleValid) {
      toast.error(t('Installment amounts must equal purchase total'));
      return;
    }

    setSaving(true);
    try {
      // Save schedule first — if it fails, metadata is unchanged (better ordering)
      if (hasScheduleChanges) {
        if (hasStructuralChanges) {
          // Structure changed (adds/removals) — replace all unpaid with new schedule
          const allUnpaid = [
            ...unpaidPayments.map(p => ({ amount: p.amount, due_date: p.due_date })),
            ...newInstallments.map(i => ({ amount: i.amount, due_date: i.due_date })),
          ];
          await api.purchases.replaceUnpaidSchedule(purchase.id, allUnpaid);
        } else {
          // Only amounts/dates changed — use existing update
          const payments = unpaidPayments.map(p => ({ id: p.id, amount: p.amount, due_date: p.due_date }));
          await api.purchases.updatePaymentSchedule(purchase.id, payments);
        }
      }

      // Save metadata
      await api.purchases.update(purchase.id, {
        supplier_id: supplierId === 'none' ? null : parseInt(supplierId, 10),
        invoice_reference: invoiceRef.trim() || null,
        purchase_date: purchaseDate,
        notes: notes.trim() || null,
        alert_days_before: alertDays,
        total_amount: purchase.total_amount,
      });

      toast.success(t('Purchase updated successfully'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to update purchase'));
    } finally {
      setSaving(false);
    }
  };

  const exportAllParked = () => {
    if (pendingItems.length === 0) return;
    const rows = pendingItems.map(pi => {
      const d = parseDraft(pi.raw_data, pi.notes);
      return {
        [t('Name')]: d.name,
        [t('Quantity')]: d.quantity,
        [t('Cost/Parent')]: d.costPerParent,
        [t('Sell Price')]: d.sellPrice,
        [t('Sell Price Child')]: d.sellPriceChild,
        [t('Expiry Date')]: d.expiryDate,
        [t('Batch Number')]: d.batchNumber,
        [t('Parent Unit')]: d.parentUnit,
        [t('Child Unit')]: d.childUnit,
        [t('Conv. Factor')]: d.convFactor,
        [t('Notes')]: d.notes,
        [t('Created')]: pi.created_at.slice(0, 10),
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t('Parked Items'));
    XLSX.writeFile(wb, `parked-items-${purchase.purchase_number}.xlsx`);
  };

  const exportSingleParked = (pi: PurchasePendingItem) => {
    const d = parseDraft(pi.raw_data, pi.notes);
    const rows = [{
      [t('Name')]: d.name,
      [t('Quantity')]: d.quantity,
      [t('Cost/Parent')]: d.costPerParent,
      [t('Sell Price')]: d.sellPrice,
      [t('Sell Price Child')]: d.sellPriceChild,
      [t('Expiry Date')]: d.expiryDate,
      [t('Batch Number')]: d.batchNumber,
      [t('Parent Unit')]: d.parentUnit,
      [t('Child Unit')]: d.childUnit,
      [t('Conv. Factor')]: d.convFactor,
      [t('Notes')]: d.notes,
      [t('Created')]: pi.created_at.slice(0, 10),
    }];
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t('Parked Item'));
    XLSX.writeFile(wb, `parked-item-${pi.id}.xlsx`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Edit Purchase')} — {purchase.invoice_reference?.trim() || purchase.purchase_number}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Identification first: Date + Invoice # */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('Purchase Date')}</label>
              <Input
                type="text"
                value={dateDisplay}
                onChange={e => setDateDisplay(e.target.value)}
                onBlur={() => {
                  const iso = displayToIso(dateDisplay);
                  if (iso) {
                    setPurchaseDate(iso);
                    setDateDisplay(isoToDisplay(iso));
                  }
                }}
                placeholder="dd/mm/yy"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('Invoice Number')}</label>
              <Input
                value={invoiceRef}
                onChange={e => setInvoiceRef(e.target.value)}
                placeholder={t('Invoice reference number')}
              />
            </div>
          </div>

          {/* Who: Supplier */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Supplier')}</label>
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('No Supplier')}</SelectItem>
                {suppliers?.map(s => (
                  <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Invoice Total — editable */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Invoice Total')} (SDG)</label>
            <Input
              type="number"
              min={0}
              value={purchase.total_amount}
              onChange={e => {
                const val = parseInt(e.target.value, 10) || 0;
                setPurchase(prev => prev ? { ...prev, total_amount: val } : prev);
              }}
            />
          </div>

          {/* Settings */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Alert Days Before Due')}</label>
            <Input
              type="number"
              min={0}
              value={alertDays}
              onChange={e => setAlertDays(parseInt(e.target.value, 10) || 0)}
            />
          </div>

          {/* Installments Section — show for any purchase with payments or unpaid/partial status */}
          {(hasPayments || purchase.payment_status !== 'paid') && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t('Installments')}</label>
                <span className="text-xs text-muted-foreground">
                  {t('Total')}: {formatCurrency(purchase.total_amount)}
                </span>
              </div>

              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10 text-center">#</TableHead>
                      <TableHead>{t('Due Date')}</TableHead>
                      <TableHead className="text-end">{t('Amount')}</TableHead>
                      <TableHead>{t('Status')}</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* Paid installments — now editable with edit/delete buttons */}
                    {paidPayments.map((p, idx) => {
                      const isEditingPaid = editingPaidId === p.id;
                      return (
                      <TableRow key={p.id}>
                        <TableCell className="text-center text-muted-foreground">{idx + 1}</TableCell>
                        <TableCell className="text-sm">{formatDate(p.paid_date ?? p.due_date)}</TableCell>
                        <TableCell className="text-end text-sm tabular-nums">
                          {isEditingPaid ? (
                            <Input type="number" min={0} className="h-7 w-28 text-end" value={editPaidAmount}
                              onChange={e => setEditPaidAmount(Math.max(0, parseInt(e.target.value, 10) || 0))} />
                          ) : p.paid_amount === 0
                            ? <span className="text-xs text-muted-foreground">{t('Covered by overpayment')}</span>
                            : formatCurrency(p.paid_amount ?? p.amount)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="default" className="text-[10px]">{t('Paid')}</Badge>
                        </TableCell>
                        <TableCell>
                          {isEditingPaid ? (
                            <div className="flex gap-1">
                              <Button size="sm" className="h-7 px-2 text-xs" disabled={savingPaid}
                                onClick={async () => {
                                  setSavingPaid(true);
                                  try {
                                    await api.purchases.updatePayment(p.id, { amount: editPaidAmount });
                                    toast.success(t('Payment updated'));
                                    setEditingPaidId(null);
                                    onSaved();
                                  } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('Failed')); }
                                  finally { setSavingPaid(false); }
                                }}
                              >{savingPaid ? <Loader2 className="h-3 w-3 animate-spin" /> : t('Save')}</Button>
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                                onClick={() => setEditingPaidId(null)}
                              >{t('Cancel')}</Button>
                            </div>
                          ) : (
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-600" title={t('Mark as unpaid')}
                              onClick={async () => {
                                if (!window.confirm(t('Revert this payment to unpaid?'))) return;
                                try {
                                  await api.purchases.unmarkPaymentPaid(p.id);
                                  toast.success(t('Payment reverted to unpaid'));
                                  onSaved();
                                } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('Failed')); }
                              }}
                            >
                              <Undo2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title={t('Edit payment')}
                              onClick={() => { setEditingPaidId(p.id); setEditPaidAmount(p.paid_amount ?? p.amount); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title={t('Delete payment')}
                              onClick={async () => {
                                if (!window.confirm(t('Delete this paid payment? This cannot be undone.'))) return;
                                try {
                                  await api.purchases.deletePayment(p.id);
                                  toast.success(t('Payment deleted'));
                                  onSaved();
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
                    {/* Unpaid existing installments — editable */}
                    {unpaidPayments.map((p, idx) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-center text-muted-foreground">{paidPayments.length + idx + 1}</TableCell>
                        <TableCell>
                          <Input
                            type="date"
                            className="h-8 w-36"
                            value={p.due_date}
                            onChange={e => updatePayment(p.id, 'due_date', e.target.value)}
                          />
                        </TableCell>
                        <TableCell className="text-end">
                          <Input
                            type="number"
                            className="h-8 w-28 text-end tabular-nums"
                            value={p.amount}
                            onChange={e => updatePayment(p.id, 'amount', e.target.value)}
                            min={0}
                          />
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-[10px]">{t('Pending')}</Badge>
                        </TableCell>
                        <TableCell>
                          {unpaidPayments.length + newInstallments.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => removeUnpaidPayment(p.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* Newly added installments */}
                    {newInstallments.map((inst, idx) => (
                      <TableRow key={inst._key}>
                        <TableCell className="text-center text-muted-foreground">{paidPayments.length + unpaidPayments.length + idx + 1}</TableCell>
                        <TableCell>
                          <Input
                            type="date"
                            className="h-8 w-36"
                            value={inst.due_date}
                            onChange={e => updateNewInstallment(inst._key, 'due_date', e.target.value)}
                          />
                        </TableCell>
                        <TableCell className="text-end">
                          <Input
                            type="number"
                            className="h-8 w-28 text-end tabular-nums"
                            value={inst.amount || ''}
                            onChange={e => updateNewInstallment(inst._key, 'amount', e.target.value)}
                            min={0}
                            placeholder="0"
                          />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{t('New')}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => removeNewInstallment(inst._key)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Add installment + allocation feedback */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={addNewInstallment} className="gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    {t('Add Installment')}
                  </Button>
                  {(unpaidPayments.length + newInstallments.length) > 1 && (
                    <Button variant="outline" size="sm" onClick={splitEvenlyUnpaid} className="gap-1">
                      <SplitSquareHorizontal className="h-3.5 w-3.5" />
                      {t('Split Evenly')}
                    </Button>
                  )}
                  {remainingToAllocate !== 0 && (unpaidPayments.length > 0 || newInstallments.length > 0) && (
                    <Button variant="ghost" size="sm" onClick={autoAdjustLast} className="text-xs">
                      {t('Auto-adjust last')}
                    </Button>
                  )}
                </div>

                {/* Allocation summary */}
                {(hasScheduleChanges || remainingToAllocate !== 0) && (
                  <div className={`text-xs rounded-md px-3 py-2 ${
                    isScheduleValid
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
                      : 'bg-destructive/10 text-destructive'
                  }`}>
                    {isScheduleValid ? (
                      t('Schedule totals match purchase total')
                    ) : (
                      <>
                        {remainingToAllocate > 0
                          ? t('{{amount}} remaining to allocate', { amount: formatCurrency(remainingToAllocate) })
                          : t('Over-allocated by {{amount}}', { amount: formatCurrency(Math.abs(remainingToAllocate)) })
                        }
                        <span className="text-muted-foreground ms-2">
                          ({formatCurrency(scheduleTotal)} / {formatCurrency(purchase.total_amount)})
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Pending Items */}
          {pendingItems.length > 0 && (
            <div className="space-y-2 rounded-md border-2 border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/25 p-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400"
                  onClick={() => setPendingExpanded(v => !v)}
                >
                  <Bookmark className="h-4 w-4 fill-current" />
                  {t('Parked Items ({{n}})', { n: pendingItems.length })}
                  {pendingExpanded ? <ChevronDown className="h-3.5 w-3.5 ms-1" /> : <ChevronRight className="h-3.5 w-3.5 ms-1" />}
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7 text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                  onClick={exportAllParked}
                  title={t('Export all parked items to Excel')}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('Export All')}
                </Button>
              </div>

              {pendingExpanded && (
                <div className="space-y-2 pt-1">
                  {pendingItems.map(pi => {
                    const parsed = parseDraft(pi.raw_data, pi.notes);
                    const isCompleting = completingPendingId === pi.id;
                    const isDeleting   = deletingPendingId   === pi.id;
                    const isBusy       = isCompleting || isDeleting;

                    return (
                      <div key={pi.id} className="rounded-md border border-amber-200 dark:border-amber-800 bg-background/80 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">{parsed.name || t('Unknown item')}</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
                              {parsed.quantity > 0 && <span>{t('Qty')}: {parsed.quantity} {parsed.parentUnit}</span>}
                              {parsed.costPerParent > 0 && <span>{t('Cost')}: {formatCurrency(parsed.costPerParent)}</span>}
                              {parsed.sellPrice > 0 && <span>{t('Sell')}: {formatCurrency(parsed.sellPrice)}</span>}
                              {parsed.expiryDate && <span>{t('Exp')}: {parsed.expiryDate}</span>}
                              {parsed.batchNumber && <span>{t('Batch')}: {parsed.batchNumber}</span>}
                              {parsed.childUnit && <span>{parsed.parentUnit} → {parsed.convFactor}× {parsed.childUnit}</span>}
                            </div>
                            {parsed.notes && (
                              <p className="text-xs text-muted-foreground mt-0.5 italic">{parsed.notes}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-primary"
                              title={t('Edit')} disabled={isBusy}
                              onClick={() => {
                                setEditingPendingItem(pi);
                                setEditingPendingDraft(parseDraft(pi.raw_data, pi.notes));
                                setEditDialogOpen(true);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-emerald-600"
                              title={t('Complete — add to inventory')} disabled={isBusy}
                              onClick={async () => {
                                if (!parsed.name.trim()) { toast.error(t('Name is required')); return; }
                                if (!window.confirm(t('Complete this parked item and add it to inventory?'))) return;
                                setCompletingPendingId(pi.id);
                                try {
                                  const itemData: CreatePurchaseItemInput = {
                                    quantity: parsed.quantity || 1,
                                    cost_per_parent: parsed.costPerParent,
                                    selling_price_parent: parsed.sellPrice,
                                    selling_price_child: parsed.sellPriceChild || undefined,
                                    expiry_date: parsed.expiryDate || new Date().toISOString().slice(0, 10),
                                    batch_number: parsed.batchNumber || undefined,
                                    new_product: {
                                      name: parsed.name,
                                      parent_unit: parsed.parentUnit || 'Unit',
                                      child_unit: parsed.childUnit || undefined,
                                      conversion_factor: parsed.convFactor || 1,
                                    },
                                  };
                                  throwIfError(await api.purchases.completePendingItem(pi.id, itemData));
                                  setPendingItems(prev => prev.filter(p => p.id !== pi.id));
                                  toast.success(t('Item completed and added to purchase'));
                                  onSaved();
                                } catch (err: unknown) {
                                  toast.error(err instanceof Error ? err.message : t('Failed to complete item'));
                                } finally {
                                  setCompletingPendingId(null);
                                }
                              }}
                            >
                              {isCompleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-primary"
                              title={t('Export this item')} disabled={isBusy}
                              onClick={() => exportSingleParked(pi)}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              title={t('Delete')} disabled={isBusy}
                              onClick={async () => {
                                if (!window.confirm(t('Remove this parked item permanently?'))) return;
                                setDeletingPendingId(pi.id);
                                try {
                                  throwIfError(await api.purchases.deletePendingItem(pi.id));
                                  setPendingItems(prev => prev.filter(p => p.id !== pi.id));
                                } catch {
                                  toast.error(t('Failed to delete parked item'));
                                } finally {
                                  setDeletingPendingId(null);
                                }
                              }}
                            >
                              {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Additional */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Notes')}</label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t('Optional notes')}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || (hasScheduleChanges && !isScheduleValid)}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('Save Changes')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Edit parked item dialog */}
      <PendingItemEditDialog
        item={editingPendingDraft}
        open={editDialogOpen}
        onOpenChange={open => {
          setEditDialogOpen(open);
          if (!open) { setEditingPendingItem(null); setEditingPendingDraft(null); }
        }}
        onSave={async (draft) => {
          if (!editingPendingItem) return;
          setSavingPendingId(editingPendingItem.id);
          try {
            const updated = throwIfError(await api.purchases.updatePendingItem(
              editingPendingItem.id, draftToRaw(draft), draft.notes || null
            ));
            setPendingItems(prev => prev.map(p => p.id === editingPendingItem.id ? updated : p));
            setEditDialogOpen(false);
            setEditingPendingItem(null);
            setEditingPendingDraft(null);
            toast.success(t('Parked item updated'));
          } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : t('Failed to update parked item'));
          } finally {
            setSavingPendingId(null);
          }
        }}
      />
    </Dialog>
  );
}
