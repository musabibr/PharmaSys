import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { api } from '@/api';
import type { Product, PurchaseOrderDetail, PurchaseOrderInput, Supplier } from '@/api/types';
import { loadProducts } from '@/stores/products.store';
import { formatCost, formatCurrency } from '@/lib/utils';
import { toLocalISODate } from '../../../core/common/dates';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DateField } from '@/components/ui/date-field';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface Line {
  key: string;
  product_id: number;
  quantity: number;
  /** Text as typed; empty means "use the last invoice cost". */
  cost: string;
}

/** Create a purchase order, or edit one that is still a draft. */
export function PurchaseOrderDialog({ open, onOpenChange, order, initialSupplierId, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A draft to edit; omit to create. */
  order?: PurchaseOrderDetail | null;
  initialSupplierId?: number;
  onSaved: (order: PurchaseOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const today = toLocalISODate(new Date());
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [expectedDate, setExpectedDate] = useState('');
  const [datesValid, setDatesValid] = useState({ order: true, expected: true });
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.suppliers.getAll().then(setSuppliers).catch(() => setSuppliers([]));
    loadProducts().then(setProducts).catch(() => setProducts([]));
    setSupplierId(order ? String(order.supplier_id) : initialSupplierId ? String(initialSupplierId) : '');
    setOrderDate(order?.order_date ?? today);
    setExpectedDate(order?.expected_date ?? '');
    setNotes(order?.notes ?? '');
    setLines((order?.items ?? []).map(i => ({
      key: crypto.randomUUID(), product_id: i.product_id, quantity: i.quantity,
      cost: i.expected_cost_parent === null ? '' : String(i.expected_cost_parent),
    })));
  }, [open, order, initialSupplierId, today]);

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const taken = useMemo(() => new Set(lines.map(l => l.product_id)), [lines]);
  const productOptions = useMemo(
    () => products.filter(p => p.is_active !== 0 && !taken.has(p.id)).map(p => ({ value: String(p.id), label: p.name, keywords: [p.generic_name, p.barcode].filter(Boolean).join(' ') })),
    [products, taken],
  );

  const addProduct = (value: string) => {
    const id = Number(value);
    if (!id || taken.has(id)) return;
    setLines(prev => [...prev, { key: crypto.randomUUID(), product_id: id, quantity: 1, cost: '' }]);
  };
  const update = (key: string, patch: Partial<Line>) => setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)));

  /** null when empty (use the last cost), NaN when the text is not a number. */
  const costOf = (l: Line) => {
    if (l.cost.trim() === '') return null;
    const n = Number(l.cost.trim());
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
  };
  const invalidCost = lines.some(l => { const c = costOf(l); return c !== null && !(c >= 0); });
  const invalidQty = lines.some(l => !Number.isInteger(l.quantity) || l.quantity < 1);
  const knownValue = lines.reduce((s, l) => s + l.quantity * (costOf(l) || 0), 0);
  const canSave = !!supplierId && lines.length > 0 && !invalidCost && !invalidQty && datesValid.order && datesValid.expected && !saving;

  const save = async () => {
    if (!canSave) return;
    const input: PurchaseOrderInput = {
      supplier_id: Number(supplierId),
      order_date: orderDate || null,
      expected_date: expectedDate || null,
      notes: notes.trim() || null,
      items: lines.map(l => ({ product_id: l.product_id, quantity: l.quantity, expected_cost_parent: costOf(l) })),
    };
    setSaving(true);
    try {
      const saved = order ? await api.purchaseOrders.update(order.id, input) : await api.purchaseOrders.create(input);
      toast.success(order ? t('Order saved') : t('Order {{number}} created', { number: saved.po_number }));
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save the order'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{order ? t('Edit {{number}}', { number: order.po_number }) : t('New purchase order')}</DialogTitle>
          <DialogDescription>{t('Leave the expected cost empty to use the last invoice cost from this supplier.')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-3">
            <Label>{t('Supplier')}</Label>
            <Combobox
              value={supplierId}
              onValueChange={setSupplierId}
              placeholder={t('Select supplier')}
              searchPlaceholder={t('Search suppliers...')}
              emptyText={t('No suppliers found')}
              options={suppliers.map(s => ({ value: String(s.id), label: s.name }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('Order date')}</Label>
            <DateField value={orderDate} onChange={setOrderDate} max={today}
              onValidityChange={v => setDatesValid(d => (d.order === v ? d : { ...d, order: v }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('Expected delivery')}</Label>
            <DateField value={expectedDate} onChange={setExpectedDate} min={orderDate || undefined}
              onValidityChange={v => setDatesValid(d => (d.expected === v ? d : { ...d, expected: v }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('Add product')}</Label>
            <Combobox
              value=""
              onValueChange={addProduct}
              placeholder={t('Search products...')}
              searchPlaceholder={t('Search products...')}
              emptyText={t('No products found')}
              options={productOptions}
            />
          </div>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Product')}</TableHead>
                <TableHead className="w-28 text-end">{t('Quantity')}</TableHead>
                <TableHead className="w-36 text-end">{t('Expected cost')}</TableHead>
                <TableHead className="w-28 text-end">{t('Value')}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">{t('Add the products to order')}</TableCell></TableRow>
              )}
              {lines.map(l => {
                const p = productById.get(l.product_id);
                const cost = costOf(l);
                return (
                  <TableRow key={l.key}>
                    <TableCell className="font-medium">
                      {p?.name ?? `#${l.product_id}`}
                      <span className="block text-xs text-muted-foreground">{p?.parent_unit ?? ''}</span>
                    </TableCell>
                    <TableCell>
                      <Input type="number" min={1} step={1} className="h-8 text-end" value={l.quantity || ''}
                        aria-invalid={!Number.isInteger(l.quantity) || l.quantity < 1}
                        onChange={e => update(l.key, { quantity: Math.floor(Number(e.target.value) || 0) })} />
                    </TableCell>
                    <TableCell>
                      <Input inputMode="decimal" className="h-8 text-end" value={l.cost} placeholder={t('Last cost')}
                        aria-invalid={cost !== null && !(cost >= 0)}
                        onChange={e => update(l.key, { cost: e.target.value })} />
                    </TableCell>
                    <TableCell className="text-end text-sm tabular-nums">{cost === null || Number.isNaN(cost) ? '—' : formatCost(cost * l.quantity)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setLines(prev => prev.filter(x => x.key !== l.key))} title={t('Remove')}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {lines.length > 0 && (
          <p className="text-end text-sm text-muted-foreground">
            {t('Known value')}: <span className="font-semibold tabular-nums text-foreground">{formatCurrency(Math.round(knownValue))}</span>
          </p>
        )}

        <div className="space-y-1.5">
          <Label>{t('Notes')}</Label>
          <Textarea rows={2} maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
          <Button onClick={() => void save()} disabled={!canSave} className="gap-1">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {order ? t('Save') : t('Create order')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
