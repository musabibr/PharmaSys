/**
 * Generates a minimal valid build/icon.ico for PharmaSys.
 * 32×32 px, 32-bit BGRA — pharmacy green cross on dark background.
 * Run: node scripts/create-icon.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const W = 256, H = 256, BPP = 32;

// ── Pixel data (BGRA, stored bottom-up per BMP convention) ──────────────────
const pixelData = Buffer.alloc(W * H * 4, 0);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        // Bottom-up row index
        const row = H - 1 - y;
        const i   = (row * W + x) * 4;

        // Dark pharmacy background: #0D1F14 → R13 G31 B20
        let r = 13, g = 31, b = 20;

        // White-ish green cross — 4 px arms centred
        const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
        const arm = Math.max(10, Math.floor(W / 10)); // cross arm half-width
        const inHoriz = (y >= cy - arm && y <= cy + arm - 1);
        const inVert  = (x >= cx - arm && x <= cx + arm - 1);
        if (inHoriz || inVert) { r = 180; g = 240; b = 200; }

        // Rounded-corner mask: zero alpha on corners
        const cr = Math.floor(W / 12);
        const corner = (x < cr || x >= W - cr) && (y < cr || y >= H - cr);
        const alpha  = corner ? 0 : 255;

        pixelData[i]     = b;
        pixelData[i + 1] = g;
        pixelData[i + 2] = r;
        pixelData[i + 3] = alpha;
    }
}

// ── AND mask (1 bpp, fully transparent where alpha=0) ───────────────────────
// Row width for 32 pixels: 32 bits = 4 bytes (already DWORD-aligned)
const andRowBytes = Math.ceil(W / 32) * 4;           // = 4
const andMask = Buffer.alloc(andRowBytes * H, 0);    // all-zero = opaque

// ── BITMAPINFOHEADER (40 bytes) ──────────────────────────────────────────────
const dibSize  = 40;
const pixBytes = pixelData.length;
const imgSize  = dibSize + pixBytes + andMask.length;

const dib = Buffer.alloc(dibSize, 0);
dib.writeUInt32LE(dibSize,     0);  // biSize
dib.writeInt32LE(W,            4);  // biWidth
dib.writeInt32LE(H * 2,        8);  // biHeight (×2 = ICO convention)
dib.writeUInt16LE(1,          12);  // biPlanes
dib.writeUInt16LE(BPP,        14);  // biBitCount
dib.writeUInt32LE(0,          16);  // biCompression (BI_RGB)
dib.writeUInt32LE(pixBytes,   20);  // biSizeImage

// ── ICO header (6 bytes) + directory entry (16 bytes) ───────────────────────
const hdr = Buffer.from([0,0, 1,0, 1,0]);  // reserved, type=ICO, count=1

const dir = Buffer.alloc(16, 0);
dir.writeUInt8(W >= 256 ? 0 : W, 0);   // width  (0 means 256)
dir.writeUInt8(H >= 256 ? 0 : H, 1);   // height (0 means 256)
dir.writeUInt8(0,          2);   // color count (0 = 24+bpp)
dir.writeUInt8(0,          3);   // reserved
dir.writeUInt16LE(1,       4);   // planes
dir.writeUInt16LE(BPP,     6);   // bit count
dir.writeUInt32LE(imgSize, 8);   // bytes in resource
dir.writeUInt32LE(6 + 16, 12);   // offset from file start

const ico = Buffer.concat([hdr, dir, dib, pixelData, andMask]);

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const outPath = path.join(buildDir, 'icon.ico');
fs.writeFileSync(outPath, ico);
console.log(`✓ Created ${outPath}  (${ico.length} bytes)`);
