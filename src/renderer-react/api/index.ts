import type { PharmaSysApi } from './types';
export type { PharmaSysApi };

// window.api is injected by Electron's preload script via contextBridge.
// If running outside Electron (e.g. browser dev), it won't exist.
if (!window.api) {
  console.warn('[PharmaSys] window.api is not available — preload script did not run. Running outside Electron?');
}

export const api = window.api as PharmaSysApi;

/**
 * DEPRECATED — now a no-op. Prefer plain `await api.x.y()` in new code.
 *
 * Both preload bridges are the single error boundary and *throw* on failure:
 * `preload.js` (Electron/IPC) always did, and `preload-rest.js` (LAN client
 * mode) was fixed to match — it used to return `{ success: false, error }`
 * instead, which meant any call site that forgot this wrapper silently
 * treated a failed request as a success in LAN mode (audit H7).
 *
 * Kept because ~30 call sites still use it and it is harmless: an error can
 * no longer reach it. Remove call sites opportunistically; do not add new ones.
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
