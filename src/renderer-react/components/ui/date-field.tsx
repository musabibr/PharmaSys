import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { isCanonicalISODate } from '../../../core/common/dates';
import {
  readTypedDate, formatDateDMY, presetRange,
  type DateRange, type DateRangePreset,
} from './date-field-logic';

export { readTypedDate, formatDateDMY, presetRange };
export type { DateRange, DateRangePreset };

export interface DateFieldProps {
  /** Canonical YYYY-MM-DD, or '' when empty. */
  value: string;
  /** Called with a canonical date or '' — never with text that didn't parse. */
  onChange: (iso: string) => void;
  /** Told whether the typed text is usable; forms should block saving while false. */
  onValidityChange?: (valid: boolean) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  min?: string;
  max?: string;
  'aria-label'?: string;
}

/**
 * A date input that shows how it read what was typed ("Fri 25 Dec 2026"),
 * refuses to silently keep an old value behind different-looking text, and
 * still offers the system calendar picker.
 */
export function DateField({
  value, onChange, onValidityChange, id, className, disabled, placeholder, min, max, 'aria-label': ariaLabel,
}: DateFieldProps) {
  const { t, i18n } = useTranslation();
  const [text, setText] = React.useState(() => formatDateDMY(value));
  const [focused, setFocused] = React.useState(false);
  const pickerRef = React.useRef<HTMLInputElement>(null);

  // Follow outside changes (reset buttons, presets) unless the user is typing.
  React.useEffect(() => {
    if (!focused) setText(formatDateDMY(value));
  }, [value, focused]);

  const parsed = readTypedDate(text);
  const outOfRange = parsed.ok === true && ((min && parsed.iso < min) || (max && parsed.iso > max));
  const valid = parsed.ok === 'empty' || (parsed.ok === true && !outOfRange);

  React.useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);

  const commit = () => {
    if (parsed.ok === 'empty') {
      if (value !== '') onChange('');
      return;
    }
    if (parsed.ok === true && !outOfRange) {
      setText(formatDateDMY(parsed.iso));
      if (parsed.iso !== value) onChange(parsed.iso);
    }
  };

  const readBack = parsed.ok === true
    ? (() => {
        const [y, m, d] = parsed.iso.split('-').map(Number);
        try {
          return new Date(y, m - 1, d).toLocaleDateString(i18n.language === 'ar' ? 'ar' : 'en-GB',
            { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
        } catch {
          return formatDateDMY(parsed.iso);
        }
      })()
    : null;
  const message = parsed.ok === false ? t(parsed.message)
    : outOfRange ? t('Date is outside the allowed range')
      : focused && readBack && text !== formatDateDMY(parsed.ok === true ? parsed.iso : '') ? readBack
        : null;

  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        value={text}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder ?? t('dd/mm/yyyy')}
        aria-label={ariaLabel}
        aria-invalid={!valid}
        title={readBack ?? undefined}
        className={cn('w-full pe-8', !valid && 'border-destructive focus-visible:ring-destructive')}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); } }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
        aria-label={t('Open calendar')}
        onClick={() => {
          const picker = pickerRef.current;
          if (!picker) return;
          try { picker.showPicker(); } catch { picker.focus(); picker.click(); }
        }}
      >
        <CalendarDays className="h-4 w-4" />
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 end-0 h-0 w-0 opacity-0"
        value={isCanonicalISODate(value) ? value : ''}
        min={min}
        max={max}
        onChange={(e) => {
          const iso = e.target.value;
          setText(formatDateDMY(iso));
          onChange(iso && isCanonicalISODate(iso) ? iso : '');
        }}
      />
      {message && (
        <p
          className={cn(
            'absolute start-0 top-full z-10 mt-0.5 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-[11px] shadow-sm',
            valid ? 'text-muted-foreground' : 'text-destructive',
          )}
          role={valid ? undefined : 'alert'}
        >
          {message}
        </p>
      )}
    </div>
  );
}

const PRESET_LABELS: Record<DateRangePreset, string> = {
  today: 'Today', yesterday: 'Yesterday', last7: 'Last 7 days', thisMonth: 'This month', lastMonth: 'Last month',
};

/** From / To dates with quick presets; the end can never be before the start. */
export function DateRangeField({ value, onChange, className }: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex flex-wrap items-end gap-2', className)}>
      <div className="space-y-1">
        <span className="block text-xs text-muted-foreground">{t('From')}</span>
        <DateField className="w-36" value={value.start} max={value.end || undefined} aria-label={t('From')}
          onChange={(start) => onChange({ start, end: value.end })} />
      </div>
      <div className="space-y-1">
        <span className="block text-xs text-muted-foreground">{t('To')}</span>
        <DateField className="w-36" value={value.end} min={value.start || undefined} aria-label={t('To')}
          onChange={(end) => onChange({ start: value.start, end })} />
      </div>
      <div className="flex flex-wrap gap-1 pb-0.5">
        {(Object.keys(PRESET_LABELS) as DateRangePreset[]).map(p => (
          <button
            key={p}
            type="button"
            className="rounded border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onChange(presetRange(p))}
          >
            {t(PRESET_LABELS[p])}
          </button>
        ))}
      </div>
    </div>
  );
}
