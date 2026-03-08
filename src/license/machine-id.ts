/**
 * PharmaSys — Hardware Machine ID
 *
 * Generates a stable hardware fingerprint from Windows WMI identifiers.
 * Survives OS reinstalls, app reinstalls, and reboots.
 * Changes only when physical hardware is replaced.
 */

import { execSync } from 'child_process';
import * as crypto  from 'crypto';

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

/**
 * Collect hardware identifiers and hash them into a stable machine fingerprint.
 * Format: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (32 hex chars in 4 groups of 8)
 */
export function getMachineId(): string {
  const cpuId  = wmicQuery('cpu get ProcessorId');
  const mbId   = wmicQuery('baseboard get SerialNumber');
  const diskId = wmicQuery('diskdrive where "Index=0" get SerialNumber');

  const raw  = [cpuId, mbId, diskId].join('|');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();

  // Format as 4 groups of 8 hex chars: A3F2B7C1-D4E5F6A7-B8C9D0E1-F2A3B4C5
  return [0, 8, 16, 24].map(i => hash.slice(i, i + 8)).join('-');
}

/**
 * Shorter display version for the user to read aloud / send via WhatsApp.
 * Returns the first two groups only: A3F2B7C1-D4E5F6A7 (17 chars)
 */
export function getDisplayMachineId(): string {
  return getMachineId().split('-').slice(0, 2).join('-');
}
