import type { PharmaSysApi } from './types';
export type { PharmaSysApi };

// window.api is injected by Electron's preload script via contextBridge.
// If running outside Electron (e.g. browser dev), it won't exist.
if (!window.api) {
  console.warn('[PharmaSys] window.api is not available — preload script did not run. Running outside Electron?');
}

export const api = window.api as PharmaSysApi;

/**
 * Check if an IPC response is an error object and throw if so.
 * The IPC layer returns `{ success: false, error: "...", code: "..." }` on failure
 * instead of throwing, so callers must detect this explicitly.
 *
 * Usage:  const result = throwIfError(await api.users.update(id, data));
 */
export function throwIfError<T>(result: T): T {
  if (
    result &&
    typeof result === 'object' &&
    'success' in result &&
    (result as Record<string, unknown>).success === false &&
    'error' in result
  ) {
    throw new Error((result as Record<string, unknown>).error as string);
  }
  return result;
}
