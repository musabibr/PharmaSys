import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { Search, Download, PlusCircle, ExternalLink, AlertTriangle, Bookmark } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip as ChartTooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { api } from '@/api';
import type { Product, ProductPurchaseHistory, Supplier } from '@/api/types';
import { loadProducts } from '@/stores/products.store';
import { useDebounce } from '@/hooks/useDebounce';
import { usePermission } from '@/hooks/usePermission';
import { formatCurrency, formatCost, formatDate, formatQuantity, cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { DateField } from '@/components/ui/date-field';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface ReorderPrefill {
  supplierId?: number;
  productId: number;
  cost?: number;
  sellPrice?: number;
}

interface Props {
  initialProductId?: number | null;
  onOpenInvoice: (purchaseId: number) => void;
  onReorder?: (prefill: ReorderPrefill) => void;
}

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default', partial: 'secondary', unpaid: 'destructive',
};
const ALL = '__all__';

/**
 * Products whose name, generic name or barcode hold every word typed: an exact
 * barcode first, then names that start with the text, then the rest.
 */
function searchProducts(products: Product[], query: string, limit: number): Product[] {
  const raw = query.trim();
  const q = raw.toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const found: Array<{ p: Product; rank: number }> = [];
  for (const p of products) {
    const name = p.name.toLowerCase();
    if (p.barcode && p.barcode === raw) { found.push({ p, rank: 0 }); continue; }
    const text = `${name} ${(p.generic_name ?? '').toLowerCase()} ${p.barcode ?? ''}`;
    if (!words.every(w => text.includes(w))) continue;
    found.push({ p, rank: name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3 });
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map(x => x.p);
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null || pct === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('tabular-nums', pct > 0 ? 'text-destructive' : 'text-green-600')}>
      {pct > 0 ? '+' : ''}{pct}%
    </span>
  );
}

/** "By product" in Purchases (PL1–PL5): every invoice line for one product. */
export function ProductPurchasesTab({ initialProductId, onOpenInvoice, onReorder }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManagePurchases = usePermission('purchases.manage');
  const canSeeProfile = usePermission('inventory.valuation');

  // ── product search ─────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 150);
  const [products, setProducts] = useState<Product[]>([]);
  const [resultsOpen, setResultsOpen] = useState(false);

  useEffect(() => { loadProducts().then(setProducts).catch(() => setProducts([])); }, []);
  const results = useMemo(() => searchProducts(products, debouncedQuery, 15), [products, debouncedQuery]);

  // ── filters & data ─────────────────────────────────────────────────────
  const [productId, setProductId] = useState<number | null>(initialProductId ?? null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [history, setHistory] = useState<ProductPurchaseHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadId = useRef(0);

  useEffect(() => { if (initialProductId) setProductId(initialProductId); }, [initialProductId]);
  useEffect(() => { api.suppliers.getAll().then(setSuppliers).catch(() => setSuppliers([])); }, []);

  const load = useCallback(async () => {
    if (!productId) { setHistory(null); return; }
    const id = ++loadId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.purchases.getProductHistory(productId, {
        supplier_id: supplierId !== ALL ? Number(supplierId) : undefined,
        payment_status: status !== ALL ? status as 'unpaid' | 'partial' | 'paid' : undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        in_stock_only: inStockOnly || undefined,
      });
      if (id === loadId.current) setHistory(data);
    } catch (err) {
      if (id === loadId.current) { setHistory(null); setError(errorText(err, 'Failed to load purchase history')); }
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [productId, supplierId, status, startDate, endDate, inStockOnly]);

  useEffect(() => { void load(); }, [load]);

  const chartData = useMemo(() => (history ? [...history.lines].reverse().map(l => ({
    date: l.purchase_date,
    cost: Math.round(l.effective_cost_per_parent),
    supplier: l.supplier_name ?? '',
  })) : []), [history]);

  const pickProduct = (r: Product) => {
    setProductId(r.id);
    setQuery(r.name);
    setResultsOpen(false);
  };

  const exportExcel = () => {
    if (!history) return;
    const p = history.product;
    const header = [
      t('Date'), t('Invoice'), t('Supplier'), t('Qty'), t('Bonus'), t('Cost / pack'), t('Disc %'),
      t('Effective cost / pack'), t('Change %'), t('Price set'), t('Line total'), t('Batch #'),
      t('Expiry Date'), t('Shelf life (days)'), t('Remaining'), t('Payment'), t('Entered by'),
    ];
    const rows = history.lines.map(l => [
      l.purchase_date, l.invoice_reference || l.purchase_number, l.supplier_name ?? '', l.quantity_received, l.bonus_qty,
      l.cost_per_parent, l.discount_pct, l.effective_cost_per_parent, l.change_pct ?? '', l.selling_price_parent,
      l.line_total, l.batch_number ?? '', l.expiry_date ?? '', l.shelf_life_days ?? '',
      l.batch_remaining_base ?? '', t(l.payment_status), l.entered_by ?? '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([[p.name], [], header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchases');
    const safeName = p.name.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim() || 'product';
    XLSX.writeFile(wb, `PharmaSys-Purchases-${safeName}.xlsx`);
  };

  const reorderFromLast = () => {
    if (!history || !onReorder) return;
    const last = history.lines[0];
    onReorder({
      productId: history.product.id,
      supplierId: last?.supplier_id ?? undefined,
      cost: last?.cost_per_parent,
      sellPrice: last?.selling_price_parent,
    });
  };

  const p = history?.product;
  const s = history?.summary;
  const units = (base: number) => (p ? formatQuantity(base, p.parent_unit ?? '', p.child_unit ?? '', p.conversion_factor) : String(base));

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      {/* Search */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Label htmlFor="pl-search" className="text-xs">{t('Product')}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="pl-search"
              value={query}
              onChange={e => { setQuery(e.target.value); setResultsOpen(true); }}
              onFocus={() => setResultsOpen(true)}
              onKeyDown={e => {
                if (e.key === 'Enter' && results[0]) { e.preventDefault(); pickProduct(results[0]); }
                if (e.key === 'Escape') setResultsOpen(false);
              }}
              placeholder={t('Name, generic name or barcode')}
              className="ps-8"
              autoComplete="off"
            />
          </div>
          {resultsOpen && query.trim() && (
            <div className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md" role="listbox">
              {results.length === 0 && (
                <p className="p-2 text-sm text-muted-foreground">{t('No products found')}</p>
              )}
              {results.map(r => (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={r.id === productId}
                  className="flex w-full flex-col items-start rounded px-2 py-1.5 text-start hover:bg-accent"
                  onClick={() => pickProduct(r)}
                >
                  <span className="text-sm" dir="auto">{r.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {[r.generic_name, r.barcode].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {productId && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('Supplier')}</Label>
            <Combobox
              value={supplierId}
              onValueChange={setSupplierId}
              options={suppliers.map(x => ({ value: String(x.id), label: x.name }))}
              allOption={t('All Suppliers')}
              allValue={ALL}
              className="h-9 w-48"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('Payment')}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('All')}</SelectItem>
                <SelectItem value="unpaid">{t('unpaid')}</SelectItem>
                <SelectItem value="partial">{t('partial')}</SelectItem>
                <SelectItem value="paid">{t('paid')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('From')}</Label>
            <DateField value={startDate} onChange={(v) => setStartDate(v)} className="h-9 w-40" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('To')}</Label>
            <DateField value={endDate} onChange={(v) => setEndDate(v)} className="h-9 w-40" />
          </div>
          <label className="flex items-center gap-2 pb-2 text-xs">
            <Switch checked={inStockOnly} onCheckedChange={setInStockOnly} />
            {t('Still in stock')}
          </label>
          <div className="ms-auto flex flex-wrap gap-2 pb-0.5">
            {canManagePurchases && onReorder && history && history.lines.length > 0 && (
              <Button size="sm" variant="outline" onClick={reorderFromLast}>
                <PlusCircle className="me-1.5 h-4 w-4" />{t('New purchase from last line')}
              </Button>
            )}
            {canSeeProfile && (
              <Button size="sm" variant="outline" onClick={() => navigate(`/inventory/product/${productId}`)}>
                <ExternalLink className="me-1.5 h-4 w-4" />{t('Product profile')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={exportExcel} disabled={!history || history.lines.length === 0}>
              <Download className="me-1.5 h-4 w-4" />{t('Export Excel')}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="flex items-center gap-2 text-sm text-destructive" role="alert"><AlertTriangle className="h-4 w-4" />{t(error)}</p>}

      {!productId ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          {t('Search for a product to see every purchase of it: suppliers, costs, prices, expiry and what is left.')}
        </CardContent></Card>
      ) : loading && !history ? (
        <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : history && p && s ? (
        <>
          <div>
            <h2 className="text-lg font-semibold" dir="auto">{p.name}</h2>
            <p className="text-xs text-muted-foreground">
              {[p.generic_name, p.barcode].filter(Boolean).join(' · ')}
              {p.is_active ? '' : ` · ${t('Inactive')}`}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Stat label={t('Invoices')} value={String(s.invoices)} hint={t('{{count}} suppliers', { count: s.suppliers })} />
            <Stat label={t('Received')} value={units(Math.round(s.received * p.conversion_factor))}
              hint={s.bonus > 0 ? t('incl. {{count}} bonus', { count: s.bonus }) : undefined} />
            <Stat label={t('Spend')} value={formatCurrency(s.spend)} />
            <Stat label={t('Last cost')} value={s.last_cost !== null ? formatCost(s.last_cost) : '—'} hint={s.last_date ? formatDate(s.last_date) : undefined} />
            <Stat label={t('Average cost')} value={s.avg_effective_cost !== null ? formatCost(s.avg_effective_cost) : '—'} />
            <Stat label={t('Lowest cost')} value={s.lowest_effective_cost !== null ? formatCost(s.lowest_effective_cost) : '—'} hint={s.lowest_cost_date ? formatDate(s.lowest_cost_date) : undefined} />
            <Stat label={t('Change since first')} value={s.change_since_first_pct !== null ? `${s.change_since_first_pct > 0 ? '+' : ''}${s.change_since_first_pct}%` : '—'} />
            <Stat label={t('In stock')} value={units(p.on_hand_base)} />
            <Stat label={t('Current price')} value={formatCurrency(p.selling_price)}
              hint={s.margin_at_current_price_pct !== null ? t('Margin {{pct}}% on last cost', { pct: s.margin_at_current_price_pct }) : undefined} />
          </div>

          {history.suppliers.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t('Supplier comparison')}</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Supplier')}</TableHead>
                      <TableHead className="text-end">{t('Last cost')}</TableHead>
                      <TableHead className="text-end">{t('Effective cost')}</TableHead>
                      <TableHead>{t('Last date')}</TableHead>
                      <TableHead className="text-end">{t('Gap to cheapest')}</TableHead>
                      <TableHead className="text-end">{t('Average cost')}</TableHead>
                      <TableHead className="text-end">{t('Invoice lines')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.suppliers.map(x => (
                      <TableRow key={String(x.supplier_id)}>
                        <TableCell>
                          <span dir="auto">{x.supplier_name ?? t('N/A')}</span>
                          {x.is_cheapest && <Badge variant="success" className="ms-2 text-[10px]">{t('Cheapest')}</Badge>}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{formatCost(x.last_cost)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCost(x.last_effective_cost)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatDate(x.last_date)}
                          <span className={cn('ms-1 text-[11px]', x.age_days > 90 ? 'text-amber-600' : 'text-muted-foreground')}>
                            ({t('{{count}} days ago', { count: x.age_days })})
                          </span>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{x.is_cheapest ? '—' : `+${x.gap_to_cheapest_pct}%`}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCost(x.avg_effective_cost)}</TableCell>
                        <TableCell className="text-end tabular-nums">{x.lines}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {chartData.length > 1 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t('Cost over time')}</CardTitle></CardHeader>
              <CardContent className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={60} />
                    <ChartTooltip formatter={(v: unknown) => formatCurrency(Number(v))} labelFormatter={(l: unknown) => formatDate(String(l))} />
                    <Line type="monotone" dataKey="cost" name={t('Effective cost')} stroke="hsl(var(--primary))" strokeWidth={2} dot />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t('Invoice lines')}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {history.lines.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">{t('No purchases match these filters')}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Date')}</TableHead>
                      <TableHead>{t('Invoice')}</TableHead>
                      <TableHead>{t('Supplier')}</TableHead>
                      <TableHead className="text-end">{t('Qty')}</TableHead>
                      <TableHead className="text-end">{t('Cost / pack')}</TableHead>
                      <TableHead className="text-end">{t('Cost / unit')}</TableHead>
                      <TableHead className="text-end">{t('Cost change')}</TableHead>
                      <TableHead className="text-end">{t('Price set')}</TableHead>
                      <TableHead className="text-end">{t('Line total')}</TableHead>
                      <TableHead>{t('Batch / expiry')}</TableHead>
                      <TableHead className="text-end">{t('Remaining')}</TableHead>
                      <TableHead>{t('Payment')}</TableHead>
                      <TableHead>{t('Entered by')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.lines.map(l => (
                      <TableRow key={l.purchase_item_id}>
                        <TableCell className="whitespace-nowrap">{formatDate(l.purchase_date)}</TableCell>
                        <TableCell>
                          <button type="button" className="text-primary hover:underline" onClick={() => onOpenInvoice(l.purchase_id)}>
                            {l.invoice_reference || l.purchase_number}
                          </button>
                        </TableCell>
                        <TableCell dir="auto">{l.supplier_name ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-end tabular-nums">
                          {units(Math.round(l.quantity_received * l.conversion_factor))}
                          {l.bonus_qty > 0 && <span className="block text-[11px] text-green-600">+{l.bonus_qty} {t('bonus')}</span>}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatCost(l.cost_per_parent)}
                          {l.discount_pct > 0 && <span className="block text-[11px] text-muted-foreground">−{l.discount_pct}%</span>}
                          {Math.abs(l.effective_cost_per_parent - l.cost_per_parent) >= 0.5 && (
                            <span className="block text-[11px] text-muted-foreground">{t('effective')} {formatCost(l.effective_cost_per_parent)}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{formatCost(l.effective_cost_per_parent / (l.conversion_factor || 1))}</TableCell>
                        <TableCell className="text-end"><ChangeBadge pct={l.change_pct} /></TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(l.selling_price_parent)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(l.line_total)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {l.batch_number || '—'}
                          {l.expiry_date && l.expiry_date !== '2099-12-31' && (
                            <span className="block text-muted-foreground">
                              {formatDate(l.expiry_date)}
                              {l.shelf_life_days !== null && ` · ${t('{{count}} days shelf life', { count: l.shelf_life_days })}`}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-end tabular-nums">
                          {l.batch_remaining_base === null ? '—' : l.batch_remaining_base === 0 ? <span className="text-muted-foreground">{t('Sold out')}</span> : units(l.batch_remaining_base)}
                        </TableCell>
                        <TableCell><Badge variant={STATUS_BADGE[l.payment_status] ?? 'secondary'}>{t(l.payment_status)}</Badge></TableCell>
                        <TableCell className="text-xs">{l.entered_by ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {history.parked.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><Bookmark className="h-4 w-4 text-amber-500" />{t('Parked invoice lines mentioning this product')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {history.parked.map(x => (
                  <button key={x.pending_item_id} type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-start hover:bg-accent" onClick={() => onOpenInvoice(x.purchase_id)}>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(x.purchase_date)}</span>
                    <span className="font-medium">{x.purchase_number}</span>
                    <span className="text-muted-foreground">{x.supplier_name ?? ''}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
