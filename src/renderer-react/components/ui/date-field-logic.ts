/**
 * Pure logic behind DateField / DateRangeField (DT2), kept free of React so
 * it can be unit-tested and reused.
 */
import {
  parseCalendarDate, isCanonicalISODate, toLocalISODate, addDaysISO, toAsciiDigits,
} from '../../../core/common/dates';

const pad = (n: number) => String(n).padStart(2, '0');

/** DD/MM/YYYY for display; '' for anything that isn't a canonical date. */
export function formatDateDMY(iso: string): string {
  if (!isCanonicalISODate(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export type TypedDate = { ok: true; iso: string } | { ok: false; message: string } | { ok: 'empty' };

/**
 * Typed dates: DD/MM/YYYY with any separator (Arabic digits accepted), a
 * two-digit year, compact DDMMYYYY, ISO, or shortcuts — "t" / "today" /
 * "اليوم", "y" / "yesterday" / "أمس", "-3" / "+7" for days from today.
 */
export function readTypedDate(text: string, today = toLocalISODate(new Date())): TypedDate {
  const raw = toAsciiDigits(text).trim().toLowerCase();
  if (!raw) return { ok: 'empty' };
  if (raw === 't' || raw === 'today' || raw === 'اليوم') return { ok: true, iso: today };
  if (raw === 'y' || raw === 'yesterday' || raw === 'أمس' || raw === 'امس') return { ok: true, iso: addDaysISO(today, -1) };
  const offset = /^([+-])\s*(\d{1,4})$/.exec(raw);
  if (offset) return { ok: true, iso: addDaysISO(today, (offset[1] === '-' ? -1 : 1) * Number(offset[2])) };
  if (isCanonicalISODate(raw)) return { ok: true, iso: raw };
  // Any separator ("25 12 2026", "25,12,26"), or none at all ("25122026").
  const separated = /^(\d{1,4})\D+(\d{1,2})\D+(\d{2,4})$/.exec(raw);
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(raw);
  const candidate = separated ? `${separated[1]}/${separated[2]}/${separated[3]}`
    : compact ? `${compact[1]}/${compact[2]}/${compact[3]}` : raw;
  const parsed = parseCalendarDate(candidate, 'dmy');
  if (parsed.ok) return { ok: true, iso: parsed.iso };
  return { ok: false, message: 'Use day/month/year, e.g. 25/12/2026' };
}

export interface DateRange { start: string; end: string }

export type DateRangePreset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth';

export function presetRange(preset: DateRangePreset, today = toLocalISODate(new Date())): DateRange {
  const [y, m] = today.split('-').map(Number);
  switch (preset) {
    case 'today': return { start: today, end: today };
    case 'yesterday': { const d = addDaysISO(today, -1); return { start: d, end: d }; }
    case 'last7': return { start: addDaysISO(today, -6), end: today };
    case 'thisMonth': return { start: `${y}-${pad(m)}-01`, end: today };
    case 'lastMonth': {
      const lastPrev = addDaysISO(`${y}-${pad(m)}-01`, -1);
      return { start: `${lastPrev.slice(0, 7)}-01`, end: lastPrev };
    }
  }
}
