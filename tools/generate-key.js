#!/usr/bin/env node
/**
 * PharmaSys Activation Key Generator
 *
 * Usage:
 *   node tools/generate-key.js -m <machineId> --window <days> --duration <days>
 *   node tools/generate-key.js -m A3F2B7C1-D4E5F6A7 -w 7 -d 365
 *   node tools/generate-key.js -m A3F2B7C1-D4E5F6A7 -w 1 -d 0   # forever
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

function generateKey(machineId, windowDays, durationDays) {
  const issuedAtHours = Math.floor(Date.now() / 3_600_000);

  const buf = Buffer.alloc(TOTAL_LEN);
  buf.writeUInt8(KEY_VERSION, 0);
  buf.writeUInt32BE(issuedAtHours, 1);
  buf.writeUInt16BE(windowDays, 5);
  buf.writeUInt16BE(durationDays, 7);

  // HMAC salted with machine ID — key only works on this device
  const hmac = crypto.createHmac('sha256', HMAC_SECRET)
    .update(buf.subarray(0, PAYLOAD_LEN))
    .update(machineId.toUpperCase())
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

Usage:
  node tools/generate-key.js -m <machineId> [options]

Required:
  -m, --machine <id>      Device ID shown on activation screen (e.g., A3F2B7C1-D4E5F6A7)

Options:
  -w, --window <days>     Activation window in days (default: 7)
  -d, --duration <days>   License duration in days, 0=forever (default: 0)
  -n, --count <num>       Number of keys to generate (default: 1)
  -h, --help              Show this help

Examples:
  node tools/generate-key.js -m A3F2B7C1-D4E5F6A7 -w 7 -d 365
  node tools/generate-key.js -m A3F2B7C1-D4E5F6A7 -w 1 -d 0
  node tools/generate-key.js -m A3F2B7C1-D4E5F6A7 -w 30 -d 180 -n 3
`);
  process.exit(0);
}

const machineId = getArg('-m', '--machine', null);
if (!machineId) {
  console.error('Error: Machine ID is required. Use -m <id> (shown on the device activation screen)');
  console.error('Example: node tools/generate-key.js -m A3F2B7C1-D4E5F6A7 -w 7 -d 365');
  process.exit(1);
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

console.log(`\n  Device ID:         ${machineId.toUpperCase()}`);
console.log(`  Activation Window: ${windowDays} day(s) (key expires: ${windowExpiry.toISOString().split('T')[0]})`);
console.log(`  License Duration:  ${durationLabel}`);
console.log(`  Keys to generate:  ${count}\n`);
console.log('─'.repeat(60));

for (let i = 0; i < count; i++) {
  const key = generateKey(machineId, windowDays, durationDays);
  console.log(`\n  ${key}`);
}

console.log('\n' + '─'.repeat(60));
console.log(`  Generated ${count} key(s) at ${new Date().toLocaleString()}\n`);
