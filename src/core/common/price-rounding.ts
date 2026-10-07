/**
 * Selling-price rounding rules: how the last digits of a price become a shelf
 * ending (…000, …500).
 *
 * A rule cuts prices into blocks (e.g. 1,000) and maps each band of the
 * remainder — the last digits — to an ending: 0 rounds down to the block,
 * `block` rounds up to the next one, anything between sets those digits. So
 * "nearest 500" is: 0–249 → 000, 250–749 → 500, 750–999 → next 1,000.
 *
 * A floor (usually the cost) keeps a rounded price from going below it: the
 * price then moves to the next ending at or above the floor instead.
 *
 * Pure: shared by the renderer and the tests; no Node or DOM APIs.
 */

export interface RoundingBand {
  /** Highest remainder (last digits) this band covers; bands run in ascending order. */
  upTo: number;
  /** What the remainder becomes: 0 = round down to the block, `block` = round up to the next. */
  to: number;
}

export interface RoundingRule {
  id: string;
  name: string;
  /** Size of the block the last digits are measured in (1,000 = the last three digits). */
  block: number;
  bands: RoundingBand[];
}

/** Settings keys: custom rules (JSON) and the rules offered first for pack and small-unit prices. */
export const ROUNDING_RULES_SETTING = 'price_rounding_rules';
export const ROUNDING_DEFAULT_SETTING = 'price_rounding_default';
export const ROUNDING_SMALL_DEFAULT_SETTING = 'price_rounding_small_default';

/** "Don't round" as a selectable id. */
export const NO_ROUNDING = 'none';

export const ROUNDING_BLOCKS = [10, 50, 100, 250, 500, 1000, 5000, 10000] as const;

const MAX_BANDS = 10;

/** Ready-made rules. Ids are stable: settings and drafts refer to them. */
export const BUILT_IN_ROUNDING_RULES: readonly RoundingRule[] = [
  { id: 'nearest-500', name: 'Nearest 500', block: 1000, bands: [{ upTo: 249, to: 0 }, { upTo: 749, to: 500 }, { upTo: 999, to: 1000 }] },
  { id: 'up-500', name: 'Up to the next 500', block: 1000, bands: [{ upTo: 0, to: 0 }, { upTo: 500, to: 500 }, { upTo: 999, to: 1000 }] },
  { id: 'under-250-500', name: 'Under 250 → 500, otherwise → 1,000', block: 1000, bands: [{ upTo: 0, to: 0 }, { upTo: 249, to: 500 }, { upTo: 999, to: 1000 }] },
  { id: 'nearest-1000', name: 'Nearest 1,000', block: 1000, bands: [{ upTo: 499, to: 0 }, { upTo: 999, to: 1000 }] },
  { id: 'up-1000', name: 'Up to the next 1,000', block: 1000, bands: [{ upTo: 0, to: 0 }, { upTo: 999, to: 1000 }] },
  { id: 'nearest-100', name: 'Nearest 100', block: 100, bands: [{ upTo: 49, to: 0 }, { upTo: 99, to: 100 }] },
  { id: 'up-100', name: 'Up to the next 100', block: 100, bands: [{ upTo: 0, to: 0 }, { upTo: 99, to: 100 }] },
  { id: 'nearest-50', name: 'Nearest 50', block: 100, bands: [{ upTo: 24, to: 0 }, { upTo: 74, to: 50 }, { upTo: 99, to: 100 }] },
];

/**
 * The price with its last digits replaced by the rule's ending. Whole SDG in,
 * whole SDG out. With a floor, never below it: the next ending at or above
 * the floor is used instead.
 */
export function roundPrice(price: number, rule: RoundingRule | null | undefined, opts: { floor?: number } = {}): number {
  const p = Math.round(Number(price) || 0);
  if (!rule || p <= 0) return p;
  const base = Math.floor(p / rule.block) * rule.block;
  const rem = p - base;
  const band = rule.bands.find(b => rem <= b.upTo) ?? rule.bands[rule.bands.length - 1];
  const rounded = base + band.to;
  const floor = Number(opts.floor) > 0 ? Number(opts.floor) : 0;
  return rounded >= floor ? rounded : nextEnding(floor, rule);
}

/** The smallest price at or above `value` that ends in one of the rule's endings. */
export function nextEnding(value: number, rule: RoundingRule): number {
  const v = Math.ceil(Number(value) || 0);
  const endings = [...new Set(rule.bands.map(b => b.to))].sort((a, b) => a - b);
  const base = Math.floor(v / rule.block) * rule.block;
  for (const k of [base, base + rule.block, base + 2 * rule.block]) {
    for (const e of endings) if (k + e >= v) return k + e;
  }
  return base + 2 * rule.block;
}

/** Bands as ranges for display: remainder from–to and the ending they get. */
export function ruleRanges(rule: RoundingRule): Array<{ from: number; to: number; ending: number }> {
  let from = 0;
  return rule.bands.map(b => {
    const range = { from, to: b.upTo, ending: b.to };
    from = b.upTo + 1;
    return range;
  });
}

export type RuleCheck = { ok: true; rule: RoundingRule } | { ok: false; error: string };

/** A rule the engine can apply: bands ascending, covering every remainder, endings inside the block. */
export function checkRule(input: unknown): RuleCheck {
  if (!input || typeof input !== 'object') return { ok: false, error: 'The rule is incomplete' };
  const r = input as Partial<RoundingRule>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return { ok: false, error: 'Give the rule a name' };
  if (name.length > 60) return { ok: false, error: 'The name is too long' };
  const block = Number(r.block);
  if (!Number.isInteger(block) || block < 2 || block > 100000) return { ok: false, error: 'The block must be a whole number from 2 to 100,000' };
  if (!Array.isArray(r.bands) || r.bands.length === 0) return { ok: false, error: 'Add at least one band' };
  if (r.bands.length > MAX_BANDS) return { ok: false, error: `At most ${MAX_BANDS} bands` };
  const bands: RoundingBand[] = [];
  let prev = -1;
  for (const b of r.bands) {
    const upTo = Number(b?.upTo);
    const to = Number(b?.to);
    if (!Number.isInteger(upTo) || upTo <= prev || upTo > block - 1) {
      return { ok: false, error: 'Each band must end after the one before it, and the last at the block minus one' };
    }
    if (!Number.isInteger(to) || to < 0 || to > block) return { ok: false, error: 'Endings must be between 0 and the block' };
    bands.push({ upTo, to });
    prev = upTo;
  }
  if (bands[bands.length - 1].upTo !== block - 1) {
    return { ok: false, error: 'The last band must reach the end of the block' };
  }
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : `custom-${Date.now().toString(36)}`;
  return { ok: true, rule: { id, name, block, bands } };
}

/** Custom rules from the settings value; anything unreadable is skipped. */
export function parseCustomRules(json: string | null | undefined): RoundingRule[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    const builtIn = new Set(BUILT_IN_ROUNDING_RULES.map(r => r.id));
    const seen = new Set<string>();
    const out: RoundingRule[] = [];
    for (const item of raw) {
      const check = checkRule(item);
      if (!check.ok || builtIn.has(check.rule.id) || seen.has(check.rule.id)) continue;
      seen.add(check.rule.id);
      out.push(check.rule);
    }
    return out;
  } catch {
    return [];
  }
}

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CUSTOM_RULES = 30;

/** An id a rule can be stored under, or "don't round". */
export function isRuleId(value: unknown): boolean {
  return typeof value === 'string' && (value === NO_ROUNDING || RULE_ID.test(value));
}

/** A fresh id for a rule the pharmacy adds. */
export function newRuleId(): string {
  return `custom-${Date.now().toString(36)}`;
}

/** Why a value for the custom-rules setting can't be stored, or null when it can. */
export function customRulesProblem(json: string): string | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return 'The rounding rules could not be read'; }
  if (!Array.isArray(raw)) return 'The rounding rules must be a list';
  if (raw.length > MAX_CUSTOM_RULES) return `At most ${MAX_CUSTOM_RULES} rounding rules`;
  const builtIn = new Set(BUILT_IN_ROUNDING_RULES.map(r => r.id));
  const seen = new Set<string>();
  for (const item of raw) {
    const id = (item as { id?: unknown } | null)?.id;
    if (!isRuleId(id) || id === NO_ROUNDING) return 'Each rounding rule needs an id';
    const check = checkRule(item);
    if (!check.ok) return check.error;
    if (builtIn.has(id as string) || seen.has(id as string)) return 'Each rounding rule needs its own id';
    seen.add(id as string);
  }
  return null;
}

/** Every rule on offer: built-in first, then the pharmacy's own. */
export function allRules(custom: readonly RoundingRule[]): RoundingRule[] {
  return [...BUILT_IN_ROUNDING_RULES, ...custom];
}

export function findRule(id: string | null | undefined, custom: readonly RoundingRule[]): RoundingRule | null {
  if (!id || id === NO_ROUNDING) return null;
  return allRules(custom).find(r => r.id === id) ?? null;
}
