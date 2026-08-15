import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Search, Loader2, TrendingUp, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  Calculator, AlertTriangle, RefreshCw,
} from 'lucide-react';
import type { Product, BulkPriceUpdatePreviewRow } from '@/api/types';
import { api } from '@/api';
import { formatCurrency, unitLabel } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings.store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DataPagination } from '@/components/ui/data-pagination';

const PAGE_SIZE = 25;
const ALL_CATEGORIES = '__all__';

/**
 * One product per row in the pricing worksheet. Costs/current prices come from
 * the server (latest batch, FIFO effective price); new prices start formula-
 * filled and stay editable inline.
 */
interface WorkRow {
  productId: number;
  name: string;
  generic: string;
  barcode: string;
  category: string;
  cf: number;
  parentUnit: string;
  childUnit: string;
  cost: number;              // latest batch cost per parent
  currentSell: number;       // effective FIFO sell per parent
  currentSellChild: number;
  included: boolean;
  newSell: number;
  newSellChild: number;
  childTouched: boolean;
}

function marginPct(cost: number, sell: number): number | null {
  if (cost <= 0 || sell <= 0) return null;
  return Math.round(((sell - cost) / cost) * 100);
}

export function BulkPriceUpdatePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isRtl = i18n.dir() === 'rtl';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;

  // Formula controls
  const [mode, setMode] = useState<'markup_over_cost' | 'increase_current'>('markup_over_cost');
  const [percent, setPercent] = useState<number>(defaultMarkup);
  const [rounding, setRounding] = useState<1 | 50 | 100>(100);

  // Worksheet
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  // Filters
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [lowMarginOnly, setLowMarginOnly] = useState(false);
  const [page, setPage] = useState(1);

  async function loadData() {
    setLoading(true);
    try {
      // Server preview gives one row per in-stock product: latest batch cost,
      // current effective sell, and formula-filled starting prices.
      const [preview, products] = await Promise.all([
        api.batches.previewBulkPriceUpdate({ mode: 'markup_over_cost', percent: defaultMarkup, rounding: 100 }),
        api.products.getAll(),
      ]);
      const byId = new Map<number, Product>(products.map((p) => [p.id, p]));
      setRows(preview.map((r: BulkPriceUpdatePreviewRow) => {
        const p = byId.get(r.product_id);
        const cf = r.conversion_factor > 1 ? r.conversion_factor : 1;
        const currentSellChild = p?.selling_price_child ?? 0;
        return {
          productId: r.product_id,
          name: r.product_name,
          generic: p?.generic_name ?? '',
          barcode: p?.barcode ?? '',
          category: r.category_name ?? '',
          cf,
          parentUnit: p?.parent_unit ?? 'Box',
          childUnit: p?.child_unit ?? '',
          cost: r.basis_cost,           // fetched with markup_over_cost → latest batch cost
          currentSell: r.current_sell,
          currentSellChild,
          included: true,
          // Start each product at ITS OWN current price/margin — nothing changes
          // until the user recalculates by formula or edits a row.
          newSell: r.current_sell,
          newSellChild: cf > 1
            ? (currentSellChild || (r.current_sell > 0 ? Math.floor(r.current_sell / cf) : 0))
            : 0,
          childTouched: false,
        };
      }));
      setPage(1);
    } catch (err) {
      toast.error((err as Error).message || t('Failed to load products'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Re-fill every row's new prices from the formula (overwrites inline edits). */
  function recalculate() {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < -90 || pct > 500) {
      toast.error(t('Percent must be between -90 and 500'));
      return;
    }
    setRows((prev) => prev.map((r) => {
      const basis = mode === 'markup_over_cost' ? r.cost : r.currentSell;
      const raw = (basis * (100 + pct)) / 100;
      const newSell = Math.max(rounding, Math.round(raw / rounding) * rounding);
      return {
        ...r,
        newSell,
        newSellChild: r.cf > 1 ? Math.floor(newSell / r.cf) : 0,
        childTouched: false,
      };
    }));
  }

  function updateRow(productId: number, patch: Partial<WorkRow>) {
    setRows((prev) => prev.map((r) => {
      if (r.productId !== productId) return r;
      const next = { ...r, ...patch };
      if (patch.newSell !== undefined && !next.childTouched && next.cf > 1) {
        next.newSellChild = next.newSell > 0 ? Math.floor(next.newSell / next.cf) : 0;
      }
      return next;
    }));
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (category !== ALL_CATEGORIES && r.category !== category) return false;
      if (lowMarginOnly) {
        const m = marginPct(r.cost, r.currentSell);
        if (m === null || m >= defaultMarkup) return false;
      }
      if (q) {
        return r.name.toLowerCase().includes(q)
          || r.generic.toLowerCase().includes(q)
          || r.barcode.includes(query.trim());
      }
      return true;
    });
  }, [rows, query, category, lowMarginOnly, defaultMarkup]);

  useEffect(() => { setPage(1); }, [query, category, lowMarginOnly]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const includedRows = rows.filter((r) => r.included && r.newSell > 0);
  const filteredIncluded = filtered.filter((r) => r.included).length;
  const belowCost = includedRows.filter((r) => r.newSell < r.cost).length;
  const allFilteredSelected = filtered.length > 0 && filteredIncluded === filtered.length;

  /** Toggle inclusion for the whole FILTERED set (all pages). */
  function setFilteredIncluded(included: boolean) {
    const ids = new Set(filtered.map((r) => r.productId));
    setRows((prev) => prev.map((r) => (ids.has(r.productId) ? { ...r, included } : r)));
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  async function handleApply() {
    if (includedRows.length === 0) return;
    const ok = await confirm({
      title: t('Apply price update'),
      description:
        t('Update selling prices for {{count}} product(s)? This cannot be undone automatically.', { count: includedRows.length })
        + (belowCost > 0 ? `\n\n${t('Warning: {{count}} product(s) are priced below cost.', { count: belowCost })}` : ''),
      destructive: belowCost > 0,
    });
    if (!ok) return;

    setApplying(true);
    try {
      const res = await api.batches.applyManualPriceUpdate(includedRows.map((r) => ({
        product_id: r.productId,
        selling_price_parent: r.newSell,
        selling_price_child: r.cf > 1 && r.newSellChild > 0 ? r.newSellChild : null,
      })));
      toast.success(t('Updated {{products}} product(s) across {{batches}} batch(es)', {
        products: res.updatedProducts, batches: res.updatedBatches,
      }));
      await loadData();
    } catch (err) {
      toast.error((err as Error).message || t('Failed to apply price update'));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/inventory')} title={t('Back to Inventory')}>
          <BackIcon className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-48">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6" />
            {t('Bulk Price Update')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('Products load at their current prices and margins. Recalculate by formula or edit prices and margins inline — only checked rows are updated.')}
          </p>
        </div>
        <Button onClick={handleApply} disabled={includedRows.length === 0 || applying || loading}>
          {applying && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
          {t('Apply')} ({includedRows.length})
        </Button>
      </div>

      {/* Formula bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Basis')}</Label>
              <div className="flex gap-1.5">
                <Button size="sm" variant={mode === 'markup_over_cost' ? 'default' : 'outline'}
                  onClick={() => setMode('markup_over_cost')}>
                  {t('Markup on cost')}
                </Button>
                <Button size="sm" variant={mode === 'increase_current' ? 'default' : 'outline'}
                  onClick={() => setMode('increase_current')}>
                  {t('Increase current price')}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Percent')} %</Label>
              <Input type="number" value={percent}
                onChange={(e) => setPercent(Number(e.target.value) || 0)}
                className="w-24" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Round to nearest')}</Label>
              <Select value={String(rounding)} onValueChange={(v) => setRounding(Number(v) as 1 | 50 | 100)}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 SDG</SelectItem>
                  <SelectItem value="50">50 SDG</SelectItem>
                  <SelectItem value="100">100 SDG</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="secondary" onClick={recalculate} disabled={loading}>
              <Calculator className="me-1.5 h-4 w-4" />
              {t('Recalculate prices')}
            </Button>
            <Button variant="ghost" size="sm" onClick={loadData} disabled={loading} title={t('Reload')}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              {t('Recalculate overwrites all new prices, including manual edits.')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Filters + selection */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56 max-w-md">
          <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={query} className="ps-9"
            placeholder={t('Search by name, generic, or barcode...')}
            onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>{t('All Categories')}</SelectItem>
            {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <Switch checked={lowMarginOnly} onCheckedChange={setLowMarginOnly} />
          {t('Low margin only')}
        </label>
        <div className="ms-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            {t('{{shown}} of {{total}} shown · {{selected}} selected', {
              shown: filtered.length, total: rows.length, selected: includedRows.length,
            })}
          </span>
          {belowCost > 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              {t('{{count}} below cost', { count: belowCost })}
            </Badge>
          )}
        </div>
      </div>

      {/* Worksheet */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              {t('No products match the current filters')}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10 text-center">
                        <input type="checkbox" className="h-4 w-4 rounded border-input accent-primary align-middle"
                          checked={allFilteredSelected}
                          onChange={(e) => setFilteredIncluded(e.target.checked)}
                          title={t('Select all filtered rows')} />
                      </TableHead>
                      <TableHead>{t('Product')}</TableHead>
                      <TableHead className="text-end">{t('Cost')}</TableHead>
                      <TableHead className="text-end">{t('Current')}</TableHead>
                      <TableHead className="text-end">{t('Margin')}</TableHead>
                      <TableHead className="text-end">{t('New sell')}/{t('base unit')}</TableHead>
                      <TableHead className="text-end">{t('New sell')}/{t('small unit')}</TableHead>
                      <TableHead className="text-end">{t('New margin')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((r) => {
                      const curMargin = marginPct(r.cost, r.currentSell);
                      const newMargin = marginPct(r.cost, r.newSell);
                      const changePct = r.currentSell > 0 && r.newSell > 0
                        ? Math.round(((r.newSell - r.currentSell) / r.currentSell) * 1000) / 10
                        : null;
                      const isLoss = r.newSell > 0 && r.newSell < r.cost;
                      const marginColor = (m: number | null) =>
                        m === null ? 'text-muted-foreground'
                          : m >= defaultMarkup ? 'text-green-600'
                            : m >= defaultMarkup / 2 ? 'text-yellow-600' : 'text-destructive';
                      return (
                        <TableRow key={r.productId} className={r.included ? '' : 'opacity-50'}>
                          <TableCell className="text-center">
                            <input type="checkbox" className="h-4 w-4 rounded border-input accent-primary align-middle"
                              checked={r.included}
                              onChange={(e) => updateRow(r.productId, { included: e.target.checked })} />
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{r.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {[r.category, r.cf > 1 ? `1 ${unitLabel(r.parentUnit, t)} = ${r.cf} ${unitLabel(r.childUnit, t)}` : null]
                                .filter(Boolean).join(' · ')}
                            </div>
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{formatCurrency(r.cost)}</TableCell>
                          <TableCell className="text-end tabular-nums text-muted-foreground">
                            {formatCurrency(r.currentSell)}
                            {r.cf > 1 && r.currentSellChild > 0 && (
                              <div className="text-xs">{formatCurrency(r.currentSellChild)}/{unitLabel(r.childUnit, t)}</div>
                            )}
                          </TableCell>
                          <TableCell className={`text-end tabular-nums ${marginColor(curMargin)}`}>
                            {curMargin === null ? '—' : `${curMargin}%`}
                          </TableCell>
                          <TableCell className="text-end">
                            <Input type="number" min={0}
                              className={`h-8 w-28 text-end ms-auto ${isLoss || r.newSell <= 0 ? 'ring-1 ring-destructive' : ''}`}
                              value={r.newSell || ''}
                              disabled={!r.included}
                              onChange={(e) => updateRow(r.productId, { newSell: Math.round(Number(e.target.value) || 0) })} />
                          </TableCell>
                          <TableCell className="text-end">
                            {r.cf > 1 ? (
                              <Input type="number" min={0}
                                className="h-8 w-24 text-end ms-auto"
                                value={r.newSellChild || ''}
                                placeholder={t('auto')}
                                disabled={!r.included}
                                onChange={(e) => updateRow(r.productId, { newSellChild: Math.round(Number(e.target.value) || 0), childTouched: true })} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-end">
                            {r.cost > 0 ? (
                              <div className="flex items-center justify-end gap-1">
                                {/* Editable margin: typing a % sets the base price (whole SDG, no step rounding). */}
                                <Input type="number"
                                  className={`h-8 w-20 text-end tabular-nums ${marginColor(newMargin)}`}
                                  value={newMargin ?? ''}
                                  disabled={!r.included}
                                  onChange={(e) => {
                                    const m = Number(e.target.value);
                                    if (!Number.isFinite(m)) return;
                                    updateRow(r.productId, { newSell: Math.max(0, Math.round(r.cost * (1 + m / 100))) });
                                  }} />
                                <span className="text-xs text-muted-foreground">%</span>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                            {changePct !== null && changePct !== 0 && (
                              <div className={`text-xs ${changePct > 0 ? 'text-green-600' : 'text-destructive'}`}>
                                {changePct > 0
                                  ? <ArrowUp className="inline h-3 w-3" />
                                  : <ArrowDown className="inline h-3 w-3" />}
                                {Math.abs(changePct)}%
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="p-3">
                <DataPagination page={page} totalPages={totalPages} total={filtered.length}
                  pageSize={PAGE_SIZE} onPageChange={setPage} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Bottom apply bar */}
      {!loading && filtered.length > 0 && (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-muted-foreground">
            {t('{{count}} product(s) affected', { count: includedRows.length })}
          </span>
          <Button onClick={handleApply} disabled={includedRows.length === 0 || applying}>
            {applying && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            {t('Apply')} ({includedRows.length})
          </Button>
        </div>
      )}
    </div>
  );
}
