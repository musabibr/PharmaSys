import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/api';
import type { Purchase, PurchasePayment } from '@/api/types';
import { useApiCall } from '@/api/hooks';
import { formatCurrency, formatDate } from '@/lib/utils';
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

export function EditPurchaseDialog({ purchase, open, onOpenChange, onSaved }: EditPurchaseDialogProps) {
  const { t } = useTranslation();
  const { data: suppliers } = useApiCall(() => api.suppliers.getAll(), []);
  const [saving, setSaving] = useState(false);

  const [supplierId, setSupplierId] = useState<string>('none');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [notes, setNotes] = useState('');
  const [alertDays, setAlertDays] = useState(7);
  const [editablePayments, setEditablePayments] = useState<EditablePayment[]>([]);

  useEffect(() => {
    if (purchase && open) {
      setSupplierId(purchase.supplier_id ? String(purchase.supplier_id) : 'none');
      setInvoiceRef(purchase.invoice_reference ?? '');
      setPurchaseDate(purchase.purchase_date);
      setNotes(purchase.notes ?? '');
      setAlertDays(purchase.alert_days_before ?? 7);

      // Build editable payments from the purchase payments
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
    }
  }, [purchase, open]);

  if (!purchase) return null;

  // Use scheduled amount (not paid_amount) for validation — schedule must sum to total_amount
  // paid_amount can differ from scheduled amount due to overpayment/underpayment adjustments
  const paidScheduledTotal = useMemo(() =>
    editablePayments
      .filter(p => p.is_paid)
      .reduce((sum, p) => sum + p.amount, 0),
    [editablePayments]
  );

  const unpaidTotal = useMemo(() =>
    editablePayments
      .filter(p => !p.is_paid)
      .reduce((sum, p) => sum + p.amount, 0),
    [editablePayments]
  );

  const scheduleTotal = paidScheduledTotal + unpaidTotal;
  const isScheduleValid = scheduleTotal === purchase.total_amount;

  const hasScheduleChanges = useMemo(() =>
    editablePayments.some(p =>
      !p.is_paid && (p.amount !== p.original_amount || p.due_date !== p.original_due_date)
    ),
    [editablePayments]
  );

  const updatePayment = (id: number, field: 'amount' | 'due_date', value: string | number) => {
    setEditablePayments(prev => prev.map(p => {
      if (p.id !== id || p.is_paid) return p;
      return { ...p, [field]: field === 'amount' ? Math.max(0, Math.round(Number(value) || 0)) : value };
    }));
  };

  const handleSave = async () => {
    if (hasScheduleChanges && !isScheduleValid) {
      toast.error(t('Installment amounts must equal purchase total'));
      return;
    }

    setSaving(true);
    try {
      // Save metadata
      await api.purchases.update(purchase.id, {
        supplier_id: supplierId === 'none' ? null : parseInt(supplierId, 10),
        invoice_reference: invoiceRef.trim() || null,
        purchase_date: purchaseDate,
        notes: notes.trim() || null,
        alert_days_before: alertDays,
      });

      // Save schedule changes if any
      if (hasScheduleChanges) {
        const unpaidPayments = editablePayments
          .filter(p => !p.is_paid)
          .map(p => ({ id: p.id, amount: p.amount, due_date: p.due_date }));
        await api.purchases.updatePaymentSchedule(purchase.id, unpaidPayments);
      }

      toast.success(t('Purchase updated successfully'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to update purchase'));
    } finally {
      setSaving(false);
    }
  };

  const unpaidPayments = editablePayments.filter(p => !p.is_paid);
  const paidPayments = editablePayments.filter(p => p.is_paid);
  const hasPayments = editablePayments.length > 0;

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
                type="date"
                value={purchaseDate}
                onChange={e => setPurchaseDate(e.target.value)}
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

          {/* Installments Section */}
          {hasPayments && (
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
                      </TableRow>
                    ))}
                    {/* Unpaid installments — editable */}
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
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Validation feedback */}
              {hasScheduleChanges && (
                <div className={`text-xs ${isScheduleValid ? 'text-emerald-600' : 'text-destructive'}`}>
                  {isScheduleValid
                    ? t('Schedule totals match purchase total')
                    : `${t('Schedule total')}: ${formatCurrency(scheduleTotal)} ≠ ${t('Purchase total')}: ${formatCurrency(purchase.total_amount)} — ${t('Difference')}: ${formatCurrency(Math.abs(scheduleTotal - purchase.total_amount))}`
                  }
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
    </Dialog>
  );
}
