import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings.store';
import { useIsAdmin } from '@/hooks/usePermission';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  BUILT_IN_ROUNDING_RULES, NO_ROUNDING, ROUNDING_BLOCKS,
  ROUNDING_RULES_SETTING, ROUNDING_DEFAULT_SETTING, ROUNDING_SMALL_DEFAULT_SETTING,
  allRules, checkRule, findRule, newRuleId, parseCustomRules, roundPrice, ruleRanges,
  type RoundingBand, type RoundingRule,
} from '../../../core/common/price-rounding';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** This device's choice of rules, remembered between invoices. */
const LOCAL_KEY = 'pharmasys_price_rounding';
const BUILT_IN_IDS = new Set(BUILT_IN_ROUNDING_RULES.map(r => r.id));
/** Pack prices: the pharmacy's own reading, until an admin picks another default. */
const PACK_DEFAULT = 'under-250-500';

function readLocal(): { pack?: string; child?: string } {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') as unknown;
    return v && typeof v === 'object' ? v as { pack?: string; child?: string } : {};
  } catch {
    return {};
  }
}

/**
 * The rounding rules on offer and the ones chosen for pack and small-unit
 * prices: this device's last choice, else the pharmacy's default, else none.
 */
export function usePriceRounding() {
  const settings = useSettingsStore(s => s.settings);
  const custom = useMemo(() => parseCustomRules(settings[ROUNDING_RULES_SETTING]), [settings]);
  const [local, setLocal] = useState(readLocal);
  const packWanted = local.pack || settings[ROUNDING_DEFAULT_SETTING] || PACK_DEFAULT;
  const childWanted = local.child || settings[ROUNDING_SMALL_DEFAULT_SETTING] || NO_ROUNDING;
  const packRule = findRule(packWanted, custom);
  const childRule = findRule(childWanted, custom);

  const choose = (which: 'pack' | 'child', id: string) => setLocal(prev => {
    const next = { ...prev, [which]: id };
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(next)); } catch { /* remembered for this session only */ }
    return next;
  });

  return {
    custom,
    rules: allRules(custom),
    packId: packRule ? packRule.id : NO_ROUNDING,
    childId: childRule ? childRule.id : NO_ROUNDING,
    packRule,
    childRule,
    setPackId: (id: string) => choose('pack', id),
    setChildId: (id: string) => choose('child', id),
  };
}

/** A rule's name: the built-in ones are translated, the pharmacy's own shown as written. */
export function ruleLabel(rule: RoundingRule, t: T): string {
  return BUILT_IN_IDS.has(rule.id) ? t(rule.name) : rule.name;
}

const num = (n: number) => n.toLocaleString('en-US');

/** The bands of a rule as "250–749 → 500" lines. */
function rangeLines(rule: RoundingRule, t: T): string[] {
  const digits = String(rule.block - 1).length;
  const pad = (n: number) => String(n).padStart(digits, '0');
  return ruleRanges(rule).map(r => {
    const ending = r.ending === 0 ? pad(0) : r.ending >= rule.block ? t('next {{block}}', { block: num(rule.block) }) : pad(r.ending);
    return `${r.from === r.to ? pad(r.from) : `${pad(r.from)}–${pad(r.to)}`} → ${ending}`;
  });
}

/** Prices spread across a block, to show what a rule does. */
function samplePrices(rule: RoundingRule): number[] {
  const base = 7 * rule.block;
  return [0.12, 0.38, 0.64, 0.91].map(f => base + Math.round(f * rule.block));
}

function RuleExamples({ rule }: { rule: RoundingRule }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground" dir="ltr">
      {samplePrices(rule).map(p => <span key={p}>{num(p)} → <span className="font-medium text-foreground">{num(roundPrice(p, rule))}</span></span>)}
    </span>
  );
}

export function RoundingSelect({ value, onChange, rules, label, className }: {
  value: string;
  onChange: (id: string) => void;
  rules: RoundingRule[];
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn('h-8 text-xs', className)} aria-label={label} title={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ROUNDING}>{t("Don't round")}</SelectItem>
        {rules.map(r => <SelectItem key={r.id} value={r.id}>{ruleLabel(r, t)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Bands rescaled to another block size, kept ascending and covering it. */
function rescaleBands(bands: RoundingBand[], from: number, to: number): RoundingBand[] {
  const out: RoundingBand[] = [];
  for (const b of bands) {
    const upTo = Math.min(to - 1, Math.round(((b.upTo + 1) * to) / from) - 1);
    const ending = Math.min(to, Math.round((b.to * to) / from));
    if (out.length && upTo <= out[out.length - 1].upTo) continue;
    out.push({ upTo: Math.max(0, upTo), to: ending });
  }
  if (out.length === 0) out.push({ upTo: to - 1, to: 0 });
  out[out.length - 1] = { ...out[out.length - 1], upTo: to - 1 };
  return out;
}

function RuleEditor({ draft, onChange }: { draft: RoundingRule; onChange: (rule: RoundingRule) => void }) {
  const { t } = useTranslation();
  const [tryPrice, setTryPrice] = useState('');
  const check = checkRule(draft);
  // The bands on their own, so prices can be tried before the rule has a name.
  const shape = checkRule({ ...draft, name: draft.name.trim() || '—' });
  const block = draft.block;

  const setBand = (i: number, patch: Partial<RoundingBand>) =>
    onChange({ ...draft, bands: draft.bands.map((b, n) => (n === i ? { ...b, ...patch } : b)) });
  const addBand = () => {
    const bands = [...draft.bands];
    const last = bands.length - 1;
    const start = last > 0 ? bands[last - 1].upTo + 1 : 0;
    const mid = Math.floor((start + block - 1) / 2);
    if (mid < start || mid >= block - 1) return;
    bands.splice(last, 0, { upTo: mid, to: last > 0 ? bands[last - 1].to : 0 });
    onChange({ ...draft, bands });
  };
  const removeBand = (i: number) => {
    const bands = draft.bands.filter((_, n) => n !== i);
    bands[bands.length - 1] = { ...bands[bands.length - 1], upTo: block - 1 };
    onChange({ ...draft, bands });
  };
  const tried = Number(tryPrice.replace(/,/g, ''));

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="space-y-1">
          <Label className="text-xs">{t('Rule name')}</Label>
          <Input value={draft.name} maxLength={60} onChange={e => onChange({ ...draft, name: e.target.value })} placeholder={t('e.g. Shelf prices')} className="h-8" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('Last digits counted in')}</Label>
          <Select value={String(block)} onValueChange={v => onChange({ ...draft, block: Number(v), bands: rescaleBands(draft.bands, block, Number(v)) })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROUNDING_BLOCKS.map(b => <SelectItem key={b} value={String(b)}>{t('Blocks of {{n}}', { n: num(b) })}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t('When the last digits are…')}</Label>
        {draft.bands.map((b, i) => {
          const from = i === 0 ? 0 : draft.bands[i - 1].upTo + 1;
          const isLast = i === draft.bands.length - 1;
          return (
            <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs" dir="ltr">
              <span className="w-14 text-end tabular-nums text-muted-foreground">{num(from)}</span>
              <span>–</span>
              {isLast
                ? <span className="w-20 tabular-nums">{num(block - 1)}</span>
                : <Input type="number" min={from} max={block - 2} value={b.upTo} className="h-7 w-20 text-xs"
                    onChange={e => setBand(i, { upTo: Math.floor(Number(e.target.value) || 0) })} />}
              <span className="px-1">→</span>
              <Input type="number" min={0} max={block} value={b.to} className="h-7 w-20 text-xs"
                onChange={e => setBand(i, { to: Math.floor(Number(e.target.value) || 0) })} />
              <Button type="button" size="sm" variant={b.to === 0 ? 'secondary' : 'ghost'} className="h-7 px-2 text-[11px]" onClick={() => setBand(i, { to: 0 })}>
                {t('Down')}
              </Button>
              <Button type="button" size="sm" variant={b.to === block ? 'secondary' : 'ghost'} className="h-7 px-2 text-[11px]" onClick={() => setBand(i, { to: block })}>
                {t('Up to next')}
              </Button>
              {draft.bands.length > 1 && (
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => removeBand(i)} title={t('Remove')}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        })}
        {draft.bands.length < 10 && (
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={addBand}>
            <Plus className="h-3.5 w-3.5" />{t('Split the last band')}
          </Button>
        )}
      </div>

      {shape.ok ? (
        <div className="space-y-1.5 rounded-md border bg-background p-2">
          <RuleExamples rule={shape.rule} />
          <div className="flex items-center gap-2 text-xs">
            <Input value={tryPrice} onChange={e => setTryPrice(e.target.value)} placeholder={t('Try a price')} inputMode="numeric" className="h-7 w-32 text-xs" />
            {tried > 0 && <span className="tabular-nums" dir="ltr">{num(tried)} → <strong>{num(roundPrice(tried, shape.rule))}</strong></span>}
          </div>
        </div>
      ) : (
        <p className="text-xs text-destructive" role="alert">{t(shape.error)}</p>
      )}
      {shape.ok && !check.ok && <p className="text-xs text-muted-foreground">{t(check.error)}</p>}
    </div>
  );
}

/**
 * The rounding rules: the ready-made ones and the pharmacy's own, what each
 * does to a price, and (admins) adding, changing and choosing the defaults.
 */
export function RoundingRulesDialog({ open, onOpenChange, startFrom }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rule a new one is copied from. */
  startFrom?: RoundingRule | null;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isAdmin = useIsAdmin();
  const settings = useSettingsStore(s => s.settings);
  const setSetting = useSettingsStore(s => s.setSetting);
  const custom = useMemo(() => parseCustomRules(settings[ROUNDING_RULES_SETTING]), [settings]);
  const rules = useMemo(() => allRules(custom), [custom]);
  const [draft, setDraft] = useState<RoundingRule | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!open) setDraft(null); }, [open]);

  const packDefault = findRule(settings[ROUNDING_DEFAULT_SETTING] || PACK_DEFAULT, custom)?.id ?? NO_ROUNDING;
  const childDefault = findRule(settings[ROUNDING_SMALL_DEFAULT_SETTING], custom)?.id ?? NO_ROUNDING;

  const startNew = (from?: RoundingRule | null) => {
    const base = from ?? startFrom ?? BUILT_IN_ROUNDING_RULES[0];
    setDraft({ id: newRuleId(), name: from ? `${ruleLabel(from, t)} (${t('copy')})` : '', block: base.block, bands: base.bands.map(b => ({ ...b })) });
  };

  const saveRules = async (next: RoundingRule[]) => {
    await setSetting(ROUNDING_RULES_SETTING, JSON.stringify(next));
  };

  const saveDraft = async () => {
    if (!draft) return;
    const check = checkRule(draft);
    if (!check.ok) { toast.error(t(check.error)); return; }
    const exists = custom.some(r => r.id === draft.id);
    setSaving(true);
    try {
      await saveRules(exists ? custom.map(r => (r.id === draft.id ? check.rule : r)) : [...custom, check.rule]);
      toast.success(t('Rounding rule saved'));
      setDraft(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save the rule'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: RoundingRule) => {
    const ok = await confirm({
      title: t('Delete rule'),
      description: t('Delete the rounding rule "{{name}}"? Prices already saved keep their values.', { name: rule.name }),
      confirmLabel: t('Delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await saveRules(custom.filter(r => r.id !== rule.id));
      if (packDefault === rule.id) await setSetting(ROUNDING_DEFAULT_SETTING, NO_ROUNDING);
      if (childDefault === rule.id) await setSetting(ROUNDING_SMALL_DEFAULT_SETTING, NO_ROUNDING);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete the rule'));
    }
  };

  const setDefault = async (key: string, id: string) => {
    try {
      await setSetting(key, id);
      toast.success(t('Default saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save'));
    }
  };

  const ruleRow = (rule: RoundingRule, own: boolean) => (
    <li key={rule.id} className="space-y-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" dir="auto">{ruleLabel(rule, t)}</span>
        {packDefault === rule.id && <Badge variant="secondary" className="text-[10px]">{t('Default for packs')}</Badge>}
        {childDefault === rule.id && <Badge variant="secondary" className="text-[10px]">{t('Default for small units')}</Badge>}
        {isAdmin && (
          <span className="ms-auto flex gap-1">
            <Button size="icon" variant="ghost" className="h-7 w-7" title={t('Copy and adjust')} onClick={() => startNew(rule)}><Copy className="h-3.5 w-3.5" /></Button>
            {own && <Button size="icon" variant="ghost" className="h-7 w-7" title={t('Edit')} onClick={() => setDraft({ ...rule, bands: rule.bands.map(b => ({ ...b })) })}><Pencil className="h-3.5 w-3.5" /></Button>}
            {own && <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title={t('Delete')} onClick={() => void remove(rule)}><Trash2 className="h-3.5 w-3.5" /></Button>}
          </span>
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 text-[11px] tabular-nums text-muted-foreground" dir="ltr">
        {rangeLines(rule, t).map(l => <span key={l}>{l}</span>)}
      </p>
      <RuleExamples rule={rule} />
    </li>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Price rounding rules')}</DialogTitle>
          <DialogDescription>
            {t('A rule sets the last digits of a selling price worked out from the cost. Rounding never takes a price below its cost; typed prices are left as typed.')}
          </DialogDescription>
        </DialogHeader>

        {draft ? (
          <>
            <RuleEditor draft={draft} onChange={setDraft} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
              <Button onClick={() => void saveDraft()} disabled={saving || !checkRule(draft).ok} className="gap-1">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}{t('Save rule')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="space-y-4">
            {isAdmin ? (
              <div className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">{t('Offer first for pack prices')}</Label>
                  <RoundingSelect value={packDefault} onChange={id => void setDefault(ROUNDING_DEFAULT_SETTING, id)} rules={rules} label={t('Offer first for pack prices')} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('Offer first for small-unit prices')}</Label>
                  <RoundingSelect value={childDefault} onChange={id => void setDefault(ROUNDING_SMALL_DEFAULT_SETTING, id)} rules={rules} label={t('Offer first for small-unit prices')} />
                </div>
                <p className="text-[11px] text-muted-foreground sm:col-span-2">{t('Each device remembers the rules last chosen on it; these apply until then.')}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('Only an admin can add or change rounding rules.')}</p>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">{t('Your rules')}</h4>
                {isAdmin && <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => startNew(null)}><Plus className="h-3.5 w-3.5" />{t('New rule')}</Button>}
              </div>
              {custom.length === 0
                ? <p className="text-xs text-muted-foreground">{t('None yet. Copy a ready-made rule to adjust it, or start a new one.')}</p>
                : <ul className="space-y-1.5">{custom.map(r => ruleRow(r, true))}</ul>}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">{t('Ready-made rules')}</h4>
              <ul className="space-y-1.5">{BUILT_IN_ROUNDING_RULES.map(r => ruleRow(r, false))}</ul>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
