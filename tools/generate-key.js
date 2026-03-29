#!/usr/bin/env node
/**
 * PharmaSys Activation Key Generator
 *
 * Generates device-independent keys. The key works on ANY device.
 * Machine binding happens at activation time (local license is salted with device ID).
 *
 * Usage:
 *   node tools/generate-key.js -w 7 -d 365
 *   node tools/generate-key.js -w 1825 -d 0    # 5-year window, forever license
 */

const crypto = require('crypto');

// ─── HMAC Secret (must match src/license/activation-key.ts) ──────────────────
const HMAC_SECRET = Buffer.from(
  'a9f406623045d715a66c6bd92605f881c2f16e3e0e8b1074c79011a4077cc96b' +
  '2beb43ba7b18ff4abb1eb9d0373c8047eacfc494743262b5cc0f977907cd7cdf',
  'hex'
);

const KEY_VERSION = 1;
const PAYLOAD_LEN = 9;
const HMAC_LEN = 16;
const TOTAL_LEN = PAYLOAD_LEN + HMAC_LEN;
const KEY_PREFIX = 'PH';
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
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

function generateKey(windowDays, durationDays) {
  const issuedAtHours = Math.floor(Date.now() / 3_600_000);

  const buf = Buffer.alloc(TOTAL_LEN);
  buf.writeUInt8(KEY_VERSION, 0);
  buf.writeUInt32BE(issuedAtHours, 1);
  buf.writeUInt16BE(windowDays, 5);
  buf.writeUInt16BE(durationDays, 7);

  // HMAC — no machine ID, key works on any device
  const hmac = crypto.createHmac('sha256', HMAC_SECRET)
    .update(buf.subarray(0, PAYLOAD_LEN))
    .digest()
    .subarray(0, HMAC_LEN);
  hmac.copy(buf, PAYLOAD_LEN);

  const b32 = base32Encode(buf);
  const groups = [];
  for (let i = 0; i < b32.length; i += 5) {
    groups.push(b32.substring(i, i + 5));
  }
  return KEY_PREFIX + '-' + groups.join('-');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(short, long, fallback) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      return args[i + 1];
    }
  }
  return fallback;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
PharmaSys Activation Key Generator

Keys are device-independent — one key works on any device.
Machine binding happens at activation time (local license).

Usage:
  node tools/generate-key.js [options]

Options:
  -w, --window <days>     Activation window in days (default: 7)
  -d, --duration <days>   License duration in days, 0=forever (default: 0)
  -n, --count <num>       Number of keys to generate (default: 1)
  -h, --help              Show this help

Examples:
  node tools/generate-key.js -w 7 -d 365      # 7-day window, 1-year license
  node tools/generate-key.js -w 1825 -d 0      # 5-year window, forever
  node tools/generate-key.js -w 30 -d 180 -n 5 # 5 keys, 30-day window, 6-month
`);
  process.exit(0);
}

const windowDays = parseInt(getArg('-w', '--window', '7'), 10);
const durationDays = parseInt(getArg('-d', '--duration', '0'), 10);
const count = parseInt(getArg('-n', '--count', '1'), 10);

if (windowDays < 1 || windowDays > 65535) {
  console.error('Error: Activation window must be between 1 and 65535 days');
  process.exit(1);
}
if (durationDays < 0 || durationDays > 65535) {
  console.error('Error: Duration must be between 0 (forever) and 65535 days');
  process.exit(1);
}

const windowExpiry = new Date(Date.now() + windowDays * 86_400_000);
const durationLabel = durationDays === 0 ? 'FOREVER' : `${durationDays} days`;

console.log(`\n  Activation Window: ${windowDays} day(s) (key expires: ${windowExpiry.toISOString().split('T')[0]})`);
console.log(`  License Duration:  ${durationLabel}`);
console.log(`  Keys to generate:  ${count}\n`);
console.log('─'.repeat(60));

for (let i = 0; i < count; i++) {
  const key = generateKey(windowDays, durationDays);
  console.log(`\n  ${key}`);
}

console.log('\n' + '─'.repeat(60));
console.log(`  Generated ${count} key(s) at ${new Date().toLocaleString()}\n`);
