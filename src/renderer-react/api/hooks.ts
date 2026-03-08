import { useState, useEffect, useCallback, useRef } from 'react';

interface UseApiCallResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Generic hook for calling window.api methods with loading/error state.
 * Includes unmount safety — will not call setState after component unmounts.
 *
 * Usage:
 *   const { data: products, loading, error, refetch } = useApiCall(
 *     () => api.products.getAll(),
 *     []
 *   );
 */
export function useApiCall<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = []
): UseApiCallResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (mountedRef.current) setData(result);
    } catch (err: unknown) {
      if (mountedRef.current) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    refetch();
    return () => { mountedRef.current = false; };
  }, [refetch]);

  return { data, loading, error, refetch };
}
