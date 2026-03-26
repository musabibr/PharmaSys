/**
 * PharmaSys — License Storage
 *
 * Stores the license file as plain JSON in the user data directory.
 * Security is provided entirely by the ECDSA P-256 signature in the license
 * file and the machine-ID binding check in the validator — not by encryption.
 * Removing DPAPI (safeStorage) eliminates the fragile coupling to the Windows
 * user account that caused paying customers to be locked out after a Windows
 * reinstall or user-profile change.
 *
 * Storage location: %APPDATA%\PharmaSys\pharmasys.license (production)
 *                   userData/pharmasys.license (development)
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs   from 'fs';

function getLicensePath(): string {
  return path.join(app.getPath('userData'), 'pharmasys.license');
}

/**
 * Write the license JSON to disk.
 */
export function saveLicense(licenseJson: string): void {
  fs.writeFileSync(getLicensePath(), licenseJson, { encoding: 'utf-8' });
}

/**
 * Read the stored license JSON.
 * Returns null if no license file exists.
 */
export function loadLicense(): string | null {
  const p = getLicensePath();
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Remove the stored license (used when resetting activation for support purposes).
 */
export function deleteLicense(): void {
  const p = getLicensePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
