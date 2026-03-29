/**
 * Build the LICENSED variant of PharmaSys.
 * Output: dist-licensed/
 *
 * The license gate is fully active — users must enter an activation key
 * before the app will start.
 *
 * Usage:
 *   npm run build:licensed
 */

const { execSync } = require('child_process');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: require('path').resolve(__dirname, '..') });
}

console.log('[build:licensed] Building React frontend...');
run('npx vite build');

console.log('[build:licensed] Compiling TypeScript...');
run('npm run compile');

console.log('[build:licensed] Packaging with electron-builder → dist-licensed/...');
run('npx electron-builder --win --config.directories.output=dist-licensed');

console.log('[build:licensed] ✓ Done — output: dist-licensed/');
