import { create } from 'zustand';
import type { Product } from '@/api/types';
import { api } from '@/api';

/**
 * Shared cache for the full product catalogue (audit G5).
 *
 * `api.products.getAll()` was called unbounded from 24 places across 11
 * components — several of them multiple times within a single mount, and
 * several purely as a client-side search index for a typeahead. Every one of
 * those was a full catalogue transfer over IPC.
 *
 * Two things collapse that:
 *
 *  - **In-flight de-duplication.** Concurrent callers share one request
 *    instead of each issuing their own. This alone turns a component that
 *    fetches from four places on mount into a single fetch.
 *  - **A short TTL.** Within one user flow (open a dialog, pick a product,
 *    open another) the same list is reused rather than refetched.
 *
 * The TTL is deliberately short, and is a *backstop* rather than the primary
 * freshness mechanism: anything that mutates products should call
 * `invalidateProducts()`, and callers that must observe their own write
 * (create a product, then re-render a picker that has to contain it) pass
 * `{ force: true }`. A missed invalidation therefore costs at most STALE_MS
 * of staleness in a picker, never a wrong write — the server remains the
 * authority for every mutation.
 *
 * This is not a replacement for server-side search. Components that only need
 * a typeahead should move to a real search endpoint; this makes the current
 * shape cheap without changing their behaviour.
 */
const STALE_MS = 15_000;

interface ProductsState {
  products: Product[];
  loading: boolean;
  error: string | null;
  /** Epoch ms of the last successful load, or null if never loaded. */
  loadedAt: number | null;
  /**
   * Resolve the catalogue, fetching only if the cache is stale, empty, or
   * `force` is set. Concurrent calls share one in-flight request.
   */
  ensureLoaded: (opts?: { force?: boolean }) => Promise<Product[]>;
  /** Mark the cache stale so the next ensureLoaded() refetches. */
  invalidate: () => void;
}

/** Shared across callers so concurrent ensureLoaded() calls don't stack up. */
let inFlight: Promise<Product[]> | null = null;

export const useProductsStore = create<ProductsState>((set, get) => ({
  products: [],
  loading: false,
  error: null,
  loadedAt: null,

  ensureLoaded: async (opts) => {
    const { products, loadedAt } = get();
    const fresh = loadedAt !== null && Date.now() - loadedAt < STALE_MS;
    if (!opts?.force && fresh) return products;

    // A forced reload must not piggyback on a request that started before the
    // write it is meant to observe.
    if (inFlight && !opts?.force) return inFlight;

    set({ loading: true, error: null });
    inFlight = api.products.getAll()
      .then((list) => {
        const next = Array.isArray(list) ? list : [];
        set({ products: next, loadedAt: Date.now(), loading: false });
        return next;
      })
      .catch((err: unknown) => {
        set({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load products',
        });
        // Callers already tolerate an empty catalogue; surfacing [] keeps the
        // previous per-component `.catch(() => [])` behaviour intact.
        return [];
      })
      .finally(() => { inFlight = null; });

    return inFlight;
  },

  invalidate: () => set({ loadedAt: null }),
}));

/**
 * Imperative invalidation for non-React callers and post-mutation flows.
 * Call after anything that creates, edits, deactivates, or bulk-imports
 * products so the next read reflects it.
 */
export function invalidateProducts(): void {
  useProductsStore.getState().invalidate();
}

/** Imperative read for handlers that shouldn't subscribe to the store. */
export function loadProducts(opts?: { force?: boolean }): Promise<Product[]> {
  return useProductsStore.getState().ensureLoaded(opts);
}
