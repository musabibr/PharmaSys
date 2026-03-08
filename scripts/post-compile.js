/**
 * Post-compile script: copies non-TypeScript assets to dist-ts/
 * that tsc does not handle (plain JS files, HTML files, etc.).
 */
const fs = require('fs');
const path = require('path');

const copies = [
  // License activation preload (plain JS, loaded via __dirname in main.ts)
  {
    from: 'src/platform/electron/license-preload.js',
    to: 'dist-ts/platform/electron/license-preload.js',
  },
  // License activation HTML screen
  {
    from: 'src/platform/electron/license-screen',
    to: 'dist-ts/platform/electron/license-screen',
    dir: true,
  },
];

// Write a unique build ID so the app can detect new installs (portable exe)
const buildId = Date.now().toString();
const buildIdPath = path.resolve('dist-ts/build-id');
fs.writeFileSync(buildIdPath, buildId, 'utf-8');
console.log(`[post-compile] Generated build-id: ${buildId}`);

for (const entry of copies) {
  const src = path.resolve(entry.from);
  const dst = path.resolve(entry.to);

  if (!fs.existsSync(src)) {
    console.warn(`[post-compile] WARNING: source not found: ${src}`);
    continue;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });

  if (entry.dir) {
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.copyFileSync(src, dst);
  }

  console.log(`[post-compile] ${entry.from} -> ${entry.to}`);
}
