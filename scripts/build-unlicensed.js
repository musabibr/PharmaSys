/**
 * Build the UNLICENSED variant of PharmaSys.
 * Output: dist-unlicensed/
 *
 * The license gate is bypassed — the app boots directly without requiring
 * an activation key.
 *
 * How it works:
 *   After `tsc` compiles main.ts → dist-ts/platform/electron/main.js,
 *   this script patches a single line in that compiled file to set
 *   `skipLicense = true`. The patch lives only in the compiled artifact;
 *   the source TypeScript is never modified. The next `npm run compile`
 *   will overwrite the compiled file and restore the licensed version.
 *
 * Usage:
 *   npm run build:unlicensed
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT   = path.resolve(__dirname, '..');
const MAIN_JS = path.join(ROOT, 'dist-ts/platform/electron/main.js');

// The exact string produced by tsc from:
//   const skipLicense = process.argv.includes('--dev');
const LICENSED_LINE   = "const skipLicense = process.argv.includes('--dev');";
const UNLICENSED_LINE = "const skipLicense = true; // unlicensed build";

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

// ── 1. Build React frontend ───────────────────────────────────────────────
console.log('[build:unlicensed] Building React frontend...');
run('npx vite build');

// ── 2. Compile TypeScript ─────────────────────────────────────────────────
console.log('[build:unlicensed] Compiling TypeScript...');
run('npm run compile');

// ── 3. Patch compiled main.js — bypass license gate ───────────────────────
if (!fs.existsSync(MAIN_JS)) {
  console.error(`[build:unlicensed] ERROR: Compiled main.js not found at:\n  ${MAIN_JS}`);
  process.exit(1);
}

let src = fs.readFileSync(MAIN_JS, 'utf-8');

if (!src.includes(LICENSED_LINE)) {
  console.error('[build:unlicensed] ERROR: Could not find the license gate line in compiled main.js.');
  console.error('  Expected: ' + LICENSED_LINE);
  console.error('  The TypeScript source may have changed. Update LICENSED_LINE in this script.');
  process.exit(1);
}

src = src.replace(LICENSED_LINE, UNLICENSED_LINE);
fs.writeFileSync(MAIN_JS, src, 'utf-8');
console.log('[build:unlicensed] License gate patched in dist-ts/platform/electron/main.js');

// ── 4. Package ────────────────────────────────────────────────────────────
console.log('[build:unlicensed] Packaging with electron-builder → dist-unlicensed/...');
run('npx electron-builder --win --config.directories.output=dist-unlicensed');

console.log('[build:unlicensed] ✓ Done — output: dist-unlicensed/');
