import {
  unitKey, sameUnit, unitsDiffer, guessCountsIn, toReceivingUnits, markupPct, priceFromMarkup,
  suggestSellChoice, suggestRescale, stockAfter, priceInUnits, invoiceHasUnits,
  pickForExisting, pickForNew, evaluatePick, lineBasis,
  type InvoiceLine, type ProductNow, type PriceRules,
} from '@core/common/purchase-match';
import { BUILT_IN_ROUNDING_RULES } from '@core/common/price-rounding';

const box10 = { parentUnit: 'Box', childUnit: 'Strip', convFactor: 10 };

describe('purchase match decisions', () => {
  it('treats spellings of the same unit as one', () => {
    expect(unitKey('Bottl.')).toBe('bottle');
    expect(sameUnit('bott', 'Bottle')).toBe(true);
    expect(sameUnit('pcs', 'Piece')).toBe(true);
    expect(sameUnit('Box', 'Strip')).toBe(false);
    expect(sameUnit('', '')).toBe(false);
    expect(unitsDiffer({ parentUnit: 'box', childUnit: '', convFactor: 7 }, { parentUnit: 'Box', childUnit: '', convFactor: 1 })).toBe(false);
    expect(unitsDiffer(box10, { ...box10, convFactor: 3 })).toBe(true);
  });

  it('reads which unit the invoice counts: by name, then by price, else packs', () => {
    expect(guessCountsIn({ unit: 'strip', cost: 600 }, box10, null)).toEqual({ countsIn: 'child', reason: 'unit-name' });
    expect(guessCountsIn({ unit: 'box', cost: 600 }, box10, 6000)).toEqual({ countsIn: 'parent', reason: 'unit-name' });
    // "unit" says nothing; 600 is a strip's price when a box last cost 6,000.
    expect(guessCountsIn({ unit: 'unit', cost: 600 }, box10, 6000)).toEqual({ countsIn: 'child', reason: 'price' });
    expect(guessCountsIn({ unit: 'unit', cost: 6400 }, box10, 6000)).toEqual({ countsIn: 'parent', reason: 'price' });
    // Neither close: stay with packs.
    expect(guessCountsIn({ unit: 'unit', cost: 2000 }, box10, 6000)).toEqual({ countsIn: 'parent', reason: 'default' });
    expect(guessCountsIn({ unit: 'strip', cost: 600 }, { parentUnit: 'Box', childUnit: '', convFactor: 1 }, null).countsIn).toBe('parent');
  });

  it('converts single units into packs, keeping the line value', () => {
    expect(toReceivingUnits(25, 600, 'child', 10)).toEqual({ quantity: 2.5, costPerParent: 6000 });
    expect(toReceivingUnits(25, 600, 'parent', 10)).toEqual({ quantity: 25, costPerParent: 600 });
    const thirds = toReceivingUnits(10, 2682.75, 'child', 3);
    expect(Math.round(thirds.quantity * 3)).toBe(10);
    expect(Math.round(thirds.quantity * thirds.costPerParent * 100) / 100).toBeCloseTo(26827.5, 1);
  });

  it('works markup both ways', () => {
    expect(markupPct(7200, 6000)).toBe(20);
    expect(markupPct(7000, 0)).toBeNull();
    expect(priceFromMarkup(6000, 20)).toBe(7200);
  });

  it('keeps today\'s price while it still earns the usual markup, and raises it otherwise', () => {
    expect(suggestSellChoice({ currentPrice: null, cost: 6000, defaultMarkupPct: 20 })).toEqual({ choice: 'invoice', reason: 'no-price' });
    expect(suggestSellChoice({ currentPrice: 5500, cost: 6000, defaultMarkupPct: 20 })).toEqual({ choice: 'invoice', reason: 'below-cost' });
    expect(suggestSellChoice({ currentPrice: 6600, cost: 6000, defaultMarkupPct: 20 })).toEqual({ choice: 'invoice', reason: 'low-margin' });
    expect(suggestSellChoice({ currentPrice: 7200, cost: 6000, defaultMarkupPct: 20 })).toEqual({ choice: 'product', reason: 'margin-ok' });
    // A cheaper invoice does not lower the price on its own.
    expect(suggestSellChoice({ currentPrice: 9000, cost: 6000, defaultMarkupPct: 20 }).choice).toBe('product');
  });

  it('keeps the pack count when the smallest unit changes meaning, the unit count otherwise', () => {
    const boxOnly = { parentUnit: 'Box', childUnit: '', convFactor: 1 };
    expect(suggestRescale(boxOnly, box10)).toBe('keep_packs');                      // strips added: stock was boxes
    expect(suggestRescale(box10, boxOnly)).toBe('keep_packs');                      // strips removed
    expect(suggestRescale(box10, { ...box10, convFactor: 3 })).toBe('keep_units'); // same strips, pack size corrected
    expect(suggestRescale(box10, { parentUnit: 'Box', childUnit: 'Tablet', convFactor: 30 })).toBe('keep_packs');
    expect(stockAfter(5, boxOnly, box10, 'keep_packs')).toBe(50);
    expect(stockAfter(45, box10, { ...box10, convFactor: 3 }, 'keep_units')).toBe(45);
  });

  it('restates today\'s prices in new units', () => {
    const boxOnly = { parentUnit: 'Box', childUnit: '', convFactor: 1 };
    // Packs keep their meaning: the box price stays, strips are priced from it.
    expect(priceInUnits({ base: 7500, child: null }, boxOnly, box10, 'keep_packs')).toEqual({ base: 7500, child: 750 });
    // Strips keep their meaning: a strip still sells at 750, a box of 3 at 2,250.
    expect(priceInUnits({ base: 7500, child: 750 }, box10, { ...box10, convFactor: 3 }, 'keep_units')).toEqual({ base: 2250, child: 750 });
    expect(priceInUnits({ base: 7500, child: 800 }, box10, box10, 'keep_units')).toEqual({ base: 7500, child: 800 });
    expect(priceInUnits({ base: null, child: null }, box10, { ...box10, convFactor: 3 }, 'keep_units')).toEqual({ base: null, child: null });
    expect(invoiceHasUnits({ parentUnit: 'Unit', childUnit: '', convFactor: 1 })).toBe(false);
    expect(invoiceHasUnits({ parentUnit: 'Box', childUnit: '', convFactor: 1 })).toBe(true);
  });
});

describe('a matched line, decided and worked out', () => {
  const nearest500 = BUILT_IN_ROUNDING_RULES.find(r => r.id === 'nearest-500')!;
  const nearest50 = BUILT_IN_ROUNDING_RULES.find(r => r.id === 'nearest-50')!;
  const rules: PriceRules = { markupPct: 20, packRule: null, childRule: null };
  const now: ProductNow = { units: box10, stockBase: 45, price: 7500, priceChild: 750, lastCostParent: 6000 };
  const line = (patch: Partial<InvoiceLine> = {}): InvoiceLine => ({ parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, quantity: 5, cost: 6000, ...patch });

  it('keeps today\'s price while the margin holds, in the product\'s units', () => {
    const pick = pickForExisting(7, line(), now, rules);
    expect(pick).toMatchObject({ productId: 7, parentUnit: 'Box', childUnit: 'Strip', convFactor: 10, countsIn: 'parent', priceSource: 'product', childSource: 'product' });
    const r = evaluatePick(line(), pick, now, rules);
    expect(r).toMatchObject({ quantity: 5, costPerParent: 6000, sellPrice: 7500, sellPriceChild: 750, markup: 25, unitsChange: false, belowCost: false });
  });

  it('reads an invoice that counts strips, and raises a price that fell under the markup', () => {
    // 30 strips at 680 = 3 boxes at 6,800; today's 7,500 is only 10% over that.
    const l = line({ parentUnit: 'Strip', childUnit: '', convFactor: 1, quantity: 30, cost: 680 });
    const pick = pickForExisting(7, l, now, rules);
    expect(pick).toMatchObject({ countsIn: 'child', countsInReason: 'unit-name', priceSource: 'invoice', sellReason: 'low-margin' });
    const r = evaluatePick(l, pick, now, { ...rules, packRule: nearest500, childRule: nearest50 });
    expect(r.quantity).toBe(3);
    expect(r.costPerParent).toBe(6800);
    expect(r.sellPrice).toBe(8000);        // 8,160 → nearest 500
    expect(r.sellPriceChild).toBe(800);    // 800 → nearest 50, above a strip's 680
  });

  it('never rounds under the cost, and follows a line\'s own markup', () => {
    const pick = { ...pickForExisting(7, line({ cost: 7100 }), now, rules), priceSource: 'markup' as const, lineMarkup: 2 };
    // 7,242 rounds down to 7,000 under a cost of 7,100: the next ending is used.
    expect(evaluatePick(line({ cost: 7100 }), pick, now, { ...rules, packRule: nearest500 }).sellPrice).toBe(7500);
    const typed = { ...pick, priceSource: 'custom' as const, sellPrice: 6900 };
    const r = evaluatePick(line({ cost: 7100 }), typed, now, { ...rules, packRule: nearest500 });
    expect(r).toMatchObject({ sellPrice: 6900, belowCost: true });
  });

  it('works out a units change: stock kept, prices restated', () => {
    const pick = { ...pickForExisting(7, line({ convFactor: 3 }), now, rules), convFactor: 3, rescale: 'keep_units' as const };
    const r = evaluatePick(line({ convFactor: 3, quantity: 2, cost: 1800 }), pick, now, rules);
    expect(r).toMatchObject({ unitsChange: true, stockAfter: 45, quantity: 2, costPerParent: 1800 });
    expect(r.today).toEqual({ base: 2250, child: 750 });
  });

  it('reads an invoice box of another size through its strips', () => {
    // The invoice's box holds 10 strips; the product's holds 3. Five invoice boxes are 50 strips.
    const l = line({ quantity: 5, cost: 19000 });
    const box3 = { units: { parentUnit: 'box', childUnit: 'strip', convFactor: 3 }, stockBase: 12, price: 7500, priceChild: 2500, lastCostParent: 6000 };
    const pick = pickForExisting(9, l, box3, rules);
    expect(pick).toMatchObject({ countsIn: 'pack', countsInReason: 'pack-size', convFactor: 3, priceSource: 'product' });
    const r = evaluatePick(l, pick, box3, rules);
    expect(r.quantity * 3).toBeCloseTo(50, 5);
    expect(r).toMatchObject({ costPerParent: 5700, sellPrice: 7500, unitsChange: false });
    expect(r.readings.map(o => o.countsIn)).toEqual(['parent', 'child', 'pack']);
    // Taking the invoice's pack size instead: the box is the invoice's, read as it is.
    const r10 = evaluatePick(l, { ...pick, convFactor: 10 }, box3, rules);
    expect(r10).toMatchObject({ quantity: 5, costPerParent: 19000, unitsChange: true });
    // A product kept in strips: each invoice box is 10 of them.
    const strips = { units: { parentUnit: 'Strip', childUnit: '', convFactor: 1 }, stockBase: 0, price: null, priceChild: null, lastCostParent: null };
    expect(evaluatePick(l, pickForExisting(9, l, strips, rules), strips, rules)).toMatchObject({ quantity: 50, costPerParent: 1900 });
  });

  it('treats a small unit with one per pack as no small unit', () => {
    expect(unitsDiffer({ parentUnit: 'Bottle', childUnit: 'Strip', convFactor: 1 }, { parentUnit: 'Bottle', childUnit: '', convFactor: 1 })).toBe(false);
  });

  it('starts a new product from the invoice, keeping prices that were typed', () => {
    const l = line();
    expect(pickForNew(l, { sellPrice: 7200, sellPriceChild: 720, importMarkupPct: 20 })).toMatchObject({ priceSource: 'invoice', childSource: 'auto', productId: null });
    const typed = pickForNew(l, { sellPrice: 9000, sellPriceChild: 950, importMarkupPct: 20 });
    expect(typed).toMatchObject({ priceSource: 'custom', childSource: 'custom' });
    expect(evaluatePick(l, typed, null, rules)).toMatchObject({ sellPrice: 9000, sellPriceChild: 950, unitsChange: false, stockAfter: null });
    expect(lineBasis(l)).not.toBe(lineBasis({ ...l, quantity: 6 }));
  });
});
