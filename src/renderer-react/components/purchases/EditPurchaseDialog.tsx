import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/api';
import type { Purchase, Supplier } from '@/api/types';
import { useApiCall } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

interface EditPurchaseDialogProps {
  purchase: Purchase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
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

  useEffect(() => {
    if (purchase && open) {
      setSupplierId(purchase.supplier_id ? String(purchase.supplier_id) : 'none');
      setInvoiceRef(purchase.invoice_reference ?? '');
      setPurchaseDate(purchase.purchase_date);
      setNotes(purchase.notes ?? '');
      setAlertDays(purchase.alert_days_before ?? 7);
    }
  }, [purchase, open]);

  if (!purchase) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Edit Purchase')} — {purchase.purchase_number}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
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

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Invoice Number')}</label>
            <Input
              value={invoiceRef}
              onChange={e => setInvoiceRef(e.target.value)}
              placeholder={t('Invoice reference number')}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Purchase Date')}</label>
            <Input
              type="date"
              value={purchaseDate}
              onChange={e => setPurchaseDate(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('Alert Days Before Due')}</label>
            <Input
              type="number"
              min={0}
              value={alertDays}
              onChange={e => setAlertDays(parseInt(e.target.value, 10) || 0)}
            />
          </div>

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
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('Save Changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
