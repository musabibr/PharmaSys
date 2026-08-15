import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Product, Batch, ProductMovements, AuditEntry } from '@/api/types';
import { formatCurrency, formatCost, formatDate, formatQuantity, unitLabel, displayInvoiceId } from '@/lib/utils';
import { actionLabel, actionBadgeVariant, summarizeFieldNames } from '@/lib/audit';
import { AuditDetailDialog } from '@/components/admin/AuditDetailDialog';
import { usePermission, useIsAdmin } from '@/hooks/usePermission';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ProductForm } from './ProductForm';
import { BatchForm } from './BatchForm';
import { DamageReportForm } from './DamageReportForm';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  ArrowLeft, Pencil, Plus, DollarSign, Power, PowerOff, Loader2,
  AlertTriangle, Trash2, ShieldAlert,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Update-prices-by-product — small scoped dialog for the "Price updates"
// profile action. Calls the same endpoint BatchForm's "also update existing
// batches" checkbox uses, but as a direct, explicit action (D1: this clears
// per-batch overrides so the new price actually reaches the till).
// ---------------------------------------------------------------------------

function UpdatePricesDialog({
  open, onOpenChange, product, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const hasChildUnit = product.conversion_factor > 1;
  const [parentPrice, setParentPrice] = useState('');
  const [childPrice, setChildPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setParentPrice(product.selling_price != null ? String(product.selling_price) : '');
      setChildPrice(product.selling_price_child != null ? String(product.selling_price_child) : '');
      setError('');
    }
  }, [open, product]);

  async function handleSave() {
    const parent = Math.round(Number(parentPrice));
    if (!Number.isFinite(parent) || parent <= 0) {
      setError(t('Enter a valid selling price'));
      return;
    }
    const child = childPrice.trim() ? Math.round(Number(childPrice)) : undefined;
    setSaving(true);
    setError('');
    try {
      const count = await api.batches.updatePricesByProduct({
        productId: product.id,
        sellingPriceParent: parent,
        ...(hasChildUnit && child ? { sellingPriceChild: child } : {}),
      });
      toast.success(t('Updated price on {{count}} active batch(es)', { count }));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to update prices'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Update Prices')}</DialogTitle>
          <DialogDescription>
            {t('Applies to every active batch of {{name}} and clears any per-batch price override, so the new price reaches the till immediately.', { name: product.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('Selling price')} ({unitLabel(product.parent_unit, t)})</Label>
            <Input type="number" min={1} value={parentPrice} onChange={(e) => setParentPrice(e.target.value)} autoFocus />
          </div>
          {hasChildUnit && (
            <div className="space-y-1.5">
              <Label>{t('Selling price')} ({unitLabel(product.child_unit, t)}) <span className="text-muted-foreground">({t('optional — derived if blank')})</span></Label>
              <Input type="number" min={0} value={childPrice} onChange={(e) => setChildPrice(e.target.value)} />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('Cancel')}</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Update Prices')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ProductProfilePage — the single place to see everything about one product
// (stock, pricing, sales, purchases, adjustments, audit trail) and act on it
// (edit, manage batches, re-price, deactivate). Reached from Stock Ledger.
// ---------------------------------------------------------------------------

export function ProductProfilePage() {
  const { productId } = useParams<{ productId: string }>();
  const id = Number(productId);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isAdmin = useIsAdmin();
  const canManageProducts = usePermission('inventory.products.manage');
  const canDeleteProduct = usePermission('inventory.products.delete');
  const canManageBatches = usePermission('inventory.batches.manage');
  const canReportDamage = usePermission('inventory.batches.damage');

  const [product, setProduct] = useState<Product | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(true);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [movements, setMovements] = useState<ProductMovements | null>(null);
  const [loadingMovements, setLoadingMovements] = useState(true);
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [productFormOpen, setProductFormOpen] = useState(false);
  const [batchFormOpen, setBatchFormOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [damageBatch, setDamageBatch] = useState<Batch | null>(null);
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadProduct = useCallback(async () => {
    if (!id) return;
    setLoadingProduct(true);
    try { setProduct(await api.products.getById(id)); }
    catch { toast.error(t('Failed to load product')); setProduct(null); }
    finally { setLoadingProduct(false); }
  }, [id, t]);

  const loadBatches = useCallback(async () => {
    if (!id) return;
    setLoadingBatches(true);
    try { setBatches(await api.batches.getByProduct(id)); }
    catch { setBatches([]); }
    finally { setLoadingBatches(false); }
  }, [id]);

  const loadMovements = useCallback(async () => {
    if (!id) return;
    setLoadingMovements(true);
    try { setMovements(await api.reports.productMovements(id)); }
    catch { setMovements({ purchases: [], sales: [], adjustments: [] }); }
    finally { setLoadingMovements(false); }
  }, [id]);

  const loadHistory = useCallback(async () => {
    if (!id || !isAdmin) return;
    setLoadingHistory(true);
    try { setHistory(await api.audit.getProductHistory(id)); }
    catch { setHistory([]); }
    finally { setLoadingHistory(false); }
  }, [id, isAdmin]);

  useEffect(() => { loadProduct(); }, [loadProduct]);
  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { loadMovements(); }, [loadMovements]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const pUnit = unitLabel(product?.parent_unit, t);
  const cUnit = unitLabel(product?.child_unit, t);
  const cf = product?.conversion_factor ?? 1;
  const qtyBase = (base: number) => formatQuantity(base, pUnit, cUnit, cf);
  const totalStock = batches.filter(b => b.status === 'active').reduce((s, b) => s + b.quantity_base, 0);

  // ---- Actions ----

  async function handleDeactivate() {
    if (!product) return;
    const ok = await confirm({
      title: t('Deactivate product?'),
      description: t('{{name}} will be hidden from POS and new purchases. Existing stock and history are kept, and it can be reactivated at any time.', { name: product.name }),
      destructive: true,
      confirmLabel: t('Deactivate'),
    });
    if (!ok) return;
    try {
      await api.products.delete(product.id);
      toast.success(t('Product deactivated'));
      loadProduct();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to deactivate product'));
    }
  }

  async function handleReactivate() {
    if (!product) return;
    try {
      await api.products.update(product.id, { is_active: 1 });
      toast.success(t('Product reactivated'));
      loadProduct();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to reactivate product'));
    }
  }

  async function handleDeleteBatch(batch: Batch) {
    const info = await api.batches.getDeleteInfo(batch.id).catch(() => undefined);
    const qty = info?.quantity_base ?? batch.quantity_base;
    const hasHistory = (info?.txn_count ?? 0) > 0 || (info?.adj_count ?? 0) > 0;
    const description = hasHistory
      ? t('This batch has transaction or adjustment history and cannot be deleted.')
      : qty > 0
        ? t('This batch still has {{qty}} units in stock. Report damage/expiry to zero it first, then delete.', { qty })
        : t('Batch {{number}} will be permanently removed. This cannot be undone.', { number: batch.batch_number || `#${batch.id}` });
    const ok = await confirm({
      title: t('Delete batch?'),
      description,
      destructive: true,
      confirmLabel: t('Delete'),
    });
    if (!ok) return;
    const result = await api.batches.bulkDelete([batch.id]);
    if (result.deleted.length > 0) {
      toast.success(t('Batch deleted'));
      loadBatches();
    } else {
      toast.error(result.errors[0]?.reason || t('Failed to delete batch'));
    }
  }

  function openDetail(entry: AuditEntry) {
    setDetailEntry(entry);
    setDetailOpen(true);
  }

  // ---- Render ----

  if (loadingProduct) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-sm font-medium text-muted-foreground">{t('Product not found')}</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/stock-ledger')}>
          <ArrowLeft className="me-1.5 h-4 w-4" />
          {t('Back to Stock Ledger')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('/stock-ledger')} className="-ms-2 gap-1.5">
        <ArrowLeft className="h-4 w-4" />
        {t('Stock Ledger')}
      </Button>

      {/* ---- Profile header ---- */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight">{product.name}</h1>
                <Badge variant={product.is_active ? 'success' : 'secondary'}>
                  {product.is_active ? t('Active') : t('Inactive')}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {product.category_name ?? t('Uncategorized')}
                {product.generic_name && <> · {product.generic_name}</>}
                {product.barcode && <> · {product.barcode}</>}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {canManageProducts && (
                <Button variant="outline" size="sm" onClick={() => setProductFormOpen(true)} className="gap-1.5">
                  <Pencil className="h-4 w-4" /> {t('Edit Product')}
                </Button>
              )}
              {canManageBatches && (
                <Button variant="outline" size="sm" onClick={() => { setEditingBatch(null); setBatchFormOpen(true); }} className="gap-1.5">
                  <Plus className="h-4 w-4" /> {t('Add Batch')}
                </Button>
              )}
              {canManageBatches && (
                <Button variant="outline" size="sm" onClick={() => setPriceDialogOpen(true)} className="gap-1.5">
                  <DollarSign className="h-4 w-4" /> {t('Update Prices')}
                </Button>
              )}
              {canDeleteProduct && (
                product.is_active ? (
                  <Button variant="outline" size="sm" onClick={handleDeactivate} className="gap-1.5 text-destructive hover:text-destructive">
                    <PowerOff className="h-4 w-4" /> {t('Deactivate')}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={handleReactivate} className="gap-1.5">
                    <Power className="h-4 w-4" /> {t('Reactivate')}
                  </Button>
                )
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 border-t pt-3 sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">{t('On hand')}</p>
              <p className="text-lg font-semibold tabular-nums">{qtyBase(totalStock)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('Selling price')} ({pUnit})</p>
              <p className="text-lg font-semibold tabular-nums">{formatCurrency(product.selling_price ?? 0)}</p>
            </div>
            {cf > 1 && (
              <div>
                <p className="text-xs text-muted-foreground">{t('Selling price')} ({cUnit})</p>
                <p className="text-lg font-semibold tabular-nums">{formatCurrency(product.selling_price_child ?? 0)}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-muted-foreground">{t('Min stock level')}</p>
              <p className="text-lg font-semibold tabular-nums">{qtyBase(product.min_stock_level)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Tabs ---- */}
      <Tabs defaultValue="batches">
        <TabsList>
          <TabsTrigger value="batches">{t('Batches')} ({batches.length})</TabsTrigger>
          <TabsTrigger value="purchases">{t('Purchases')} ({movements?.purchases.length ?? 0})</TabsTrigger>
          <TabsTrigger value="sales">{t('Sales details')} ({movements?.sales.length ?? 0})</TabsTrigger>
          <TabsTrigger value="adjustments">{t('Adjustments')} ({movements?.adjustments.length ?? 0})</TabsTrigger>
          {isAdmin && <TabsTrigger value="history">{t('History')} ({history?.length ?? 0})</TabsTrigger>}
        </TabsList>

        {/* ── Batches: the "manage batches" operations ── */}
        <TabsContent value="batches" className="mt-3">
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Batch')}</TableHead>
                  <TableHead>{t('Expiry')}</TableHead>
                  <TableHead className="text-end">{t('Quantity')}</TableHead>
                  <TableHead className="text-end">{t('Cost')}</TableHead>
                  <TableHead className="text-end">{t('Selling Price')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead className="text-end">{t('Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingBatches ? (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{t('Loading...')}</TableCell></TableRow>
                ) : batches.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{t('No batches yet')}</TableCell></TableRow>
                ) : batches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">{b.batch_number || `#${b.id}`}</TableCell>
                    <TableCell>{formatDate(b.expiry_date)}</TableCell>
                    <TableCell className="text-end tabular-nums">{qtyBase(b.quantity_base)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCost(b.cost_per_parent)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(b.selling_price_parent_override || b.selling_price_parent || 0)}</TableCell>
                    <TableCell>
                      <Badge variant={b.status === 'active' ? 'success' : b.status === 'quarantine' ? 'warning' : 'secondary'}>
                        {t(b.status.charAt(0).toUpperCase() + b.status.slice(1))}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        {canManageBatches && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" title={t('Edit')} onClick={() => { setEditingBatch(b); setBatchFormOpen(true); }}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canReportDamage && b.quantity_base > 0 && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" title={t('Report Damage')} onClick={() => setDamageBatch(b)}>
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canManageBatches && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" title={t('Delete')} onClick={() => handleDeleteBatch(b)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── Purchases ── */}
        <TabsContent value="purchases" className="mt-3">
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Date')}</TableHead>
                  <TableHead>{t('Invoice')}</TableHead>
                  <TableHead>{t('Supplier')}</TableHead>
                  <TableHead className="text-end">{t('Qty')}</TableHead>
                  <TableHead className="text-end">{t('Cost')}</TableHead>
                  <TableHead className="text-end">{t('Total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMovements ? (
                  <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{t('Loading...')}</TableCell></TableRow>
                ) : (movements?.purchases.length ?? 0) === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{t('No purchases')}</TableCell></TableRow>
                ) : movements!.purchases.map((p, i) => (
                  <TableRow key={i}>
                    <TableCell>{formatDate(p.purchase_date)}</TableCell>
                    <TableCell>{displayInvoiceId({ invoice_reference: p.invoice_reference, purchase_number: p.purchase_number })}</TableCell>
                    <TableCell>{p.supplier_name ?? '—'}</TableCell>
                    <TableCell className="text-end tabular-nums">{p.quantity_received} {pUnit}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCost(p.cost_per_parent)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(p.line_total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── Sales ── */}
        <TabsContent value="sales" className="mt-3">
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Date')}</TableHead>
                  <TableHead>{t('Transaction')}</TableHead>
                  <TableHead>{t('Type')}</TableHead>
                  <TableHead className="text-end">{t('Qty')}</TableHead>
                  <TableHead className="text-end">{t('Price')}</TableHead>
                  <TableHead className="text-end">{t('Total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMovements ? (
                  <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{t('Loading...')}</TableCell></TableRow>
                ) : (movements?.sales.length ?? 0) === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{t('No sales')}</TableCell></TableRow>
                ) : movements!.sales.map((s, i) => (
                  <TableRow key={i} className={s.is_voided ? 'line-through opacity-60' : undefined}>
                    <TableCell>{formatDate(s.created_at.slice(0, 10))}</TableCell>
                    <TableCell>{s.transaction_number}</TableCell>
                    <TableCell>
                      <Badge variant={s.transaction_type === 'return' ? 'destructive' : 'secondary'}>
                        {t(s.transaction_type === 'return' ? 'Return' : 'Sale')}
                      </Badge>
                      {s.is_voided ? <span className="ms-1 text-xs">({t('Voided')})</span> : null}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{qtyBase(s.quantity_base)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(s.unit_price)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(s.line_total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── Adjustments ── */}
        <TabsContent value="adjustments" className="mt-3">
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Date')}</TableHead>
                  <TableHead>{t('Reason')}</TableHead>
                  <TableHead>{t('User')}</TableHead>
                  <TableHead className="text-end">{t('Change')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMovements ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{t('Loading...')}</TableCell></TableRow>
                ) : (movements?.adjustments.length ?? 0) === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{t('No adjustments')}</TableCell></TableRow>
                ) : movements!.adjustments.map((a, i) => {
                  const removed = a.quantity_base > 0;
                  return (
                    <TableRow key={i}>
                      <TableCell>{formatDate(a.created_at.slice(0, 10))}</TableCell>
                      <TableCell>{a.reason?.trim() || t(a.type.charAt(0).toUpperCase() + a.type.slice(1))}</TableCell>
                      <TableCell>{a.username ?? '—'}</TableCell>
                      <TableCell className={`text-end tabular-nums font-medium ${removed ? 'text-destructive' : 'text-emerald-600'}`}>
                        {removed ? '−' : '+'}{qtyBase(Math.abs(a.quantity_base))}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── History: product edits + this product's batch events (I4) ── */}
        {isAdmin && (
          <TabsContent value="history" className="mt-3">
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Date')}</TableHead>
                    <TableHead>{t('Action')}</TableHead>
                    <TableHead>{t('Change')}</TableHead>
                    <TableHead>{t('User')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingHistory ? (
                    <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{t('Loading...')}</TableCell></TableRow>
                  ) : (history?.length ?? 0) === 0 ? (
                    <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{t('No history found')}</TableCell></TableRow>
                  ) : history!.map((h) => (
                    <TableRow key={h.id} className="cursor-pointer" onClick={() => openDetail(h)}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(h.created_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge variant={actionBadgeVariant(h.action)}>{t(actionLabel(h.action))}</Badge>
                        {h.batch_number && <span className="ms-1 text-xs text-muted-foreground">({h.batch_number})</span>}
                      </TableCell>
                      <TableCell className="max-w-[360px] truncate text-xs text-muted-foreground" title={t('Click to see full before/after values')}>
                        {summarizeFieldNames(h.old_values, h.new_values) || '—'}
                      </TableCell>
                      <TableCell className="text-sm">{h.username || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        )}
      </Tabs>

      {/* ---- Action dialogs ---- */}
      <ProductForm
        open={productFormOpen}
        onOpenChange={setProductFormOpen}
        product={product}
        onSaved={loadProduct}
      />
      <BatchForm
        open={batchFormOpen}
        onOpenChange={setBatchFormOpen}
        productId={product.id}
        productName={product.name}
        parentUnit={pUnit}
        childUnit={cUnit}
        conversionFactor={cf}
        batch={editingBatch}
        onSaved={loadBatches}
      />
      <DamageReportForm
        open={!!damageBatch}
        onOpenChange={(o) => { if (!o) setDamageBatch(null); }}
        batch={damageBatch}
        productName={product.name}
        parentUnit={pUnit}
        childUnit={cUnit}
        conversionFactor={cf}
        onSaved={() => { loadBatches(); loadMovements(); }}
      />
      <UpdatePricesDialog
        open={priceDialogOpen}
        onOpenChange={setPriceDialogOpen}
        product={product}
        onSaved={() => { loadProduct(); loadBatches(); }}
      />
      <AuditDetailDialog open={detailOpen} onOpenChange={setDetailOpen} entry={detailEntry} />
    </div>
  );
}
