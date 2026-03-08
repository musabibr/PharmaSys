/**
 * PharmaSys — License Storage
 *
 * Persists the license file encrypted with Windows DPAPI via electron.safeStorage.
 * The encrypted file is tied to both the Windows user account AND the physical machine.
 * Copying pharmasys.license to another PC renders it unreadable — a second protection
 * layer on top of the ECDSA machine-ID check.
 *
 * Storage location: %APPDATA%\PharmaSys\pharmasys.license (production)
 *                   userData/pharmasys.license (development)
 */

import { safeStorage, app } from 'electron';
import * as path from 'path';
import * as fs   from 'fs';

function getLicensePath(): string {
  return path.join(app.getPath('userData'), 'pharmasys.license');
}

/**
 * Encrypt and write the license JSON to disk.
 * Throws if safeStorage is not available (non-Windows builds without keychain).
 */
export function saveLicense(licenseJson: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: store plaintext (still protected by machine-ID + signature checks)
    fs.writeFileSync(getLicensePath(), licenseJson, { encoding: 'utf-8' });
    return;
  }
  const encrypted = safeStorage.encryptString(licenseJson);
  fs.writeFileSync(getLicensePath(), encrypted);
}

/**
 * Read and decrypt the stored license.
 * Returns null if no license exists or decryption fails (e.g. file was copied from another PC).
 */
export function loadLicense(): string | null {
  const p = getLicensePath();
  if (!fs.existsSync(p)) return null;

  try {
    const data = fs.readFileSync(p);

    if (!safeStorage.isEncryptionAvailable()) {
      // Was stored as plaintext in fallback mode
      return data.toString('utf-8');
    }

    return safeStorage.decryptString(data);
  } catch {
    // Decryption failed — file may be from a different machine/user account
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
