#!/usr/bin/env node
// Helper to launch Electron without ELECTRON_RUN_AS_NODE
// VSCode terminals set ELECTRON_RUN_AS_NODE=1 which breaks Electron
delete process.env.ELECTRON_RUN_AS_NODE;
const { execFileSync } = require('child_process');
const electronPath = require('electron');
const args = process.argv.slice(2);
try {
  execFileSync(electronPath, args, { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
