import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface ComboboxOption {
  value: string;
  /** Text shown in the list and (by default) matched against the search query. */
  label: string;
  /** Extra searchable text (e.g. generic name, barcode) appended to the match. */
  keywords?: string;
  /** Optional custom node to render instead of the plain label. */
  node?: React.ReactNode;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value: string | undefined | null;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  id?: string;
}

/**
 * A searchable single-select dropdown (combobox). Drop-in replacement for the
 * common Select pattern where the option list is long enough to warrant a
 * type-to-filter box. Value/label semantics mirror <Select> (string values).
 */
export function Combobox({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  className,
  contentClassName,
  id,
}: ComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.value === value);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o =>
      `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Reset the query + highlight whenever the popover opens/closes.
  React.useEffect(() => {
    if (!open) { setQuery(''); return; }
    setActiveIndex(0);
  }, [open]);

  React.useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIndex]);

  const commit = (val: string) => {
    onValueChange(val);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) commit(opt.value);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('line-clamp-1 text-start', !selected && 'text-muted-foreground')}>
            {selected ? (selected.node ?? selected.label) : (placeholder ?? t('Select...'))}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('w-[var(--radix-popover-trigger-width)] p-0', contentClassName)}
        align="start"
        onOpenAutoFocus={e => {
          // Keep focus flow but let the search input grab focus.
          e.preventDefault();
        }}
      >
        <div className="flex items-center border-b px-3">
          <Search className="me-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder ?? t('Search...')}
            className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {emptyText ?? t('No results found')}
            </div>
          ) : (
            filtered.map((opt, i) => (
              <div
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(opt.value)}
                className={cn(
                  'relative flex cursor-pointer select-none items-center rounded-sm py-1.5 ps-8 pe-2 text-sm outline-none',
                  i === activeIndex && 'bg-accent text-accent-foreground',
                )}
              >
                {opt.value === value && (
                  <span className="absolute start-2 flex h-3.5 w-3.5 items-center justify-center">
                    <Check className="h-4 w-4" />
                  </span>
                )}
                {opt.node ?? opt.label}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
