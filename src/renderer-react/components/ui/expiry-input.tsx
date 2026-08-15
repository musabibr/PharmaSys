import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { formatExpiryMMYY, parseExpiryToISO } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface ExpiryInputProps {
  /** Stored ISO value (YYYY-MM-DD) or '' for no expiry. */
  value: string | null | undefined;
  /** Called with the normalized end-of-month ISO date, or '' when cleared. */
  onChange: (iso: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

/**
 * Expiry entered as MM/YY (e.g. 06/28 = June 2028). Displays the stored ISO
 * date as MM/YY, auto-inserts the slash, and emits the end-of-month ISO date
 * to the parent (or '' when blank). Only emits when the value is complete/blank
 * so partial typing doesn't clobber the stored value.
 */
export function ExpiryInput({ value, onChange, id, disabled, className, placeholder }: ExpiryInputProps) {
  const { t } = useTranslation();
  const [text, setText] = React.useState(() => formatExpiryMMYY(value));

  // Re-sync when the external value changes (e.g. editing a different row).
  React.useEffect(() => { setText(formatExpiryMMYY(value)); }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value.replace(/[^\d/]/g, '');
    // Auto-insert the slash after the two-digit month.
    if (/^\d{3,}$/.test(raw)) raw = `${raw.slice(0, 2)}/${raw.slice(2, 6)}`;
    if (raw.length > 7) raw = raw.slice(0, 7);
    setText(raw);

    if (!raw.trim()) { onChange(''); return; }
    const iso = parseExpiryToISO(raw);
    if (iso) onChange(iso);   // only propagate a complete, valid value
  };

  return (
    <Input
      id={id}
      value={text}
      onChange={handleChange}
      disabled={disabled}
      placeholder={placeholder ?? t('MM/YY')}
      inputMode="numeric"
      maxLength={7}
      className={cn(className)}
    />
  );
}
