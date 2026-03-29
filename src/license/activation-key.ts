/**
 * Activation Key — encode/decode/validate offline activation keys.
 *
 * Key layout (25 bytes):
 *   [0]      version      (uint8)
 *   [1-4]    issuedAt     (uint32BE, hours since unix epoch)
 *   [5-6]    window       (uint16BE, activation window in days)
 *   [7-8]    duration     (uint16BE, license duration in days, 0=forever)
 *   [9-24]   hmac         (first 16 bytes of HMAC-SHA256)
 *
 * The key is device-independent — works on any machine.
 * Machine binding happens at activation time in the local license file.
 * Encoded as Base32 (RFC 4648, no padding) → grouped as PH-XXXXX-XXXXX-...
 */

import * as crypto from 'crypto';

// ─── HMAC Secret (compiled to bytecode in production — not readable in ASAR) ──
const HMAC_SECRET = Buffer.from(
  'a9f406623045d715a66c6bd92605f881c2f16e3e0e8b1074c79011a4077cc96b' +
  '2beb43ba7b18ff4abb1eb9d0373c8047eacfc494743262b5cc0f977907cd7cdf',
  'hex'
);

const KEY_VERSION = 1;
const PAYLOAD_LEN = 9;   // bytes before HMAC
const HMAC_LEN    = 16;  // truncated HMAC
const TOTAL_LEN   = PAYLOAD_LEN + HMAC_LEN; // 25 bytes
const KEY_PREFIX  = 'PH';

// ─── Base32 (RFC 4648) ──────────────────────────────────────────────────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(str: string): Buffer | null {
  const cleaned = str.replace(/[^A-Z2-7]/gi, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

// ─── HMAC (no machine ID — key is universal) ────────────────────────────────

function computeHmac(payload: Buffer): Buffer {
  return crypto.createHmac('sha256', HMAC_SECRET)
    .update(payload)
    .digest()
    .subarray(0, HMAC_LEN);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface KeyPayload {
  version: number;
  issuedAtMs: number;              // milliseconds since epoch
  activationWindowDays: number;
  licenseDurationDays: number;     // 0 = forever
}

export interface KeyResult {
  valid: boolean;
  payload?: KeyPayload;
  reason?: string;
}

/**
 * Encode a key payload into a human-typeable activation key string.
 * Key is device-independent — works on any machine.
 */
export function encodeKey(
  activationWindowDays: number,
  licenseDurationDays: number
): { key: string; payload: KeyPayload } {
  const issuedAtHours = Math.floor(Date.now() / 3_600_000);

  const buf = Buffer.alloc(TOTAL_LEN);
  buf.writeUInt8(KEY_VERSION, 0);
  buf.writeUInt32BE(issuedAtHours, 1);
  buf.writeUInt16BE(activationWindowDays, 5);
  buf.writeUInt16BE(licenseDurationDays, 7);

  const hmac = computeHmac(buf.subarray(0, PAYLOAD_LEN));
  hmac.copy(buf, PAYLOAD_LEN);

  const b32 = base32Encode(buf);
  const groups: string[] = [];
  for (let i = 0; i < b32.length; i += 5) {
    groups.push(b32.substring(i, i + 5));
  }
  const key = KEY_PREFIX + '-' + groups.join('-');

  return {
    key,
    payload: {
      version: KEY_VERSION,
      issuedAtMs: issuedAtHours * 3_600_000,
      activationWindowDays,
      licenseDurationDays,
    },
  };
}

/**
 * Decode and validate an activation key string.
 * No machine ID needed — key works on any device.
 */
export function decodeKey(keyString: string): KeyResult {
  // Strip prefix and dashes
  let raw = keyString.trim().toUpperCase();
  if (raw.startsWith(KEY_PREFIX + '-')) {
    raw = raw.substring(KEY_PREFIX.length + 1);
  } else if (raw.startsWith(KEY_PREFIX)) {
    raw = raw.substring(KEY_PREFIX.length);
  }
  raw = raw.replace(/-/g, '');

  const buf = base32Decode(raw);
  if (!buf || buf.length < TOTAL_LEN) {
    return { valid: false, reason: 'Invalid key format' };
  }

  // Verify version
  const version = buf.readUInt8(0);
  if (version !== KEY_VERSION) {
    return { valid: false, reason: 'Unsupported key version' };
  }

  // Verify HMAC
  const payloadBuf = buf.subarray(0, PAYLOAD_LEN);
  const expectedHmac = computeHmac(payloadBuf);
  const actualHmac = buf.subarray(PAYLOAD_LEN, PAYLOAD_LEN + HMAC_LEN);
  if (!crypto.timingSafeEqual(expectedHmac, actualHmac)) {
    return { valid: false, reason: 'Invalid activation key' };
  }

  // Decode payload
  const issuedAtHours = buf.readUInt32BE(1);
  const activationWindowDays = buf.readUInt16BE(5);
  const licenseDurationDays = buf.readUInt16BE(7);

  const payload: KeyPayload = {
    version,
    issuedAtMs: issuedAtHours * 3_600_000,
    activationWindowDays,
    licenseDurationDays,
  };

  // Check activation window
  const windowExpiresMs = payload.issuedAtMs + (activationWindowDays * 86_400_000);
  if (Date.now() > windowExpiresMs) {
    return { valid: false, reason: 'Activation key has expired', payload };
  }

  return { valid: true, payload };
}
