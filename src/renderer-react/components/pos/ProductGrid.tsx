import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Search, PackageSearch } from 'lucide-react';
import type { Product, Category } from '@/api/types';
import { api } from '@/api';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { ProductCard } from './ProductCard';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250;
const ALL_CATEGORIES = '__all__';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProductGridProps {
  onProductSelect: (productId: number) => void;
  /** Increment to force a product re-fetch (e.g. after checkout). */
  refreshKey?: number;
}

// ---------------------------------------------------------------------------
// Loading skeleton for the product grid
// ---------------------------------------------------------------------------

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-3">
            <Skeleton className="mb-2 h-4 w-3/4" />
            <Skeleton className="mb-2 h-3 w-1/2" />
            <Skeleton className="mb-2 h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <PackageSearch className="mb-3 h-12 w-12" />
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProductGrid
// ---------------------------------------------------------------------------

function ProductGridImpl({ onProductSelect, refreshKey }: ProductGridProps) {
  const { t } = useTranslation();

  // ── State ──────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES);
  const [categories, setCategories] = useState<Category[]>([]);
  const categoryOptions = useMemo(
    () => categories.map((cat) => ({ value: String(cat.id), label: cat.name })),
    [categories],
  );
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Request counter for stale-request cancellation
  const requestCounterRef = useRef(0);

  // Search input ref — kept focused for barcode scanner support
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Single in-flight refocus timer — every focus event during a busy session
  // used to queue its own uncleared setTimeout, accumulating timers and
  // risking a .focus() call after unmount (audit G4).
  const refocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Debounce the search query ──────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // ── Fetch categories once on mount ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.categories.getAll();
        if (!cancelled) {
          setCategories(Array.isArray(data) ? data : []);
        }
      } catch {
        // Categories are non-critical — fail silently, dropdown just stays empty
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Fetch products whenever debounced query or category changes ────────
  // Routed through getList() (server-side search + category filter + LIMIT)
  // instead of getAll()/search() — the old code fetched the ENTIRE active
  // catalogue on mount, on every category change (filtered client-side
  // afterward, so the filter never reduced the query), and on every 1-2
  // character crossing while typing. At a few thousand products that's
  // ~15k index seeks per keystroke plus a multi-megabyte IPC payload,
  // followed by a full re-render of the grid (audit G1).
  const fetchProducts = useCallback(async () => {
    const currentRequest = ++requestCounterRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await api.products.getList({
        search: debouncedQuery.length >= 2 ? debouncedQuery : undefined,
        category_id: categoryId !== ALL_CATEGORIES ? Number(categoryId) : undefined,
        limit: 100,
      });

      // Discard if a newer request has been fired
      if (currentRequest !== requestCounterRef.current) return;

      setProducts(Array.isArray(result?.data) ? result.data : []);
    } catch (err) {
      if (currentRequest !== requestCounterRef.current) return;
      setError(err instanceof Error ? err.message : t('Failed to load products'));
    } finally {
      if (currentRequest === requestCounterRef.current) {
        setLoading(false);
      }
    }
  }, [debouncedQuery, categoryId, t, refreshKey]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // ── Refocus search input (for barcode scanner support) ─────────────────
  const refocusSearch = useCallback(() => {
    if (refocusTimerRef.current) clearTimeout(refocusTimerRef.current);
    refocusTimerRef.current = setTimeout(() => {
      refocusTimerRef.current = null;
      searchInputRef.current?.focus();
    }, 50);
  }, []);

  // Keep search input focused — refocus when focus leaves to non-dialog elements
  useEffect(() => {
    const handler = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      // Don't steal focus from dialogs, dropdowns, or other overlays
      if (
        target.closest('[role="dialog"]') ||
        target.closest('[data-radix-popper-content-wrapper]') ||
        target.closest('[role="listbox"]')
      ) {
        return;
      }
      if (target !== searchInputRef.current) {
        refocusSearch();
      }
    };
    document.addEventListener('focusin', handler);
    return () => {
      document.removeEventListener('focusin', handler);
      if (refocusTimerRef.current) clearTimeout(refocusTimerRef.current);
    };
  }, [refocusSearch]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleCategoryChange = (value: string) => {
    setCategoryId(value);
    refocusSearch();
  };

  // ── Barcode scanner: Enter key triggers exact barcode lookup ─────────
  const handleSearchKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const trimmed = query.trim();
    if (!trimmed) return;
    try {
      const product = await api.products.findByBarcode(trimmed);
      if (product) {
        onProductSelect(product.id);
        setQuery('');
        refocusSearch();
      } else {
        // A scanned code with no exact match was a genuine silent no-op
        // before this — no beep, no toast, nothing — so the cashier would
        // scan the same item again and again with no idea why it wasn't
        // adding to the cart (audit G3). The debounced name/generic-name
        // search is still showing underneath, so this doesn't block that.
        toast.error(t('No product matches that barcode'));
      }
    } catch {
      toast.error(t('Barcode lookup failed'));
    }
  }, [query, onProductSelect, refocusSearch, t]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-3">
      {/* ── Search & Filter Bar ──────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        {/* Search input */}
        <div data-tour="pos-search" className="relative flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            autoFocus
            type="search"
            placeholder={t('Search by name, generic name, or barcode...')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="ps-9"
          />
        </div>

        {/* Category dropdown — searchable: the category list grows with the catalogue */}
        <Combobox
          value={categoryId}
          onValueChange={handleCategoryChange}
          options={categoryOptions}
          allOption={t('All Categories')}
          allValue={ALL_CATEGORIES}
          placeholder={t('All Categories')}
          searchPlaceholder={t('Search categories...')}
          emptyText={t('No categories found')}
          className="w-44 shrink-0"
        />
      </div>

      {/* ── Error State ──────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
          <button
            onClick={fetchProducts}
            className="ms-2 underline hover:no-underline"
          >
            {t('Try again')}
          </button>
        </div>
      )}

      {/* ── Product Grid (scrollable) ────────────────────────────────── */}
      <ScrollArea className="flex-1">
        {loading ? (
          <GridSkeleton />
        ) : products.length === 0 ? (
          <EmptyState
            message={
              debouncedQuery.length >= 2
                ? t('No products match your search')
                : t('No products found')
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 pb-2 lg:grid-cols-3 2xl:grid-cols-4">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onSelect={onProductSelect}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// memo(): ProductGrid re-fetches on its own triggers (search/category/
// refreshKey) — it shouldn't also re-render just because its parent
// (POSPage) re-rendered for an unrelated reason. Effective only because
// onProductSelect is now a stable useCallback identity in POSPage
// (audit G0).
export const ProductGrid = memo(ProductGridImpl);
