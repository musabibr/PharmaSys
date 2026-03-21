import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Loader2 } from 'lucide-react';
import { api } from '@/api';
import type { Supplier } from '@/api/types';
import { useApiCall } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const NEW_SUPPLIER = '__new__';
const NO_SUPPLIER = '__none__';

interface SupplierSelectProps {
  value: number | null;
  onChange: (supplierId: number | null, supplier?: Supplier) => void;
}

export function SupplierSelect({ value, onChange }: SupplierSelectProps) {
  const { t } = useTranslation();
  const { data: suppliers, refetch } = useApiCall(() => api.suppliers.getAll(), []);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const handleChange = useCallback((val: string) => {
    if (val === NEW_SUPPLIER) {
      setShowNew(true);
      return;
    }
    if (val === NO_SUPPLIER) {
      onChange(null);
      return;
    }
    const id = parseInt(val, 10);
    const s = suppliers?.find(s => s.id === id);
    onChange(id, s);
  }, [onChange, suppliers]);

  const handleCreateSupplier = useCallback(async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const created = await api.suppliers.create({ name: newName.trim(), phone: newPhone.trim() || undefined });
      toast.success(t('Supplier created'));
      await refetch();
      onChange(created.id, created);
      setShowNew(false);
      setNewName('');
      setNewPhone('');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to create supplier'));
    } finally {
      setSaving(false);
    }
  }, [newName, newPhone, onChange, refetch, t]);

  return (
    <>
      <Select value={value?.toString() ?? NO_SUPPLIER} onValueChange={handleChange}>
        <SelectTrigger>
          <SelectValue placeholder={t('Select Supplier')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SUPPLIER}>{t('No Supplier')}</SelectItem>
          {suppliers?.map(s => (
            <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
          ))}
          <SelectItem value={NEW_SUPPLIER}>
            <span className="flex items-center gap-1 text-primary">
              <Plus className="h-3 w-3" /> {t('Add New Supplier')}
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('New Supplier')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t('Supplier Name')}</Label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t('Enter supplier name')}
                autoFocus
              />
            </div>
            <div>
              <Label>{t('Phone')}</Label>
              <Input
                value={newPhone}
                onChange={e => setNewPhone(e.target.value)}
                placeholder={t('Optional')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNew(false)}>
              {t('Cancel')}
            </Button>
            <Button onClick={handleCreateSupplier} disabled={!newName.trim() || saving}>
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
