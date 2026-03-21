/**
 * PharmaSys — Hardware Machine ID
 *
 * Generates a stable hardware fingerprint from Windows WMI identifiers.
 * Survives OS reinstalls, app reinstalls, and reboots.
 * Changes only when physical hardware is replaced.
 *
 * Cache behaviour: call `setMachineIdCachePath(path)` from main.ts before the
 * first `getMachineId()` call.  Once set, the computed ID is persisted to
 * `<path>/machine-id.cache` so that future WMI failures (e.g. restricted
 * permissions after a Windows update) don't break the license check.
 */

import { execSync } from 'child_process';
import * as crypto  from 'crypto';
import * as fs      from 'fs';
import * as path    from 'path';

// Set once from main.ts before any license validation runs.
let _cachePath: string | null = null;

export function setMachineIdCachePath(dir: string): void {
  _cachePath = dir;
}

/**
 * Run a wmic command and return the first non-empty value found.
 */
function wmicQuery(query: string): string {
  try {
    const raw = execSync(`wmic ${query} /value`, { timeout: 4000 })
      .toString()
      .split(/\r?\n/)
      .map(line => {
        const eqIdx = line.indexOf('=');
        return eqIdx >= 0 ? line.slice(eqIdx + 1).trim() : '';
      })
      .filter(v => v.length > 0 && v !== '(null)' && v !== 'To Be Filled By O.E.M.')
      .join('');
    return raw.replace(/\s+/g, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function cacheFilePath(): string | null {
  return _cachePath ? path.join(_cachePath, 'machine-id.cache') : null;
}

function readCache(): string | null {
  const p = cacheFilePath();
  if (!p) return null;
  try {
    if (fs.existsSync(p)) {
      const id = fs.readFileSync(p, 'utf-8').trim();
      // Basic sanity: 4 groups of 8 hex chars
      if (/^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/.test(id)) return id;
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(id: string): void {
  const p = cacheFilePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, id, 'utf-8');
  } catch { /* ignore — cache is best-effort */ }
}

/**
 * Collect hardware identifiers and hash them into a stable machine fingerprint.
 * Format: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (32 hex chars in 4 groups of 8)
 *
 * On first call (after setMachineIdCachePath) the result is persisted to disk.
 * Subsequent calls use the cached value so WMI failures don't change the ID.
 */
export function getMachineId(): string {
  // 1. Return cached value if available
  const cached = readCache();
  if (cached) return cached;

  // 2. Query hardware
  const cpuId  = wmicQuery('cpu get ProcessorId');
  const mbId   = wmicQuery('baseboard get SerialNumber');
  const diskId = wmicQuery('diskdrive where "Index=0" get SerialNumber');

  const raw  = [cpuId, mbId, diskId].join('|');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  const id   = [0, 8, 16, 24].map(i => hash.slice(i, i + 8)).join('-');

  // 3. Persist only when at least one real hardware value was found
  const hasRealData = cpuId !== 'unknown' || mbId !== 'unknown' || diskId !== 'unknown';
  if (hasRealData) {
    writeCache(id);
    console.log(`[MachineId] Cached machine ID (cpu=${cpuId !== 'unknown'}, mb=${mbId !== 'unknown'}, disk=${diskId !== 'unknown'})`);
  } else {
    console.warn('[MachineId] All WMI queries returned unknown — cache not written');
  }

  return id;
}

/**
 * Shorter display version for the user to read aloud / send via WhatsApp.
 * Returns the first two groups only: A3F2B7C1-D4E5F6A7 (17 chars)
 */
export function getDisplayMachineId(): string {
  return getMachineId().split('-').slice(0, 2).join('-');
}
