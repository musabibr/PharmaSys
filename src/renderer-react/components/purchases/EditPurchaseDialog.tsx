import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, SplitSquareHorizontal } from 'lucide-react';
import { api } from '@/api';
import type { Purchase } from '@/api/types';
import { useApiCall } from '@/api/hooks';
import { formatCurrency, formatDate } from '@/lib/utils';

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
                    {/* Paid installments — read-only */}
                    {paidPayments.map((p, idx) => (
                      <TableRow key={p.id} className="opacity-50">
                        <TableCell className="text-center text-muted-foreground">{idx + 1}</TableCell>
                        <TableCell className="text-sm">{formatDate(p.due_date)}</TableCell>
                        <TableCell className="text-end text-sm tabular-nums">
                          {p.paid_amount === 0
                            ? <span className="text-xs text-muted-foreground">{t('Covered by overpayment')}</span>
                            : formatCurrency(p.paid_amount ?? p.amount)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="default" className="text-[10px]">{t('Paid')}</Badge>
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ))}
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
    </Dialog>
  );
}
