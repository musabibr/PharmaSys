import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Searchable, API-compatible replacement for the previous Radix Select.
 *
 * Keeps the exact same compound API used across the app
 * (Select / SelectTrigger / SelectValue / SelectContent / SelectItem) so no
 * call sites need changing, but every dropdown is now type-to-filter. All the
 * existing dropdowns are flat SelectItem lists (no groups), so options are
 * extracted from the SelectContent children and rendered in a searchable
 * popover list.
 */

interface SelectOption {
  value: string;
  node: React.ReactNode;
  text: string;
  disabled?: boolean;
}

interface SelectCtx {
  value?: string;
  onSelect: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled?: boolean;
  options: SelectOption[];
  optionByValue: Map<string, SelectOption>;
}

const Ctx = React.createContext<SelectCtx | null>(null);
const useSelectCtx = () => {
  const c = React.useContext(Ctx);
  if (!c) throw new Error('Select components must be used within <Select>');
  return c;
};

// ── Extract flat options from arbitrary SelectContent children ───────────────
function extractText(node: React.ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode }).children);
  return '';
}

function collectOptions(children: React.ReactNode, out: SelectOption[]): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === SelectItem) {
      const props = child.props as { value: string; children?: React.ReactNode; disabled?: boolean };
      out.push({
        value: props.value,
        node: props.children,
        text: extractText(props.children),
        disabled: props.disabled,
      });
    } else {
      const props = child.props as { children?: React.ReactNode };
      if (props?.children) collectOptions(props.children, out);
    }
  });
}

function findContentChildren(children: React.ReactNode): React.ReactNode {
  let found: React.ReactNode = null;
  React.Children.forEach(children, (child) => {
    if (found) return;
    if (React.isValidElement(child) && child.type === SelectContent) {
      found = (child.props as { children?: React.ReactNode }).children;
    }
  });
  return found;
}

// ── Root ─────────────────────────────────────────────────────────────────────
interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

const Select: React.FC<SelectProps> = ({ value, defaultValue, onValueChange, disabled, children }) => {
  const [open, setOpen] = React.useState(false);
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue);
  const current = value !== undefined ? value : internal;

  const options = React.useMemo(() => {
    const out: SelectOption[] = [];
    collectOptions(findContentChildren(children), out);
    return out;
  }, [children]);

  const optionByValue = React.useMemo(() => {
    const m = new Map<string, SelectOption>();
    for (const o of options) m.set(o.value, o);
    return m;
  }, [options]);

  const onSelect = (v: string) => {
    if (value === undefined) setInternal(v);
    onValueChange?.(v);
    setOpen(false);
  };

  const ctx: SelectCtx = {
    value: current, onSelect, open, setOpen: disabled ? () => {} : setOpen,
    disabled, options, optionByValue,
  };

  return (
    <Ctx.Provider value={ctx}>
      <Popover open={open} onOpenChange={ctx.setOpen}>{children}</Popover>
    </Ctx.Provider>
  );
};

// ── Trigger ──────────────────────────────────────────────────────────────────
const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, children, ...props }, ref) => {
  const { disabled } = useSelectCtx();
  return (
    <PopoverTrigger asChild>
      <button
        ref={ref}
        type="button"
        role="combobox"
        disabled={disabled}
        className={cn(
          'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>
    </PopoverTrigger>
  );
});
SelectTrigger.displayName = 'SelectTrigger';

// ── Value (renders selected label or placeholder) ────────────────────────────
const SelectValue: React.FC<{ placeholder?: React.ReactNode; className?: string }> = ({ placeholder, className }) => {
  const { value, optionByValue } = useSelectCtx();
  const selected = value !== undefined ? optionByValue.get(value) : undefined;
  if (selected) return <span className={cn('line-clamp-1 text-start', className)}>{selected.node}</span>;
  return <span className={cn('line-clamp-1 text-start text-muted-foreground', className)}>{placeholder}</span>;
};

// ── Content (search box + filtered options) ──────────────────────────────────
const SelectContent = React.forwardRef<
  HTMLDivElement,
  { children?: React.ReactNode; className?: string; position?: string }
>(({ className }, ref) => {
  const { t } = useTranslation();
  const { value, onSelect, options } = useSelectCtx();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => `${o.text}`.toLowerCase().includes(q));
  }, [options, query]);

  React.useEffect(() => { if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1)); }, [filtered.length, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[active];
      if (o && !o.disabled) onSelect(o.value);
    }
  };

  // Only show the search box once the list is long enough to warrant it.
  const showSearch = options.length > 7;

  return (
    <PopoverContent
      ref={ref}
      align="start"
      className={cn('w-[var(--radix-popover-trigger-width)] p-0', className)}
      onOpenAutoFocus={e => { if (showSearch) e.preventDefault(); }}
    >
      {showSearch && (
        <div className="flex items-center border-b px-3">
          <Search className="me-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={t('Search...')}
            className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div className="max-h-72 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">{t('No results found')}</div>
        ) : (
          filtered.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled}
              onMouseEnter={() => setActive(i)}
              onClick={() => { if (!o.disabled) onSelect(o.value); }}
              className={cn(
                'relative flex w-full select-none items-center rounded-sm py-1.5 ps-8 pe-2 text-sm outline-none',
                o.disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer',
                i === active && !o.disabled && 'bg-accent text-accent-foreground',
              )}
            >
              {o.value === value && (
                <span className="absolute start-2 flex h-3.5 w-3.5 items-center justify-center">
                  <Check className="h-4 w-4" />
                </span>
              )}
              {o.node}
            </div>
          ))
        )}
      </div>
    </PopoverContent>
  );
});
SelectContent.displayName = 'SelectContent';

// ── Item (data carrier — rendered by SelectContent, not directly) ────────────
const SelectItem: React.FC<{ value: string; children?: React.ReactNode; disabled?: boolean; className?: string }> = () => null;

// ── Passthrough exports kept for API compatibility (unused structurally) ─────
const SelectGroup: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;
const SelectLabel: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn('px-2 py-1.5 text-sm font-semibold', className)}>{children}</div>
);
const SelectSeparator: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn('-mx-1 my-1 h-px bg-muted', className)} />
);
const SelectScrollUpButton: React.FC = () => null;
const SelectScrollDownButton: React.FC = () => null;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
