/**
 * Decisions behind the purchase Match step, when an invoice line meets the
 * product it was matched to: are the units the same, which unit the invoice
 * counts in, what the quantity and cost become in the product's units, which
 * selling price to start from, and what existing stock keeps if the pack size
 * changes.
 *
 * Pure: shared by the renderer and the tests; no Node or DOM APIs.
 */
import { roundPrice, type RoundingRule } from './price-rounding';

/** Spellings seen on invoices and in product records, by the unit they mean. */
const UNIT_ALIASES: Record<string, string> = {
  box: 'box', boxes: 'box', bx: 'box', carton: 'box', 'علبة': 'box', 'علب': 'box',
  bottle: 'bottle', bottles: 'bottle', bott: 'bottle', bottl: 'bottle', botlle: 'bottle', botell: 'bottle', btl: 'bottle', bot: 'bottle',
  'قارورة': 'bottle', 'زجاجة': 'bottle',
  piece: 'piece', pieces: 'piece', pcs: 'piece', pc: 'piece', 'قطعة': 'piece', 'حبة': 'piece',
  strip: 'strip', strips: 'strip', stript: 'strip', str: 'strip', 'شريط': 'strip', 'شرائط': 'strip',
  tube: 'tube', tubes: 'tube', tub: 'tube', 'أنبوب': 'tube', 'أنبوبة': 'tube',
  ampoule: 'ampoule', ampoules: 'ampoule', amp: 'ampoule', ampule: 'ampoule', ambol: 'ampoule', ambols: 'ampoule', 'أمبول': 'ampoule', 'أمبولة': 'ampoule',
  vial: 'vial', vials: 'vial', vail: 'vial', 'فيال': 'vial',
  drop: 'drop', drops: 'drop', 'قطرة': 'drop', 'قطرات': 'drop',
  sachet: 'sachet', sachets: 'sachet', 'كيس': 'sachet', 'أكياس': 'sachet',
  tablet: 'tablet', tablets: 'tablet', tab: 'tablet', tabs: 'tablet', 'قرص': 'tablet', 'أقراص': 'tablet',
  capsule: 'capsule', capsules: 'capsule', cap: 'capsule', caps: 'capsule', 'كبسولة': 'capsule',
  packet: 'packet', packets: 'packet', pack: 'packet', pkt: 'packet', package: 'packet', backet: 'packet', baket: 'packet',
  dozen: 'dozen', doz: 'dozen',
  unit: 'unit', units: 'unit', 'وحدة': 'unit', 'عبوة': 'unit',
  suppository: 'suppository', supp: 'suppository', 'تحميلة': 'suppository', 'تحاميل': 'suppository',
};

/** A unit name reduced to what it means ("Bottl." and "bottle" are the same). Empty for no unit. */
export function unitKey(unit: string | null | undefined): string {
  const s = String(unit ?? '').trim().toLowerCase().replace(/\.+$/, '').replace(/\s+/g, ' ');
  return UNIT_ALIASES[s] ?? s;
}

export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = unitKey(a);
  return ka !== '' && ka === unitKey(b);
}

export interface Units {
  parentUnit: string;
  childUnit: string;
  /** Small units per pack; 1 when there is no small unit. */
  convFactor: number;
}

/** Units as stored: no small unit means one unit per pack, and one per pack means no small unit. */
export function normalizeUnits(u: Units): Units {
  const child = String(u.childUnit ?? '').trim();
  const convFactor = child ? Math.max(1, Math.floor(Number(u.convFactor) || 1)) : 1;
  return {
    parentUnit: String(u.parentUnit ?? '').trim(),
    childUnit: convFactor > 1 ? child : '',
    convFactor,
  };
}

/** Whether receiving in `next` would change the product's units. */
export function unitsDiffer(current: Units, next: Units): boolean {
  const a = normalizeUnits(current);
  const b = normalizeUnits(next);
  if (a.convFactor !== b.convFactor) return true;
  if (unitKey(a.parentUnit) !== unitKey(b.parentUnit)) return true;
  return unitKey(a.childUnit) !== unitKey(b.childUnit);
}

/**
 * What an invoice line's quantity counts, in the units it is received in: a
 * pack, a small unit, or the invoice's own pack when it holds a different
 * number of them (a box of 10 strips received as boxes of 3).
 */
export type CountsIn = 'parent' | 'child' | 'pack';

export interface CountsInGuess {
  countsIn: CountsIn;
  /** What decided it: the invoice's pack size, the unit's name, the price, or nothing (packs, the usual case). */
  reason: 'pack-size' | 'unit-name' | 'price' | 'default';
}

/** A way of reading an invoice line: `num / den` packs per unit the invoice counts. */
export interface CountingOption {
  countsIn: CountsIn;
  num: number;
  den: number;
}

/**
 * The ways an invoice line can be read in `target` units: as packs, as small
 * units, or — when the invoice states its own pack of the target's small unit
 * (or of the target's pack) in another size — through that pack.
 */
export function countingOptions(invoice: Units, target: Units): CountingOption[] {
  const t = normalizeUnits(target);
  const inv = normalizeUnits(invoice);
  const out: CountingOption[] = [{ countsIn: 'parent', num: 1, den: 1 }];
  if (t.convFactor > 1) out.push({ countsIn: 'child', num: 1, den: t.convFactor });
  if (inv.convFactor > 1) {
    if (t.convFactor > 1 && sameUnit(inv.childUnit, t.childUnit)) {
      if (inv.convFactor !== t.convFactor) out.push({ countsIn: 'pack', num: inv.convFactor, den: t.convFactor });
    } else if (sameUnit(inv.childUnit, t.parentUnit)) {
      out.push({ countsIn: 'pack', num: inv.convFactor, den: 1 });
    }
  }
  return out;
}

/** The reading chosen, or packs when it no longer applies to these units. */
export function countingFor(countsIn: CountsIn, invoice: Units, target: Units): CountingOption {
  const options = countingOptions(invoice, target);
  return options.find(o => o.countsIn === countsIn) ?? options[0];
}

/** Within this factor of a reference price, a cost "looks like" that price. */
const PRICE_TOLERANCE = 1.6;

/**
 * Which unit an invoice line counts in, against the units it will be received
 * in: the invoice's own pack size first (a box of 10 strips is not a box of
 * 3), then by name ("strip" when the product's small unit is the strip), then
 * by price — an invoice cost close to a single unit's last cost (and not to
 * the pack's) counts single units. Otherwise packs.
 */
export function guessCountsIn(
  line: { unit: string; cost: number; childUnit?: string; convFactor?: number },
  target: Units,
  lastCostParent: number | null | undefined,
): CountsInGuess {
  const t = normalizeUnits(target);
  const invoice = { parentUnit: line.unit, childUnit: line.childUnit ?? '', convFactor: line.convFactor ?? 1 };
  if (countingOptions(invoice, t).some(o => o.countsIn === 'pack')) return { countsIn: 'pack', reason: 'pack-size' };
  if (t.convFactor <= 1 || !t.childUnit) return { countsIn: 'parent', reason: 'default' };
  if (sameUnit(line.unit, t.childUnit) && !sameUnit(line.unit, t.parentUnit)) return { countsIn: 'child', reason: 'unit-name' };
  if (sameUnit(line.unit, t.parentUnit)) return { countsIn: 'parent', reason: 'unit-name' };
  const cost = Number(line.cost) || 0;
  const pack = Number(lastCostParent) || 0;
  if (cost > 0 && pack > 0) {
    const offPack = Math.abs(Math.log(cost / pack));
    const offUnit = Math.abs(Math.log(cost / (pack / t.convFactor)));
    const close = Math.log(PRICE_TOLERANCE);
    if (offUnit < offPack && offUnit < close) return { countsIn: 'child', reason: 'price' };
    if (offPack <= offUnit && offPack < close) return { countsIn: 'parent', reason: 'price' };
  }
  return { countsIn: 'parent', reason: 'default' };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Quantity in packs and cost per pack for a reading of `num / den` packs per invoice unit; the line value is kept. */
export function receiveLine(quantity: number, cost: number, reading: { num: number; den: number }): { quantity: number; costPerParent: number } {
  const q = Number(quantity) || 0;
  const c = Number(cost) || 0;
  if (reading.num === reading.den) return { quantity: q, costPerParent: c };
  return { quantity: round6((q * reading.num) / reading.den), costPerParent: round3((c * reading.den) / reading.num) };
}

/** Quantity in packs and cost per pack, once an invoice that counts single units is converted. */
export function toReceivingUnits(quantity: number, cost: number, countsIn: CountsIn, convFactor: number): { quantity: number; costPerParent: number } {
  const cf = Math.max(1, Number(convFactor) || 1);
  return receiveLine(quantity, cost, countsIn === 'child' && cf > 1 ? { num: 1, den: cf } : { num: 1, den: 1 });
}

/** Markup of a price over a cost, % (one decimal); null without a cost. */
export function markupPct(price: number, cost: number): number | null {
  const c = Number(cost) || 0;
  if (!(c > 0)) return null;
  return Math.round(((Number(price) || 0) - c) * 1000 / c) / 10;
}

/** The price that earns `pct` % over the cost, in whole SDG. */
export function priceFromMarkup(cost: number, pct: number): number {
  return Math.round((Number(cost) || 0) * (1 + (Number(pct) || 0) / 100));
}

export interface SellChoice {
  /** 'product': keep the price charged today; 'invoice': the new price from this cost. */
  choice: 'product' | 'invoice';
  reason: 'no-price' | 'below-cost' | 'low-margin' | 'margin-ok';
}

/**
 * Which selling price a matched line starts from: today's price while it
 * still earns the usual markup on the new cost (prices are not lowered on
 * their own), the new price when today's would sell below cost or under the
 * usual markup, or when there is no price yet.
 */
export function suggestSellChoice(p: { currentPrice: number | null | undefined; cost: number; defaultMarkupPct: number }): SellChoice {
  const current = Number(p.currentPrice) || 0;
  if (current <= 0) return { choice: 'invoice', reason: 'no-price' };
  const cost = Number(p.cost) || 0;
  if (cost > 0 && current < cost) return { choice: 'invoice', reason: 'below-cost' };
  const m = markupPct(current, cost);
  if (m !== null && m + 0.5 < (Number(p.defaultMarkupPct) || 0)) return { choice: 'invoice', reason: 'low-margin' };
  return { choice: 'product', reason: 'margin-ok' };
}

/**
 * What existing stock keeps when a product's units change. The stored count
 * is in the smallest unit; when that unit itself changes meaning (a small unit
 * added or removed, or a different one) the pack count is what stays true,
 * otherwise (the same small unit, a corrected pack size) the unit count is.
 */
export function suggestRescale(current: Units, next: Units): 'keep_units' | 'keep_packs' {
  const a = normalizeUnits(current);
  const b = normalizeUnits(next);
  if (a.convFactor === b.convFactor) return 'keep_units';
  if (a.convFactor === 1 || b.convFactor === 1) return 'keep_packs';
  return sameUnit(a.childUnit, b.childUnit) ? 'keep_units' : 'keep_packs';
}

/** Stock after a units change, in the new smallest unit. */
export function stockAfter(stockBase: number, current: Units, next: Units, mode: 'keep_units' | 'keep_packs'): number {
  const a = normalizeUnits(current);
  const b = normalizeUnits(next);
  if (mode === 'keep_units' || a.convFactor === b.convFactor) return stockBase;
  return Math.round((stockBase * b.convFactor) / a.convFactor);
}

/**
 * Today's prices restated in other units. When packs keep their meaning the
 * pack price stays and the small unit is re-priced from it; when the smallest
 * unit keeps its meaning its price stays and packs are re-priced from it.
 */
export function priceInUnits(
  price: { base: number | null; child: number | null },
  current: Units,
  next: Units,
  mode: 'keep_units' | 'keep_packs',
): { base: number | null; child: number | null } {
  const a = normalizeUnits(current);
  const b = normalizeUnits(next);
  const base = Number(price.base) > 0 ? Number(price.base) : null;
  const childNow = Number(price.child) > 0
    ? Number(price.child)
    : base !== null && a.convFactor > 1 ? Math.floor(base / a.convFactor) : null;
  if (a.convFactor === b.convFactor) return { base, child: b.convFactor > 1 ? childNow : null };
  if (mode === 'keep_packs') {
    return { base, child: base !== null && b.convFactor > 1 ? Math.floor(base / b.convFactor) : null };
  }
  const unit = a.convFactor > 1 ? childNow : base;
  if (unit === null) return { base: null, child: null };
  return { base: unit * b.convFactor, child: b.convFactor > 1 ? unit : null };
}

// ─── A line's decisions ────────────────────────────────────────────────────

/**
 * Where a line's pack price comes from: the price charged today, the invoice
 * cost plus the invoice's markup, the cost plus this line's own markup, or a
 * typed price. Prices worked out from a cost are rounded; the others are not.
 */
export type PriceSource = 'product' | 'invoice' | 'markup' | 'custom';

/** Where the small-unit price comes from: worked out from the pack price, today's, or typed. */
export type ChildPriceSource = 'auto' | 'product' | 'custom';

/** What the Match step decided for one invoice line. Values are worked out from it by `evaluatePick`. */
export interface MatchPick {
  /** The product it was decided for; null for a new product. */
  productId: number | null;
  /** The invoice line it was decided on; when that changes, it is decided again. */
  basis: string;
  /** Units the line is received in; an existing product takes them when they differ from its own. */
  parentUnit: string;
  childUnit: string;
  convFactor: number;
  /** Which of those units the invoice's quantity and cost count. */
  countsIn: CountsIn;
  countsInReason: CountsInGuess['reason'] | 'user';
  /** What stock on hand keeps when the pack size changes. */
  rescale: 'keep_units' | 'keep_packs';
  rescaleByUser: boolean;
  priceSource: PriceSource;
  /** Why the price started where it did (existing products). */
  sellReason: SellChoice['reason'] | null;
  /** This line's own markup, % (priceSource 'markup'). */
  lineMarkup: number | null;
  /** The typed pack price (priceSource 'custom'). */
  sellPrice: number;
  childSource: ChildPriceSource;
  /** The typed small-unit price (childSource 'custom'). */
  sellPriceChild: number;
}

/** An invoice line as written: its units, and quantity and cost in the unit it counts. */
export interface InvoiceLine {
  parentUnit: string;
  childUnit: string;
  convFactor: number;
  quantity: number;
  cost: number;
}

/** A matched product as it is today. */
export interface ProductNow {
  units: Units;
  stockBase: number;
  price: number | null;
  priceChild: number | null;
  lastCostParent: number | null;
}

/** Markup for prices worked out from the cost, and how they are rounded. */
export interface PriceRules {
  markupPct: number;
  packRule: RoundingRule | null;
  childRule: RoundingRule | null;
}

export function lineBasis(line: InvoiceLine): string {
  return [unitKey(line.parentUnit), unitKey(line.childUnit), Number(line.convFactor) || 1, Number(line.quantity) || 0, Number(line.cost) || 0].join('|');
}

/** Whether the invoice says anything about units (parsers write "Unit" when it does not). */
export function invoiceHasUnits(line: Pick<InvoiceLine, 'parentUnit' | 'childUnit' | 'convFactor'>): boolean {
  const parent = unitKey(line.parentUnit);
  return (parent !== '' && parent !== 'unit') || !!String(line.childUnit ?? '').trim() || (Number(line.convFactor) || 1) > 1;
}

/**
 * The starting decision for a line matched to an existing product: its own
 * units, the invoice read in them (by unit name, else by price), and today's
 * price while it still earns the usual markup.
 */
export function pickForExisting(productId: number, line: InvoiceLine, now: ProductNow, rules: PriceRules): MatchPick {
  const units = normalizeUnits(now.units);
  const guess = guessCountsIn({ unit: line.parentUnit, cost: line.cost, childUnit: line.childUnit, convFactor: line.convFactor }, units, now.lastCostParent);
  const received = receiveLine(line.quantity, line.cost, countingFor(guess.countsIn, line, units));
  const choice = suggestSellChoice({ currentPrice: now.price, cost: received.costPerParent, defaultMarkupPct: rules.markupPct });
  const keep = choice.choice === 'product';
  return {
    productId, basis: lineBasis(line), ...units,
    countsIn: guess.countsIn, countsInReason: guess.reason,
    rescale: 'keep_units', rescaleByUser: false,
    priceSource: keep ? 'product' : 'invoice', sellReason: choice.reason, lineMarkup: null, sellPrice: 0,
    childSource: keep ? 'product' : 'auto', sellPriceChild: 0,
  };
}

/**
 * The starting decision for a new product: the invoice's units, and its
 * prices — kept as typed when they were changed by hand, otherwise worked
 * out from the cost (and so rounded).
 */
export function pickForNew(line: InvoiceLine, typed: { sellPrice: number; sellPriceChild: number; importMarkupPct: number }): MatchPick {
  const units = normalizeUnits({ parentUnit: line.parentUnit || 'Unit', childUnit: line.childUnit, convFactor: line.convFactor });
  const fromImport = (Number(line.cost) || 0) > 0 ? priceFromMarkup(line.cost, typed.importMarkupPct) : 0;
  const pack = Math.round(Number(typed.sellPrice) || 0);
  const child = Math.round(Number(typed.sellPriceChild) || 0);
  const typedPack = pack > 0 && pack !== fromImport;
  const typedChild = units.convFactor > 1 && child > 0 && child !== Math.floor(pack / units.convFactor);
  return {
    productId: null, basis: lineBasis(line), ...units,
    countsIn: 'parent', countsInReason: 'default',
    rescale: 'keep_units', rescaleByUser: false,
    priceSource: typedPack ? 'custom' : 'invoice', sellReason: null, lineMarkup: null, sellPrice: pack,
    childSource: typedChild ? 'custom' : 'auto', sellPriceChild: child,
  };
}

export interface PickResult {
  units: Units;
  hasChild: boolean;
  /** How the invoice's quantity is read, and the other readings on offer. */
  reading: CountingOption;
  readings: CountingOption[];
  /** Packs received and cost per pack, in `units`. */
  quantity: number;
  costPerParent: number;
  costPerChild: number | null;
  /** Today's prices in `units` (existing products with a price). */
  today: { base: number | null; child: number | null } | null;
  /** The pack price from the cost and the invoice's markup, rounded. */
  fromCost: number;
  /** The small-unit price worked out from the pack price, rounded. */
  autoChild: number;
  sellPrice: number;
  /** 0 without a small unit. */
  sellPriceChild: number;
  markup: number | null;
  belowCost: boolean;
  childBelowCost: boolean;
  /** The product's units change with this purchase. */
  unitsChange: boolean;
  /** Stock on hand after the change, in the new smallest unit. */
  stockAfter: number | null;
}

const fromCostPrice = (cost: number, pct: number, rule: RoundingRule | null) =>
  cost > 0 ? roundPrice(priceFromMarkup(cost, pct), rule, pct >= 0 ? { floor: cost } : {}) : 0;

/** What a decision comes to: quantity and cost received, prices, markup and what changes on the product. */
export function evaluatePick(line: InvoiceLine, pick: MatchPick, now: ProductNow | null, rules: PriceRules): PickResult {
  const units = normalizeUnits(pick);
  const hasChild = units.convFactor > 1;
  const readings = countingOptions(line, units);
  const reading = readings.find(o => o.countsIn === pick.countsIn) ?? readings[0];
  const received = receiveLine(line.quantity, line.cost, reading);
  const cost = received.costPerParent;
  const costPerChild = hasChild ? cost / units.convFactor : null;
  const unitsChange = now !== null && unitsDiffer(now.units, units);
  const today = now && (Number(now.price) > 0 || Number(now.priceChild) > 0)
    ? priceInUnits({ base: now.price, child: now.priceChild }, now.units, units, pick.rescale)
    : null;
  const fromCost = fromCostPrice(cost, rules.markupPct, rules.packRule);

  let sellPrice: number;
  if (pick.priceSource === 'product' && today?.base) sellPrice = today.base;
  else if (pick.priceSource === 'markup') sellPrice = fromCostPrice(cost, pick.lineMarkup ?? rules.markupPct, rules.packRule);
  else if (pick.priceSource === 'custom') sellPrice = Math.max(0, Math.round(Number(pick.sellPrice) || 0));
  else sellPrice = fromCost;

  const autoChild = hasChild && sellPrice > 0
    ? roundPrice(Math.floor(sellPrice / units.convFactor), rules.childRule, sellPrice >= cost && costPerChild ? { floor: costPerChild } : {})
    : 0;
  let sellPriceChild = 0;
  if (hasChild) {
    if (pick.childSource === 'custom') sellPriceChild = Math.max(0, Math.round(Number(pick.sellPriceChild) || 0));
    else if (pick.childSource === 'product' && today?.child) sellPriceChild = today.child;
    else sellPriceChild = autoChild;
  }

  return {
    units, hasChild, reading, readings,
    quantity: received.quantity, costPerParent: cost, costPerChild,
    today, fromCost, autoChild, sellPrice, sellPriceChild,
    markup: markupPct(sellPrice, cost),
    belowCost: cost > 0 && sellPrice > 0 && sellPrice < cost,
    childBelowCost: costPerChild !== null && sellPriceChild > 0 && sellPriceChild < costPerChild,
    unitsChange,
    stockAfter: now && unitsChange ? stockAfter(now.stockBase, now.units, units, pick.rescale) : null,
  };
}
