/**
 * Local License — persisted license file created after successful activation.
 *
 * Stored at: %APPDATA%/PharmaSys/pharmasys.license (production)
 *            <projectRoot>/data/pharmasys.license   (dev)
 *
 * The file is HMAC-signed to prevent tampering.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Same HMAC secret as activation-key.ts (compiled to bytecode in production)
const HMAC_SECRET = Buffer.from(
  'a9f406623045d715a66c6bd92605f881c2f16e3e0e8b1074c79011a4077cc96b' +
  '2beb43ba7b18ff4abb1eb9d0373c8047eacfc494743262b5cc0f977907cd7cdf',
  'hex'
);

let _licensePath: string | null = null;

/** Must be called once from main.ts before any license operations. */
export function setLicensePath(dataDir: string): void {
  _licensePath = path.join(dataDir, 'pharmasys.license');
}

function getLicensePath(): string {
  if (!_licensePath) throw new Error('License path not set — call setLicensePath() first');
  return _licensePath;
}

// ─── License Data ────────────────────────────────────────────────────────────

export interface LocalLicense {
  activatedAt: string;     // ISO date string
  durationDays: number;    // 0 = forever
  machineId: string;       // Machine ID at activation time
  keyHash: string;         // SHA256 of the activation key (audit trail)
  hmac: string;            // HMAC of activatedAt+durationDays+machineId (tamper detection)
}

export interface LicenseStatus {
  valid: boolean;
  daysRemaining: number;   // -1 = forever, 0 = expired today
  reason?: string;
}

// ─── HMAC for tamper detection ───────────────────────────────────────────────

function computeLicenseHmac(activatedAt: string, durationDays: number, machineId: string): string {
  return crypto.createHmac('sha256', HMAC_SECRET)
    .update(`${activatedAt}|${durationDays}|${machineId}`)
    .digest('hex');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Create and save a local license after successful key activation. */
export function createAndSaveLicense(keyString: string, durationDays: number, machineId: string): LocalLicense {
  const activatedAt = new Date().toISOString();
  const keyHash = crypto.createHash('sha256').update(keyString).digest('hex');
  const hmac = computeLicenseHmac(activatedAt, durationDays, machineId);

  const license: LocalLicense = { activatedAt, durationDays, machineId, keyHash, hmac };

  const filePath = getLicensePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(license, null, 2), 'utf-8');

  return license;
}

/** Load local license from disk. Returns null if not found. */
export function loadLicense(): LocalLicense | null {
  try {
    const raw = fs.readFileSync(getLicensePath(), 'utf-8');
    return JSON.parse(raw) as LocalLicense;
  } catch {
    return null;
  }
}

/** Delete local license (for support/reset scenarios). */
export function deleteLicense(): void {
  try {
    fs.unlinkSync(getLicensePath());
  } catch { /* ignore if not found */ }
}

/** Validate a loaded local license. */
export function validateLicense(license: LocalLicense): LicenseStatus {
  // Tamper check (includes machineId — moving license to another device fails)
  const expectedHmac = computeLicenseHmac(license.activatedAt, license.durationDays, license.machineId || '');
  if (license.hmac !== expectedHmac) {
    return { valid: false, daysRemaining: 0, reason: 'License file has been tampered with' };
  }

  // Forever license
  if (license.durationDays === 0) {
    return { valid: true, daysRemaining: -1 };
  }

  // Time-limited license
  const activatedAt = new Date(license.activatedAt).getTime();
  const expiresAt = activatedAt + (license.durationDays * 86_400_000);
  const now = Date.now();

  if (now > expiresAt) {
    return { valid: false, daysRemaining: 0, reason: 'License has expired' };
  }

  const daysRemaining = Math.ceil((expiresAt - now) / 86_400_000);
  return { valid: true, daysRemaining };
}
