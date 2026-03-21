import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, PackageSearch } from 'lucide-react';
import type { Product, Category } from '@/api/types';
import { api } from '@/api';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

export function ProductGrid({ onProductSelect, refreshKey }: ProductGridProps) {
  const { t } = useTranslation();

  // ── State ──────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Request counter for stale-request cancellation
  const requestCounterRef = useRef(0);

  // Search input ref — kept focused for barcode scanner support
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  const fetchProducts = useCallback(async () => {
    const currentRequest = ++requestCounterRef.current;
    setLoading(true);
    setError(null);

    try {
      let result: Product[];

      if (debouncedQuery.length >= 2) {
        // Server-side search
        result = await api.products.search(debouncedQuery);
        // If a category filter is active, apply it client-side on search results
        if (categoryId !== ALL_CATEGORIES) {
          const cid = Number(categoryId);
          result = result.filter((p) => p.category_id === cid);
        }
      } else {
        // Get all products, filter by category client-side
        result = await api.products.getAll();
        if (categoryId !== ALL_CATEGORIES) {
          const cid = Number(categoryId);
          result = result.filter((p) => p.category_id === cid);
        }
      }

      // Discard if a newer request has been fired
      if (currentRequest !== requestCounterRef.current) return;

      setProducts(Array.isArray(result) ? result : []);
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
    setTimeout(() => searchInputRef.current?.focus(), 50);
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
    return () => document.removeEventListener('focusin', handler);
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
      }
      // If not found by barcode, normal search results are already showing
    } catch {
      // Barcode lookup failed — fall through to normal search display
    }
  }, [query, onProductSelect, refocusSearch]);

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

        {/* Category dropdown */}
        <Select value={categoryId} onValueChange={handleCategoryChange}>
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue placeholder={t('All Categories')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>{t('All Categories')}</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={String(cat.id)}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
                onClick={() => onProductSelect(product.id)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
