import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Plus, Search, Pencil, Power, PowerOff, Loader2, Building2, Trash2,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/api';
import type { Supplier } from '@/api/types';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Supplier Form Dialog ──────────────────────────────────────────────────

interface SupplierFormDialogProps {
  open: boolean;
  onClose: () => void;
  supplier: Supplier | null; // null = create mode
  onSaved: () => void;
}

function SupplierFormDialog({ open, onClose, supplier, onSaved }: SupplierFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(supplier?.name ?? '');
      setPhone(supplier?.phone ?? '');
      setAddress(supplier?.address ?? '');
      setNotes(supplier?.notes ?? '');
    }
  }, [open, supplier]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('Supplier name is required'));
      return;
    }

    setSaving(true);
    try {
      if (supplier) {
        await api.suppliers.update(supplier.id, {
          name: trimmedName,
          phone: phone.trim() || null,
          address: address.trim() || null,
          notes: notes.trim() || null,
        } as Partial<Supplier>);
        toast.success(t('Supplier updated successfully'));
      } else {
        await api.suppliers.create({
          name: trimmedName,
          phone: phone.trim() || null,
          address: address.trim() || null,
          notes: notes.trim() || null,
        } as Partial<Supplier>);
        toast.success(t('Supplier created successfully'));
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save supplier'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{supplier ? t('Edit Supplier') : t('Add Supplier')}</DialogTitle>
          <DialogDescription>
            {supplier ? t('Update supplier details.') : t('Enter the new supplier details.')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sup-name">
                {t('Name')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="sup-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('Supplier name')}
                autoFocus
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-phone">{t('Supplier Phone')}</Label>
              <Input
                id="sup-phone"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder={t('Phone number')}
                maxLength={30}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-address">{t('Supplier Address')}</Label>
              <Input
                id="sup-address"
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder={t('Address')}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-notes">{t('Supplier Notes')}</Label>
              <Textarea
                id="sup-notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={t('Notes')}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
              {supplier ? t('Save Changes') : t('Add Supplier')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

export function SupplierManagementTab() {
  const { t } = useTranslation();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 250);

  // Form dialog
  const [formOpen, setFormOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  // Deactivate confirmation
  const [confirmTarget, setConfirmTarget] = useState<Supplier | null>(null);
  const [toggling, setToggling] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = useAuthStore((s) => s.currentUser?.role === 'admin');

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.suppliers.getAll(true); // include inactive
      setSuppliers(Array.isArray(data) ? data : []);
    } catch {
      setSuppliers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSuppliers(); }, [fetchSuppliers]);

  const filtered = useMemo(() => {
    if (!debouncedSearch) return suppliers;
    const q = debouncedSearch.toLowerCase();
    return suppliers.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.phone && s.phone.includes(q)) ||
      (s.address && s.address.toLowerCase().includes(q))
    );
  }, [suppliers, debouncedSearch]);

  const handleEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setFormOpen(true);
  };

  const handleAdd = () => {
    setEditingSupplier(null);
    setFormOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.suppliers.delete(deleteTarget.id);
      toast.success(t('Supplier deleted'));
      fetchSuppliers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete supplier'));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleToggleActive = async () => {
    if (!confirmTarget) return;
    setToggling(true);
    try {
      const newActive = confirmTarget.is_active ? 0 : 1;
      await api.suppliers.update(confirmTarget.id, { is_active: newActive } as Partial<Supplier>);
      toast.success(newActive ? t('Supplier activated') : t('Supplier deactivated'));
      fetchSuppliers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update supplier'));
    } finally {
      setToggling(false);
      setConfirmTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('Search supplier name, phone...')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="h-9 ps-9"
          />
        </div>
        <Button size="sm" onClick={handleAdd} className="gap-1">
          <Plus className="h-4 w-4" />
          {t('Add Supplier')}
        </Button>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Building2 className="mb-2 h-10 w-10" />
          <p>{debouncedSearch ? t('No suppliers match your search') : t('No suppliers yet')}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 text-center">#</TableHead>
                <TableHead>{t('Name')}</TableHead>
                <TableHead>{t('Supplier Phone')}</TableHead>
                <TableHead>{t('Supplier Address')}</TableHead>
                <TableHead>{t('Supplier Notes')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead className="text-end">{t('Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((s, idx) => (
                <TableRow key={s.id} className={cn(!s.is_active && 'opacity-50')}>
                  <TableCell className="text-center text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.phone || '-'}</TableCell>
                  <TableCell className="max-w-[200px] truncate">{s.address || '-'}</TableCell>
                  <TableCell className="max-w-[200px] truncate">{s.notes || '-'}</TableCell>
                  <TableCell>
                    <Badge variant={s.is_active ? 'default' : 'secondary'}>
                      {s.is_active ? t('Active') : t('Inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={() => handleEdit(s)}
                        title={t('Edit Supplier')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={() => setConfirmTarget(s)}
                        title={s.is_active ? t('Deactivate Supplier') : t('Activate Supplier')}
                      >
                        {s.is_active
                          ? <PowerOff className="h-3.5 w-3.5 text-destructive" />
                          : <Power className="h-3.5 w-3.5 text-emerald-600" />
                        }
                      </Button>
                      {isAdmin && (
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => setDeleteTarget(s)}
                          title={t('Delete Supplier')}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {filtered.length} {t('suppliers')}
        {filtered.length !== suppliers.length && ` / ${suppliers.length} ${t('total')}`}
      </p>

      {/* Form Dialog */}
      <SupplierFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        supplier={editingSupplier}
        onSaved={fetchSuppliers}
      />

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('Delete Supplier')}</DialogTitle>
            <DialogDescription>
              {t('Permanently delete this supplier? This cannot be undone.')}
              {deleteTarget && (
                <span className="mt-1 block font-medium text-foreground">{deleteTarget.name}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate/Activate Confirmation */}
      <Dialog open={!!confirmTarget} onOpenChange={(o) => { if (!o) setConfirmTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmTarget?.is_active ? t('Deactivate Supplier') : t('Activate Supplier')}
            </DialogTitle>
            <DialogDescription>
              {confirmTarget?.is_active
                ? t('Are you sure you want to deactivate this supplier?')
                : t('Are you sure you want to activate this supplier?')
              }
              {confirmTarget && (
                <span className="mt-1 block font-medium text-foreground">{confirmTarget.name}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)} disabled={toggling}>
              {t('Cancel')}
            </Button>
            <Button
              variant={confirmTarget?.is_active ? 'destructive' : 'default'}
              onClick={handleToggleActive}
              disabled={toggling}
            >
              {toggling && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
              {t('Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
