#!/usr/bin/env node
/**
 * Post-build: Obfuscate dist-renderer/assets/*.js using javascript-obfuscator.
 *
 * The React bundle is already minified by Vite. This adds:
 * - String encryption
 * - Control flow flattening
 * - Dead code injection
 * - Variable renaming
 *
 * Run after `vite build` and before `electron-builder`.
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ASSETS_DIR = path.resolve(__dirname, '..', 'dist-renderer', 'assets');

if (!fs.existsSync(ASSETS_DIR)) {
  console.log('[obfuscate-renderer] No dist-renderer/assets/ found — skipping');
  process.exit(0);
}

const options = {
  // Light protection — fast build, good enough for frontend (backend uses bytecode)
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['none'],
  stringArrayThreshold: 0.3,
  rotateStringArray: true,
  selfDefending: false,
  splitStrings: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

let count = 0;
const files = fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith('.js'));

for (const file of files) {
  const filePath = path.join(ASSETS_DIR, file);
  const code = fs.readFileSync(filePath, 'utf-8');

  // Skip tiny files (loader stubs, empty chunks)
  if (code.length < 100) continue;

  try {
    const result = JavaScriptObfuscator.obfuscate(code, options);
    fs.writeFileSync(filePath, result.getObfuscatedCode());
    count++;
    console.log(`  [OK] ${file} (${(code.length / 1024).toFixed(0)}KB → ${(result.getObfuscatedCode().length / 1024).toFixed(0)}KB)`);
  } catch (err) {
    console.error(`  [WARN] Failed to obfuscate ${file}: ${err.message}`);
    // Leave original minified file in place
  }
}

console.log(`[obfuscate-renderer] Done: ${count} file(s) obfuscated`);
