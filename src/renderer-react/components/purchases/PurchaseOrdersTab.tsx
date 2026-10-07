import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ClipboardCopy, FileText, Loader2, PackageCheck, Pencil, Plus, Printer, RefreshCw, Search, Send, XCircle } from 'lucide-react';
import { api } from '@/api';
import type {
  PaginatedResult, PurchaseOrder, PurchaseOrderDetail, PurchaseOrderDisplayStatus, PurchaseOrderReceivePrefill, PurchaseOrderStatus, Supplier,
} from '@/api/types';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { cn, formatCost, formatCurrency, formatDate } from '@/lib/utils';
import { escapeHtml, printHtml } from '@/lib/print';
import { toLocalISODate } from '../../../core/common/dates';
import { usePrompt } from '@/components/ui/prompt-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { DataPagination } from '@/components/ui/data-pagination';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { PurchaseOrderDialog } from './PurchaseOrderDialog';

const ALL = '__all__';
const PAGE_SIZE = 20;

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_received: 'Partly received',
  received: 'Fully received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const STATUS_VARIANT: Record<PurchaseOrderDisplayStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline', sent: 'default', partially_received: 'default', received: 'secondary', closed: 'secondary', cancelled: 'destructive',
};

/** Where the order is receivable, what the page does with "Receive". */
export type ReceiveOrder = (prefill: PurchaseOrderReceivePrefill & { po_number: string; supplier_name?: string }) => void;

/** Purchase orders (L4): what was ordered from whom, and how much of it has arrived. */
export function PurchaseOrdersTab({ onReceive, onOpenInvoice }: { onReceive?: ReceiveOrder; onOpenInvoice?: (purchaseId: number) => void }) {
  const { t } = useTranslation();
  const canManage = usePermission('purchases.manage');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplier, setSupplier] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaginatedResult<PurchaseOrder> | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const today = toLocalISODate(new Date());

  useEffect(() => { api.suppliers.getAll().then(setSuppliers).catch(() => setSuppliers([])); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await api.purchaseOrders.list({
        supplier_id: supplier !== ALL ? Number(supplier) : undefined,
        status: status !== ALL ? status as PurchaseOrderStatus : undefined,
        search: debouncedSearch.trim() || undefined,
        page,
        limit: PAGE_SIZE,
      }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load purchase orders'));
    } finally {
      setLoading(false);
    }
  }, [supplier, status, debouncedSearch, page, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [supplier, status, debouncedSearch]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Order number, supplier or product...')} />
          </div>
          <div className="w-48">
            <Combobox
              value={supplier}
              onValueChange={setSupplier}
              allOption={t('All Suppliers')}
              allValue={ALL}
              searchPlaceholder={t('Search suppliers...')}
              emptyText={t('No suppliers found')}
              options={suppliers.map(s => ({ value: String(s.id), label: s.name }))}
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('All statuses')}</SelectItem>
              <SelectItem value="draft">{t('Draft')}</SelectItem>
              <SelectItem value="sent">{t('Open (sent)')}</SelectItem>
              <SelectItem value="closed">{t('Closed')}</SelectItem>
              <SelectItem value="cancelled">{t('Cancelled')}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void load()} title={t('Refresh')}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          {canManage && (
            <Button className="gap-1" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />{t('New order')}
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Order')}</TableHead>
              <TableHead>{t('Date')}</TableHead>
              <TableHead>{t('Supplier')}</TableHead>
              <TableHead>{t('Expected delivery')}</TableHead>
              <TableHead className="text-end">{t('Lines')}</TableHead>
              <TableHead className="text-end">{t('Arrived')}</TableHead>
              <TableHead className="text-end">{t('Expected value')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result && result.data.length === 0 && (
              <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">{t('No purchase orders yet')}</TableCell></TableRow>
            )}
            {result?.data.map(po => {
              const ordered = po.ordered_units ?? 0;
              const arrived = po.received_units ?? 0;
              const late = po.status === 'sent' && po.expected_date && po.expected_date < today && arrived < ordered;
              return (
                <TableRow key={po.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setDetailId(po.id)}>
                  <TableCell className="font-medium">{po.po_number}</TableCell>
                  <TableCell>{formatDate(po.order_date)}</TableCell>
                  <TableCell>{po.supplier_name}</TableCell>
                  <TableCell className={cn(late && 'font-medium text-destructive')}>
                    {po.expected_date ? formatDate(po.expected_date) : '—'}{late ? ` · ${t('Late')}` : ''}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{po.lines ?? 0}</TableCell>
                  <TableCell className="text-end tabular-nums">{ordered > 0 ? `${Math.round((arrived / ordered) * 100)}%` : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(Math.round(po.expected_value ?? 0))}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[po.display_status]}>{t(PURCHASE_ORDER_STATUS_LABELS[po.display_status])}</Badge></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {result && result.totalPages > 1 && (
        <DataPagination page={page} totalPages={result.totalPages} total={result.total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      )}

      <PurchaseOrderDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={(d) => { void load(); setDetailId(d.id); }} />
      <PurchaseOrderDetailDialog
        orderId={detailId}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
        onChanged={() => void load()}
        onReceive={onReceive}
        onOpenInvoice={onOpenInvoice}
      />
    </div>
  );
}

export function PurchaseOrderDetailDialog({ orderId, onOpenChange, onChanged, onReceive, onOpenInvoice }: {
  orderId: number | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  onReceive?: ReceiveOrder;
  onOpenInvoice?: (purchaseId: number) => void;
}) {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const canManage = usePermission('purchases.manage');
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [busy, setBusy] = useState<null | 'send' | 'close' | 'receive'>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [shareText, setShareText] = useState<string | null>(null);

  useEffect(() => {
    setShareText(null);
    if (!orderId) { setDetail(null); return; }
    let cancelled = false;
    api.purchaseOrders.getById(orderId)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(err => toast.error(err instanceof Error ? err.message : t('Failed to load the order')));
    return () => { cancelled = true; };
  }, [orderId, t]);

  const changed = (d: PurchaseOrderDetail) => { setDetail(d); onChanged?.(); };

  const send = async () => {
    if (!detail) return;
    setBusy('send');
    try {
      const sent = await api.purchaseOrders.send(detail.id);
      changed(sent);
      setShareText(sent.share_text);
      toast.success(t('Order marked as sent'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to send the order'));
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    if (!detail) return;
    const partly = (detail.invoices ?? 0) > 0;
    const entered = await prompt({
      title: partly ? t('Close {{number}}', { number: detail.po_number }) : t('Cancel {{number}}', { number: detail.po_number }),
      description: partly
        ? t('Stop waiting for the rest. What already arrived stays on its invoices.')
        : t('Nothing has arrived on this order, so it will be cancelled.'),
      placeholder: t('Reason'),
      confirmLabel: partly ? t('Close order') : t('Cancel order'),
    });
    const reason = entered?.trim();
    if (!reason) {
      if (entered !== null) toast.error(t('A reason is required'));
      return;
    }
    setBusy('close');
    try {
      changed(await api.purchaseOrders.close(detail.id, reason));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to close the order'));
    } finally {
      setBusy(null);
    }
  };

  const receive = async () => {
    if (!detail || !onReceive) return;
    setBusy('receive');
    try {
      const prefill = await api.purchaseOrders.receivePrefill(detail.id);
      if (prefill.items.length === 0) {
        toast.info(t('Everything on this order has arrived. Close it, or add extra lines on a normal invoice.'));
        return;
      }
      onReceive({ ...prefill, po_number: detail.po_number, supplier_name: detail.supplier_name });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to prepare the invoice'));
    } finally {
      setBusy(null);
    }
  };

  const copyShare = async () => {
    if (!detail) return;
    try {
      const text = shareText ?? await api.purchaseOrders.shareText(detail.id);
      setShareText(text);
      await navigator.clipboard.writeText(text);
      toast.success(t('Copied — paste it into WhatsApp or SMS'));
    } catch {
      toast.error(t('Could not copy; select the text and copy it yourself'));
    }
  };

  const print = () => {
    if (!detail) return;
    const rows = detail.items.map((i, n) => `<tr><td>${n + 1}</td><td>${escapeHtml(i.product_name ?? '')}</td>
      <td class="num">${escapeHtml(`${i.quantity} ${i.parent_unit ?? ''}`)}</td>
      <td class="num">${i.expected_cost_parent === null ? '' : escapeHtml(formatCost(i.expected_cost_parent))}</td></tr>`).join('');
    printHtml(`<div class="header"><h2>${escapeHtml(t('Purchase order'))} ${escapeHtml(detail.po_number)}</h2>
      <span>${escapeHtml(formatDate(detail.order_date))}</span></div>
      <p>${escapeHtml(t('Supplier'))}: <strong>${escapeHtml(detail.supplier_name ?? '')}</strong>
      ${detail.expected_date ? ` · ${escapeHtml(t('Expected delivery'))}: ${escapeHtml(formatDate(detail.expected_date))}` : ''}</p>
      <table><thead><tr><th>#</th><th>${escapeHtml(t('Product'))}</th><th>${escapeHtml(t('Quantity'))}</th><th>${escapeHtml(t('Expected cost'))}</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${detail.notes ? `<p>${escapeHtml(detail.notes)}</p>` : ''}`);
  };

  const discrepancyLabel = (kind: 'short' | 'over' | 'cost') =>
    kind === 'short' ? t('Short') : kind === 'over' ? t('More than ordered') : t('Cost changed');

  return (
    <Dialog open={orderId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[88vh] overflow-y-auto">
        <DialogHeader className="pe-8">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />{detail?.po_number ?? t('Purchase order')}
            {detail && <Badge variant={STATUS_VARIANT[detail.display_status]}>{t(PURCHASE_ORDER_STATUS_LABELS[detail.display_status])}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? [detail.supplier_name, formatDate(detail.order_date), detail.expected_date ? `${t('Expected delivery')}: ${formatDate(detail.expected_date)}` : null, detail.username]
                .filter(Boolean).join(' · ')
              : t('Loading...')}
          </DialogDescription>
        </DialogHeader>

        {!detail ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {canManage && detail.status === 'draft' && (
                <>
                  <Button size="sm" className="gap-1" disabled={busy !== null} onClick={() => void send()}>
                    {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}{t('Mark as sent')}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditOpen(true)}><Pencil className="h-3.5 w-3.5" />{t('Edit')}</Button>
                </>
              )}
              {canManage && detail.status === 'sent' && onReceive && (
                <Button size="sm" className="gap-1" disabled={busy !== null} onClick={() => void receive()}>
                  {busy === 'receive' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}{t('Receive invoice')}
                </Button>
              )}
              <Button size="sm" variant="outline" className="gap-1" onClick={() => void copyShare()}><ClipboardCopy className="h-3.5 w-3.5" />{t('Copy as message')}</Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={print}><Printer className="h-3.5 w-3.5" />{t('Print')}</Button>
              {canManage && (detail.status === 'draft' || detail.status === 'sent') && (
                <Button size="sm" variant="ghost" className="ms-auto gap-1 text-destructive" disabled={busy !== null} onClick={() => void close()}>
                  {busy === 'close' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                  {(detail.invoices ?? 0) > 0 ? t('Close order') : t('Cancel order')}
                </Button>
              )}
            </div>

            {shareText && <Textarea readOnly rows={Math.min(10, shareText.split('\n').length)} value={shareText} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />}

            {detail.close_reason && (
              <p className="rounded-md border bg-muted/40 p-2 text-sm">
                {t(PURCHASE_ORDER_STATUS_LABELS[detail.display_status])}{detail.closed_at ? ` ${formatDate(detail.closed_at)}` : ''}: {detail.close_reason}
              </p>
            )}

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{t('Ordered')}</p><p className="font-bold tabular-nums">{detail.ordered_units ?? 0}</p></div>
              <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{t('Arrived')}</p><p className="font-bold tabular-nums">{detail.received_units ?? 0}</p></div>
              <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{t('Expected value')}</p><p className="font-bold tabular-nums">{formatCurrency(Math.round(detail.expected_value ?? 0))}</p></div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Product')}</TableHead>
                  <TableHead className="text-end">{t('Ordered')}</TableHead>
                  <TableHead className="text-end">{t('Arrived')}</TableHead>
                  <TableHead className="text-end">{t('Expected cost')}</TableHead>
                  <TableHead className="text-end">{t('Invoiced cost')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.items.map(i => {
                  const received = i.received_quantity ?? 0;
                  return (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.product_name}</TableCell>
                      <TableCell className="text-end tabular-nums">{i.quantity} {i.parent_unit ?? ''}</TableCell>
                      <TableCell className={cn('text-end tabular-nums', received > i.quantity && 'text-amber-600', received > 0 && received < i.quantity && 'text-muted-foreground')}>{received}</TableCell>
                      <TableCell className="text-end tabular-nums">{i.expected_cost_parent === null ? '—' : formatCost(i.expected_cost_parent)}</TableCell>
                      <TableCell className="text-end tabular-nums">{i.invoiced_cost_parent == null ? '—' : formatCost(i.invoiced_cost_parent)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {detail.discrepancies.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold">{t('Differences from the order')}</h4>
                <ul className="space-y-1 text-sm">
                  {detail.discrepancies.map((d, n) => (
                    <li key={`${d.product_id}-${d.kind}-${n}`} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1">
                      <span>
                        <Badge variant={d.kind === 'cost' ? 'outline' : 'secondary'} className="me-2">{discrepancyLabel(d.kind)}</Badge>
                        {d.product_name}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {d.kind === 'cost'
                          ? `${formatCost(d.expected_cost_parent ?? 0)} → ${formatCost(d.invoiced_cost_parent ?? 0)}`
                          : `${d.received} / ${d.ordered}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.purchases.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold">{t('Invoices received against this order')}</h4>
                <ul className="space-y-1 text-sm">
                  {detail.purchases.map(p => (
                    <li key={p.id} className="flex items-center justify-between rounded border px-2 py-1">
                      <button type="button" className="text-start underline-offset-2 hover:underline disabled:no-underline" disabled={!onOpenInvoice} onClick={() => onOpenInvoice?.(p.id)}>
                        {p.purchase_number}{p.invoice_reference ? ` · ${p.invoice_reference}` : ''} <span className="text-xs text-muted-foreground">{formatDate(p.purchase_date)}</span>
                      </button>
                      <span className="tabular-nums">{formatCurrency(p.total_amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.notes && <p className="text-sm text-muted-foreground">{detail.notes}</p>}
          </div>
        )}

        <PurchaseOrderDialog open={editOpen} onOpenChange={setEditOpen} order={detail} onSaved={changed} />
      </DialogContent>
    </Dialog>
  );
}
