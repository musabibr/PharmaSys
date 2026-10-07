import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Lock, SlidersHorizontal } from 'lucide-react';
import type { Product, PurchaseMatchContext } from '@/api/types';
import { cn, formatCost, formatCurrency, formatQuantity } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableCell, TableRow } from '@/components/ui/table';
import { RoundingSelect } from './RoundingRules';
import {
  invoiceHasUnits, normalizeUnits, sameUnit, stockAfter, suggestRescale,
  type CountsIn, type MatchPick, type PickResult, type ProductNow, type Units,
} from '../../../core/common/purchase-match';
import type { RoundingRule } from '../../../core/common/price-rounding';

// ─── Data helpers ──────────────────────────────────────────────────────────

export function nowFromContext(c: PurchaseMatchContext): ProductNow {
  return {
    units: { parentUnit: c.parent_unit, childUnit: c.child_unit ?? '', convFactor: c.conversion_factor || 1 },
    stockBase: c.stock_base,
    price: c.price,
    priceChild: c.price_child,
    lastCostParent: c.last_cost_parent,
  };
}

/** What the product list knows, when the Match step's own lookup is unavailable (no last cost). */
export function contextFromProduct(p: Product): PurchaseMatchContext {
  return {
    product_id: p.id,
    parent_unit: p.parent_unit,
    child_unit: p.child_unit ?? '',
    conversion_factor: p.conversion_factor || 1,
    stock_base: p.total_stock_base ?? 0,
    price: p.selling_price && p.selling_price > 0 ? p.selling_price : null,
    price_child: p.selling_price_child && p.selling_price_child > 0 ? p.selling_price_child : null,
    price_source: p.selling_price && p.selling_price > 0 ? 'current' : null,
    last_cost_parent: null,
    last_cost_date: null,
    last_cost_supplier: null,
  };
}

/** "Box = 10 Strip", or just "Box". */
export function describeUnits(u: Units): string {
  const n = normalizeUnits(u);
  return n.convFactor > 1 ? `${n.parentUnit} = ${n.convFactor} ${n.childUnit}` : n.parentUnit;
}

const qty = (n: number) => String(Math.round(n * 1000) / 1000);

// ─── Pieces ────────────────────────────────────────────────────────────────

export interface ChipOption {
  key: string;
  label: string;
  display: string;
  active: boolean;
  onSelect: () => void;
  title?: string;
}

/** The values a cell can take, as small buttons under its input. */
export function Chips({ options }: { options: ChipOption[] }) {
  if (options.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          onClick={o.onSelect}
          title={o.title}
          className={cn(
            'max-w-full truncate rounded border px-1.5 text-[10px] leading-4 transition-colors',
            o.active
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-transparent bg-muted text-muted-foreground hover:border-border hover:text-foreground',
          )}
        >
          {o.label} <span className="font-medium" dir="auto">{o.display}</span>
        </button>
      ))}
    </div>
  );
}

function SameMark({ label }: { label: string }) {
  return <span className="mt-1 flex items-center gap-0.5 text-[10px] text-emerald-600"><Check className="h-3 w-3" />{label}</span>;
}

type UnitField = 'parentUnit' | 'childUnit' | 'convFactor';

/** Base unit, small unit and pack size: the invoice's against the product's, either one or typed. */
export function UnitCells({ pick, invoice, now, canChange, onUnits }: {
  pick: MatchPick;
  invoice: Units;
  /** The matched product today; null for a new product. */
  now: ProductNow | null;
  canChange: boolean;
  onUnits: (patch: Partial<Units>) => void;
}) {
  const { t } = useTranslation();
  const product = now ? normalizeUnits(now.units) : null;
  const inv = normalizeUnits({ parentUnit: invoice.parentUnit || '', childUnit: invoice.childUnit || '', convFactor: invoice.convFactor || 1 });
  const locked = !!product && !canChange;
  const lockTitle = t("Changing a product's units needs permission to manage products");
  // Nothing to compare when the invoice gives no units, or just counts the product's small unit.
  const countsSmall = !!product && inv.convFactor <= 1 && sameUnit(inv.parentUnit, product.childUnit);
  const quiet = !!product && (!invoiceHasUnits(inv) || countsSmall);

  const cell = (field: UnitField, input: React.ReactNode, invValue: string | number, prodValue: string | number | undefined, show: (v: string | number) => string) => {
    if (!product) return <TableCell className="align-top">{input}</TableCell>;
    if (quiet) {
      return (
        <TableCell className="align-top">
          {locked ? <span className="flex items-center gap-1 text-sm" title={lockTitle}>{show(prodValue ?? '') || '—'}<Lock className="h-3 w-3 text-muted-foreground" /></span> : input}
          {field === 'parentUnit' && countsSmall && (
            <span className="mt-1 block text-[10px] text-muted-foreground">{t('Invoice counts {{unit}}', { unit: inv.parentUnit })}</span>
          )}
        </TableCell>
      );
    }
    const same = field === 'convFactor' ? Number(invValue) === Number(prodValue) : (sameUnit(String(invValue), String(prodValue)) || (!invValue && !prodValue));
    const current = pick[field];
    const isActive = (v: string | number) => (field === 'convFactor' ? Number(current) === Number(v) : (sameUnit(String(current), String(v)) || (!current && !v)));
    if (locked) {
      return (
        <TableCell className="align-top">
          <span className="flex items-center gap-1 text-sm" title={lockTitle}>{show(prodValue ?? '') || '—'}<Lock className="h-3 w-3 text-muted-foreground" /></span>
          {!same && <span className="mt-1 block text-[10px] text-muted-foreground">{t('Invoice')}: {show(invValue) || '—'}</span>}
        </TableCell>
      );
    }
    return (
      <TableCell className="align-top">
        {input}
        {same ? <SameMark label={t('Matches')} /> : (
          <Chips options={[
            { key: 'invoice', label: t('Invoice'), display: show(invValue) || '—', active: isActive(invValue), onSelect: () => onUnits({ [field]: invValue } as Partial<Units>) },
            { key: 'product', label: t('Product'), display: show(prodValue ?? '') || '—', active: isActive(prodValue ?? ''), onSelect: () => onUnits({ [field]: prodValue } as Partial<Units>) },
          ]} />
        )}
      </TableCell>
    );
  };

  const hasChild = !!String(pick.childUnit ?? '').trim();
  return (
    <>
      {cell('parentUnit',
        <Input value={pick.parentUnit} maxLength={30} className="h-7 w-24 text-xs" aria-label={t('Base unit')} onChange={e => onUnits({ parentUnit: e.target.value })} />,
        inv.parentUnit, product?.parentUnit, v => String(v))}
      {cell('childUnit',
        <Input value={pick.childUnit} maxLength={30} className="h-7 w-24 text-xs" placeholder="—" aria-label={t('Small unit')} onChange={e => onUnits({ childUnit: e.target.value })} />,
        inv.childUnit, product?.childUnit, v => String(v))}
      {cell('convFactor',
        <Input type="number" min={1} step={1} value={hasChild ? (pick.convFactor || '') : 1} disabled={!hasChild} className="h-7 w-16 text-xs"
          aria-label={t('Conversion factor')} title={hasChild ? undefined : t('Add a small unit first')}
          onChange={e => onUnits({ convFactor: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />,
        inv.childUnit ? inv.convFactor : 1, product ? (product.childUnit ? product.convFactor : 1) : undefined, v => String(v))}
    </>
  );
}

/** What is received: the invoice's count, read in the line's units. */
export function ReceivedCell({ pick, result, invoice, invoiceQty, invoiceCost, onCountsIn }: {
  pick: MatchPick;
  result: PickResult;
  /** The invoice's own units, for reading its pack. */
  invoice: Units;
  invoiceQty: number;
  invoiceCost: number;
  onCountsIn: (countsIn: CountsIn) => void;
}) {
  const { t } = useTranslation();
  const u = result.units;
  const inv = normalizeUnits(invoice);
  const label = (c: CountsIn) => (c === 'parent' ? u.parentUnit : c === 'child' ? u.childUnit : `${inv.parentUnit} (${inv.convFactor} ${inv.childUnit})`);
  const converted = result.reading.num !== result.reading.den;
  return (
    <TableCell className="align-top text-xs">
      <span className="block whitespace-nowrap tabular-nums">
        <bdi>{qty(invoiceQty)} {label(result.reading.countsIn)} × {formatCost(invoiceCost)}</bdi>
      </span>
      {result.readings.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="whitespace-nowrap text-[10px] text-muted-foreground">{t('Counted in')}</span>
          {result.readings.map(o => (
            <button
              key={o.countsIn}
              type="button"
              onClick={() => onCountsIn(o.countsIn)}
              className={cn('whitespace-nowrap rounded border px-1.5 text-[10px] leading-4',
                result.reading.countsIn === o.countsIn ? 'border-primary bg-primary/10 text-primary' : 'border-transparent bg-muted text-muted-foreground hover:text-foreground')}
            >
              {label(o.countsIn)}
            </button>
          ))}
        </div>
      )}
      {converted && (
        <span className="mt-1 block whitespace-nowrap font-medium tabular-nums">
          <bdi>= {qty(result.quantity)} {u.parentUnit} × {formatCost(result.costPerParent)}</bdi>
        </span>
      )}
      {converted && pick.countsInReason === 'price' && (
        <span className="mt-0.5 block text-[10px] text-amber-600">{t('Read from the price — check it')}</span>
      )}
    </TableCell>
  );
}

/** Selling prices and markup: today's, the new one from the cost, or typed. */
export function PriceCells({ pick, result, isExisting, todayIsLast, defaultMarkup, onPick }: {
  pick: MatchPick;
  result: PickResult;
  isExisting: boolean;
  /** Today's price is the last batch's (none in stock). */
  todayIsLast: boolean;
  defaultMarkup: number;
  onPick: (patch: Partial<MatchPick>) => void;
}) {
  const { t } = useTranslation();
  const today = result.today;
  const nowLabel = todayIsLast ? t('Last') : t('Now');
  const followChild = (source: MatchPick['priceSource']): Partial<MatchPick> =>
    pick.childSource === 'custom' ? {} : { childSource: source === 'product' && today?.child ? 'product' : 'auto' };

  const packChips: ChipOption[] = [];
  if (isExisting && today?.base) {
    packChips.push({ key: 'product', label: nowLabel, display: formatCurrency(today.base), active: pick.priceSource === 'product', onSelect: () => onPick({ priceSource: 'product', ...followChild('product') }), title: t('Keep the price charged today') });
  }
  if (result.fromCost > 0) {
    packChips.push({ key: 'invoice', label: t('New'), display: formatCurrency(result.fromCost), active: pick.priceSource === 'invoice', onSelect: () => onPick({ priceSource: 'invoice', lineMarkup: null, ...followChild('invoice') }), title: t('Cost plus the markup, rounded') });
  }
  const childChips: ChipOption[] = [];
  if (result.hasChild) {
    if (isExisting && today?.child) childChips.push({ key: 'product', label: nowLabel, display: formatCurrency(today.child), active: pick.childSource === 'product', onSelect: () => onPick({ childSource: 'product' }) });
    if (result.autoChild > 0) childChips.push({ key: 'auto', label: t('From pack'), display: formatCurrency(result.autoChild), active: pick.childSource === 'auto', onSelect: () => onPick({ childSource: 'auto' }) });
  }

  const m = result.markup;
  const markupTone = m === null ? '' : m < 0 ? 'text-destructive' : m + 0.5 < defaultMarkup ? 'text-amber-600' : 'text-emerald-600';
  const markupValue = pick.priceSource === 'markup' && pick.lineMarkup !== null ? pick.lineMarkup : m;

  return (
    <>
      <TableCell className="align-top">
        <Input
          type="number" min={0} step={1} value={result.sellPrice || ''} aria-label={t('Selling price (base)')}
          className={cn('h-7 w-24 text-xs tabular-nums', result.belowCost && 'border-destructive text-destructive')}
          title={result.belowCost ? t('Below the cost of {{cost}}', { cost: formatCost(result.costPerParent) }) : undefined}
          onChange={e => onPick({ priceSource: 'custom', sellPrice: Math.max(0, Math.round(Number(e.target.value) || 0)), ...(pick.childSource === 'custom' ? {} : { childSource: 'auto' }) })}
        />
        <Chips options={packChips} />
      </TableCell>
      <TableCell className="align-top">
        {result.hasChild ? (
          <>
            <Input
              type="number" min={0} step={1} value={result.sellPriceChild || ''} aria-label={t('Selling price (small)')}
              className={cn('h-7 w-20 text-xs tabular-nums', result.childBelowCost && 'border-destructive text-destructive')}
              title={result.childBelowCost && result.costPerChild !== null ? t('Below the cost of {{cost}}', { cost: formatCost(result.costPerChild) }) : undefined}
              onChange={e => onPick({ childSource: 'custom', sellPriceChild: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            />
            <Chips options={childChips} />
          </>
        ) : <span className="text-xs text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-0.5">
          <Input
            type="number" step={1} value={markupValue ?? ''} aria-label={t('Markup')}
            className={cn('h-7 w-16 text-xs tabular-nums', markupTone)}
            onChange={e => {
              const v = e.target.value.trim();
              if (v === '') { onPick({ priceSource: 'invoice', lineMarkup: null, ...followChild('invoice') }); return; }
              const n = Number(v);
              if (Number.isFinite(n)) onPick({ priceSource: 'markup', lineMarkup: n, ...followChild('markup') });
            }}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
        {pick.priceSource === 'markup' && m !== null && pick.lineMarkup !== null && Math.abs(m - pick.lineMarkup) >= 0.1 && (
          <span className={cn('mt-1 block text-[10px]', markupTone)}>{t('{{pct}}% after rounding', { pct: m })}</span>
        )}
        {result.belowCost && <span className="mt-1 flex items-center gap-0.5 text-[10px] text-destructive"><AlertTriangle className="h-3 w-3" />{t('Under cost')}</span>}
      </TableCell>
    </>
  );
}

/** Under a row whose product's units change: what its stock on hand becomes. */
export function UnitsChangeRow({ colSpan, productName, pick, result, now, onRescale }: {
  colSpan: number;
  productName: string;
  pick: MatchPick;
  result: PickResult;
  now: ProductNow;
  onRescale: (mode: 'keep_units' | 'keep_packs') => void;
}) {
  const { t } = useTranslation();
  const from = normalizeUnits(now.units);
  const to = result.units;
  const suggested = suggestRescale(from, to);
  const show = (base: number) => formatQuantity(base, to.parentUnit, to.childUnit, to.convFactor);
  const options = (['keep_units', 'keep_packs'] as const)
    .map(mode => ({ mode, after: stockAfter(now.stockBase, from, to, mode) }))
    .filter((o, i, all) => i === 0 || o.after !== all[0].after);
  return (
    <TableRow className="hover:bg-transparent">
      {/* The table sticks its first cell; this one spans the row, so its content is kept in view instead. */}
      <TableCell colSpan={colSpan} className="!bg-amber-50 py-2 text-xs dark:!bg-amber-950/40">
        <div className="sticky start-2 flex w-fit max-w-[calc(100vw-22rem)] flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('{{product}}: units change from {{from}} to {{to}}', { product: productName, from: describeUnits(from), to: describeUnits(to) })}
          </span>
          {now.stockBase > 0 && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t('Stock on hand {{qty}} becomes', { qty: formatQuantity(now.stockBase, from.parentUnit, from.childUnit, from.convFactor) })}</span>
              {options.map(o => (
                <label key={o.mode} className="flex cursor-pointer items-center gap-1">
                  <input type="radio" className="accent-primary" checked={pick.rescale === o.mode} onChange={() => onRescale(o.mode)} />
                  <span className="tabular-nums">{show(o.after)}</span>
                  {o.mode === suggested && options.length > 1 && <Badge variant="outline" className="px-1 py-0 text-[9px]">{t('suggested')}</Badge>}
                </label>
              ))}
            </span>
          )}
          <span className="text-muted-foreground">{t('Stock on hand sells at this line\'s prices.')}</span>
        </div>
      </TableCell>
    </TableRow>
  );
}

export interface MatchSummary {
  unitsChange: number;
  raised: number;
  kept: number;
  lowered: number;
  underCost: number;
  /** Lines whose quantity is converted into the product's packs. */
  converted: number;
}

/** Above the Match table: markup and rounding for new prices, and decisions for every line at once. */
export function MatchToolbar({
  markup, onMarkup, rules, packId, childId, onPackId, onChildId, onOpenRules,
  canChangeUnits, hasExisting, onUnits, onPrices, summary,
}: {
  markup: number;
  onMarkup: (pct: number) => void;
  rules: RoundingRule[];
  packId: string;
  childId: string;
  onPackId: (id: string) => void;
  onChildId: (id: string) => void;
  onOpenRules: () => void;
  canChangeUnits: boolean;
  hasExisting: boolean;
  onUnits: (which: 'product' | 'invoice') => void;
  onPrices: (which: 'smart' | 'product' | 'invoice') => void;
  summary: MatchSummary;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t('Markup')}</Label>
          <div className="flex items-center gap-1">
            <Input type="number" min={0} max={1000} step={1} value={markup} className="h-8 w-20 text-xs"
              onChange={e => onMarkup(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))} />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t('Round pack prices')}</Label>
          <RoundingSelect value={packId} onChange={onPackId} rules={rules} label={t('Round pack prices')} className="w-52" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t('Round small-unit prices')}</Label>
          <RoundingSelect value={childId} onChange={onChildId} rules={rules} label={t('Round small-unit prices')} className="w-52" />
        </div>
        <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={onOpenRules}>
          <SlidersHorizontal className="h-3.5 w-3.5" />{t('Rounding rules')}
        </Button>
        {hasExisting && (
          <>
            <div className="space-y-1">
              <Label className="text-[11px]">{t('Units of matched products')}</Label>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onUnits('product')}>{t("Product's")}</Button>
                <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!canChangeUnits} onClick={() => onUnits('invoice')}
                  title={canChangeUnits ? t('Use the units written on the invoice') : t("Changing a product's units needs permission to manage products")}>
                  {t("Invoice's")}
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">{t('Selling prices')}</Label>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onPrices('smart')}
                  title={t("Keep today's price while it still earns the markup; otherwise the new one")}>{t('Smart')}</Button>
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onPrices('product')}>{t('Keep current')}</Button>
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onPrices('invoice')}>{t('New from cost')}</Button>
              </div>
            </div>
          </>
        )}
      </div>
      {(summary.unitsChange + summary.raised + summary.kept + summary.lowered + summary.underCost + summary.converted) > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {summary.raised > 0 && <Badge variant="default">{t('Prices raised: {{count}}', { count: summary.raised })}</Badge>}
          {summary.kept > 0 && <Badge variant="secondary">{t('Prices kept: {{count}}', { count: summary.kept })}</Badge>}
          {summary.lowered > 0 && <Badge variant="outline">{t('Prices lowered: {{count}}', { count: summary.lowered })}</Badge>}
          {summary.unitsChange > 0 && <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">{t('Units change: {{count}}', { count: summary.unitsChange })}</Badge>}
          {summary.converted > 0 && <Badge variant="outline">{t('Quantities converted: {{count}}', { count: summary.converted })}</Badge>}
          {summary.underCost > 0 && <Badge variant="destructive">{t('Under cost: {{count}}', { count: summary.underCost })}</Badge>}
        </div>
      )}
    </div>
  );
}
