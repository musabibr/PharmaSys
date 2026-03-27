/**
 * Bytecode compilation worker — runs inside Electron's Node runtime
 * (via ELECTRON_RUN_AS_NODE=1) so the V8 bytecode matches Electron's V8 version.
 */

const fs = require('fs');
const path = require('path');
const bytenode = require('bytenode');

const DIST_DIR = path.resolve(__dirname, '..', 'dist-ts');

// Files that MUST remain as plain JS
const SKIP_PATTERNS = [
  'preload.js',
  'preload-rest.js',
  'license-preload.js',
  'save-worker.js',
];

function shouldSkip(filePath) {
  const basename = path.basename(filePath);
  return SKIP_PATTERNS.some(p => basename === p);
}

let compiled = 0;
let skipped = 0;

function walkAndCompile(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkAndCompile(fullPath);
      continue;
    }

    if (!entry.name.endsWith('.js')) continue;

    if (shouldSkip(fullPath)) {
      skipped++;
      continue;
    }

    try {
      const jscPath = fullPath.replace(/\.js$/, '.jsc');
      bytenode.compileFile({ filename: fullPath, output: jscPath });

      const relativePath = './' + path.basename(jscPath);
      const loader = `'use strict';require('bytenode');require('${relativePath}');\n`;
      fs.writeFileSync(fullPath, loader);

      compiled++;
    } catch (err) {
      console.error(`  [WARN] Failed to compile ${path.relative(DIST_DIR, fullPath)}: ${err.message}`);
    }
  }
}

console.log(`[compile-bytecode-worker] Node: ${process.versions.node}, V8: ${process.versions.v8}`);
walkAndCompile(DIST_DIR);
console.log(`[compile-bytecode-worker] Done: ${compiled} compiled, ${skipped} skipped`);
