import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '@/api';
import type { ProductMovements, ProductStockLedgerRow } from '@/api/types';
import { formatCurrency, formatCost, formatDate, formatQuantity, unitLabel, displayInvoiceId } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductStockLedgerRow | null;
}

/** Human label for an adjustment record (reason first, then type). */
function adjustmentLabel(a: ProductMovements['adjustments'][number], t: (k: string) => string): string {
  if (a.reason && a.reason.trim()) return a.reason;
  return t(a.type.charAt(0).toUpperCase() + a.type.slice(1));
}

export function ProductMovementsDialog({ open, onOpenChange, product }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<ProductMovements | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !product) return;
    setLoading(true);
    setData(null);
    api.reports.productMovements(product.product_id)
      .then(setData)
      .catch(() => setData({ purchases: [], sales: [], adjustments: [] }))
      .finally(() => setLoading(false));
  }, [open, product]);

  const pUnit = unitLabel(product?.parent_unit, t);
  const cUnit = unitLabel(product?.child_unit, t);
  const cf = product?.conversion_factor ?? 1;
  const qtyBase = (base: number) => formatQuantity(base, pUnit, cUnit, cf);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{product?.name ?? t('Product movements')}</DialogTitle>
          <DialogDescription>{t('Purchases, sales, and adjustments for this product.')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="me-2 h-5 w-5 animate-spin" /> {t('Loading...')}
          </div>
        ) : (
          <Tabs defaultValue="purchases" className="flex-1 min-h-0 flex flex-col">
            <TabsList>
              <TabsTrigger value="purchases">{t('Purchases')} ({data?.purchases.length ?? 0})</TabsTrigger>
              <TabsTrigger value="sales">{t('Sales details')} ({data?.sales.length ?? 0})</TabsTrigger>
              <TabsTrigger value="adjustments">{t('Adjustments')} ({data?.adjustments.length ?? 0})</TabsTrigger>
            </TabsList>

            {/* ── Purchases ── */}
            <TabsContent value="purchases" className="flex-1 min-h-0 overflow-auto">
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
                  {(data?.purchases.length ?? 0) === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{t('No purchases')}</TableCell></TableRow>
                  ) : data!.purchases.map((p, i) => (
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
            </TabsContent>

            {/* ── Sales ── */}
            <TabsContent value="sales" className="flex-1 min-h-0 overflow-auto">
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
                  {(data?.sales.length ?? 0) === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{t('No sales')}</TableCell></TableRow>
                  ) : data!.sales.map((s, i) => (
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
            </TabsContent>

            {/* ── Adjustments (with reasons) ── */}
            <TabsContent value="adjustments" className="flex-1 min-h-0 overflow-auto">
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
                  {(data?.adjustments.length ?? 0) === 0 ? (
                    <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{t('No adjustments')}</TableCell></TableRow>
                  ) : data!.adjustments.map((a, i) => {
                    // Convention: quantity_base > 0 = stock removed, < 0 = added.
                    const removed = a.quantity_base > 0;
                    return (
                      <TableRow key={i}>
                        <TableCell>{formatDate(a.created_at.slice(0, 10))}</TableCell>
                        <TableCell>{adjustmentLabel(a, t)}</TableCell>
                        <TableCell>{a.username ?? '—'}</TableCell>
                        <TableCell className={`text-end tabular-nums font-medium ${removed ? 'text-destructive' : 'text-emerald-600'}`}>
                          {removed ? '−' : '+'}{qtyBase(Math.abs(a.quantity_base))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
