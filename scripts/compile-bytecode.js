#!/usr/bin/env node
/**
 * Post-build: Compile dist-ts/**\/*.js to V8 bytecode (.jsc) using bytenode.
 *
 * CRITICAL: Must run under Electron's Node (not system Node) because V8 bytecode
 * is version-specific. System Node v24 produces bytecode incompatible with
 * Electron's Node 18. We spawn `electron` to run the actual compilation.
 *
 * Run after `tsc` and before `electron-builder`.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const electronPath = require('electron');

const workerScript = path.join(__dirname, 'compile-bytecode-worker.js');

console.log('[compile-bytecode] Compiling dist-ts/ to V8 bytecode via Electron runtime...');

try {
  const output = execFileSync(electronPath, [workerScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120000,
    encoding: 'utf-8',
  });
  process.stdout.write(output);
} catch (err) {
  // execFileSync throws if exit code != 0, but output is in err.stdout
  if (err.stdout) process.stdout.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(1);
}
