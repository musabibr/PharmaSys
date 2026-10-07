import {
  roundPrice, nextEnding, checkRule, parseCustomRules, findRule, ruleRanges,
  BUILT_IN_ROUNDING_RULES, NO_ROUNDING, type RoundingRule,
} from '@core/common/price-rounding';

const rule = (id: string) => BUILT_IN_ROUNDING_RULES.find(r => r.id === id)!;

describe('price rounding', () => {
  it('rounds to the nearest 500 at the 250 / 750 marks', () => {
    const r = rule('nearest-500');
    expect([7000, 7240, 7249, 7250, 7500, 7749, 7750, 7999].map(p => roundPrice(p, r)))
      .toEqual([7000, 7000, 7000, 7500, 7500, 7500, 8000, 8000]);
  });

  it('rounds up to the next 500, leaving exact prices alone', () => {
    const r = rule('up-500');
    expect([7000, 7001, 7240, 7500, 7501, 7999].map(p => roundPrice(p, r)))
      .toEqual([7000, 7500, 7500, 7500, 8000, 8000]);
  });

  it('applies the "under 250 → 500, otherwise → 1,000" reading', () => {
    const r = rule('under-250-500');
    expect([7000, 7100, 7249, 7250, 7600].map(p => roundPrice(p, r))).toEqual([7000, 7500, 7500, 8000, 8000]);
  });

  it('never rounds below the floor: the next ending above it is used', () => {
    const r = rule('nearest-500');
    // 7,240 would round down to 7,000, under a cost of 7,100.
    expect(roundPrice(7240, r, { floor: 7100 })).toBe(7500);
    expect(roundPrice(7240, r, { floor: 6000 })).toBe(7000);
    expect(nextEnding(7501, r)).toBe(8000);
    expect(nextEnding(7000, r)).toBe(7000);
  });

  it('leaves prices alone without a rule, and keeps whole SDG', () => {
    expect(roundPrice(7240.6, null)).toBe(7241);
    expect(roundPrice(0, rule('nearest-500'))).toBe(0);
    expect(roundPrice(130, rule('nearest-50'))).toBe(150);
    expect(roundPrice(120, rule('nearest-50'))).toBe(100);
  });

  it('checks custom rules: ascending bands covering the whole block, endings inside it', () => {
    const good = checkRule({ name: 'Mine', block: 1000, bands: [{ upTo: 299, to: 0 }, { upTo: 999, to: 1000 }] });
    expect(good.ok).toBe(true);
    expect(checkRule({ name: '', block: 1000, bands: [{ upTo: 999, to: 0 }] })).toEqual({ ok: false, error: 'Give the rule a name' });
    expect(checkRule({ name: 'x', block: 1000, bands: [{ upTo: 500, to: 0 }] }).ok).toBe(false);          // gap after 500
    expect(checkRule({ name: 'x', block: 1000, bands: [{ upTo: 600, to: 0 }, { upTo: 400, to: 0 }] }).ok).toBe(false); // not ascending
    expect(checkRule({ name: 'x', block: 1000, bands: [{ upTo: 999, to: 1500 }] }).ok).toBe(false);       // ending outside block
  });

  it('reads custom rules from settings, skipping broken entries and built-in ids', () => {
    const custom: RoundingRule = { id: 'custom-a', name: 'A', block: 100, bands: [{ upTo: 99, to: 100 }] };
    const parsed = parseCustomRules(JSON.stringify([custom, { name: 'bad' }, { ...custom, id: 'nearest-500' }]));
    expect(parsed).toEqual([custom]);
    expect(parseCustomRules('not json')).toEqual([]);
    expect(findRule('custom-a', parsed)).toEqual(custom);
    expect(findRule(NO_ROUNDING, parsed)).toBeNull();
    expect(ruleRanges(rule('nearest-500'))).toEqual([
      { from: 0, to: 249, ending: 0 }, { from: 250, to: 749, ending: 500 }, { from: 750, to: 999, ending: 1000 },
    ]);
  });
});
