import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { cn, unitLabel } from '@/lib/utils';

interface QtyInputProps {
  /** Units per parent (conversion factor). cf<=1 → single (small-unit) input. */
  cf: number;
  parentUnit?: string;
  childUnit?: string;
  /** Current value in BASE (small) units. */
  valueBase: number;
  /** Emits the new value in BASE units. */
  onChangeBase: (base: number) => void;
  disabled?: boolean;
  /** Tighter widths for table cells. */
  compact?: boolean;
}

/**
 * Dual-unit quantity entry: "[boxes] box + [strips] strip" when cf>1, or a single
 * small-unit field when cf<=1. Emits the total in BASE (small) units. Keeps local
 * string state so a field can be cleared without snapping back to 0; re-derives from
 * valueBase when the parent resets it externally.
 */
export function QtyInput({ cf, parentUnit, childUnit, valueBase, onChangeBase, disabled, compact }: QtyInputProps) {
  const { t } = useTranslation();
  const c = cf > 1 ? cf : 1;
  const dual = cf > 1;
  const [boxes, setBoxes] = useState('');
  const [strips, setStrips] = useState('');

  // Re-derive the fields when the parent changes valueBase to something that doesn't
  // match what's currently typed (e.g. form reset / row seeded). No-op while typing,
  // because onChangeBase keeps the parent value equal to the current fields.
  useEffect(() => {
    const cur = (parseInt(boxes || '0', 10) || 0) * c + (parseInt(strips || '0', 10) || 0);
    if (cur === valueBase) return;
    if (dual) {
      setBoxes(valueBase ? String(Math.floor(valueBase / c)) : '');
      setStrips(valueBase ? String(valueBase % c) : '');
    } else {
      setBoxes('');
      setStrips(valueBase ? String(valueBase) : '');
    }
  }, [valueBase]); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = (b: string, s: string) =>
    onChangeBase((parseInt(b || '0', 10) || 0) * c + (parseInt(s || '0', 10) || 0));

  const w = compact ? 'w-14' : 'w-16';
  const parentLabel = unitLabel(parentUnit, t, t('box'));
  const childLabel = unitLabel(childUnit, t, t('unit'));

  if (!dual) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="number" min={0} disabled={disabled}
          className={cn(w, 'text-end')}
          placeholder="0"
          value={strips}
          onChange={(e) => { setStrips(e.target.value); emit(boxes, e.target.value); }}
        />
        <span className="text-xs text-muted-foreground">{childUnit ? childLabel : unitLabel(parentUnit, t, t('unit'))}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number" min={0} disabled={disabled}
        className={cn(w, 'text-end')}
        placeholder="0"
        value={boxes}
        onChange={(e) => { setBoxes(e.target.value); emit(e.target.value, strips); }}
      />
      <span className="text-xs text-muted-foreground">{parentLabel}</span>
      <span className="text-muted-foreground">+</span>
      <Input
        type="number" min={0} disabled={disabled}
        className={cn(w, 'text-end')}
        placeholder="0"
        value={strips}
        onChange={(e) => { setStrips(e.target.value); emit(boxes, e.target.value); }}
      />
      <span className="text-xs text-muted-foreground">{childLabel}</span>
    </div>
  );
}
