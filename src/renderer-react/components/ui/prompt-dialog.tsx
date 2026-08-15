import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Promise-based prompt dialog — replaces window.prompt().
 *
 * window.prompt()/confirm()/alert() are BLOCKING native dialogs; on
 * Electron/Windows they leave the BrowserWindow in a frozen/stuck-input state
 * that only a minimize/restore repaint clears. This React dialog is
 * non-blocking and never triggers that bug. Resolves the entered string, or
 * null if the user cancels/dismisses.
 */
export interface PromptOptions {
  title?: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type PromptFn = (opts?: PromptOptions) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<PromptOptions>({});
  const [value, setValue] = useState('');
  const resolverRef = useRef<((v: string | null) => void) | null>(null);

  const prompt = useCallback<PromptFn>((o = {}) => {
    setOpts(o);
    setValue(o.defaultValue ?? '');
    setOpen(true);
    return new Promise<string | null>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const settle = (result: string | null) => {
    setOpen(false);
    resolverRef.current?.(result);
    resolverRef.current = null;
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Dialog open={open} onOpenChange={(o) => { if (!o) settle(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{opts.title || t('Enter a value')}</DialogTitle>
            {opts.description && (
              <DialogDescription className="whitespace-pre-line">{opts.description}</DialogDescription>
            )}
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); settle(value); }}>
            <Input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={opts.placeholder}
            />
            <DialogFooter className="mt-4 gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => settle(null)}>
                {opts.cancelLabel || t('Cancel')}
              </Button>
              <Button type="submit">
                {opts.confirmLabel || t('OK')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PromptContext.Provider>
  );
}

/** Returns an async prompt() — resolves the entered string, or null if cancelled. */
export function usePrompt(): PromptFn {
  const ctx = useContext(PromptContext);
  if (!ctx) throw new Error('usePrompt must be used within a PromptProvider');
  return ctx;
}
