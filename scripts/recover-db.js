/**
 * PharmaSys Database Recovery Script
 *
 * Attempts to repair a corrupted pharmasys.db by reconstructing its
 * 100-byte SQLite header. This works when the data pages are intact
 * but the header got zeroed/garbled on an unclean shutdown or power loss.
 *
 * Why it works:
 *   sql.js rejects the file at "file is not a database" before reading
 *   any data pages. If the file size is a clean multiple of the SQLite
 *   page size (4096 bytes), the pages are almost certainly fine — only
 *   the header needs rebuilding.
 *
 * Usage (from project root):
 *   node scripts/recover-db.js <corrupt-file> [output-file]
 *
 * Example:
 *   node scripts/recover-db.js pharmasys.db pharmasys-recovered.db
 *
 * After running:
 *   - If ✓ SUCCESS: copy pharmasys-recovered.db to the customer's
 *     AppData\Roaming\pharmasys\data\ folder as pharmasys.db
 *   - If ✗ FAILED: use SQLite CLI recovery (see bottom of this file)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const inputPath  = process.argv[2];
const outputPath = process.argv[3] || (inputPath ? inputPath.replace(/\.db$/i, '-recovered.db') : null);

if (!inputPath) {
  console.error('Usage: node scripts/recover-db.js <corrupt-file> [output-file]');
  console.error('Example: node scripts/recover-db.js pharmasys.db pharmasys-recovered.db');
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`[Recovery] ERROR: File not found: ${path.resolve(inputPath)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read & inspect
// ---------------------------------------------------------------------------

const raw = fs.readFileSync(inputPath);
console.log(`[Recovery] Input file : ${path.resolve(inputPath)}`);
console.log(`[Recovery] File size  : ${raw.length.toLocaleString()} bytes`);

const SQLITE_MAGIC = Buffer.from('SQLite format 3\x00');

if (raw.length < 100) {
  console.error('[Recovery] ERROR: File is smaller than a SQLite header (100 bytes). Cannot recover.');
  process.exit(1);
}

if (raw.subarray(0, 16).equals(SQLITE_MAGIC)) {
  console.log('[Recovery] File already has a valid SQLite magic header.');
  console.log('[Recovery] The corruption is in the data pages, not the header.');
  console.log('[Recovery] Use the SQLite CLI .recover command instead (see below).');
  printCliInstructions();
  process.exit(0);
}

// Check for valid page sizes (SQLite spec: 512 to 65536, powers of 2)
const VALID_PAGE_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
let pageSize = null;
for (const ps of VALID_PAGE_SIZES) {
  if (raw.length % ps === 0) {
    // Pick the LARGEST page size that divides the file — more likely to be correct
    pageSize = ps;
  }
}

if (!pageSize) {
  console.error(`[Recovery] ERROR: File size ${raw.length} is not divisible by any standard SQLite page size.`);
  console.error('[Recovery] The file may be truncated, encrypted, or not SQLite at all.');
  process.exit(1);
}

const pageCount = raw.length / pageSize;
console.log(`[Recovery] Detected page size : ${pageSize} bytes`);
console.log(`[Recovery] Page count         : ${pageCount}`);
console.log(`[Recovery] Rebuilding header...`);

// ---------------------------------------------------------------------------
// Reconstruct the 100-byte SQLite header
// SQLite File Format: https://www.sqlite.org/fileformat.html
// ---------------------------------------------------------------------------

const repaired = Buffer.from(raw); // work on a copy

// Bytes 0–15: Magic string
SQLITE_MAGIC.copy(repaired, 0);

// Bytes 16–17: Page size. SQLite stores 65536 as the value 1 (uint16 overflow trick).
repaired.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);

// Byte 18: File format write version (1 = rollback journal, 2 = WAL)
repaired[18] = 1;

// Byte 19: File format read version
repaired[19] = 1;

// Byte 20: Bytes reserved at end of each page (almost always 0)
repaired[20] = 0;

// Byte 21–23: Payload fraction constants (these are fixed per spec)
repaired[21] = 64; // max embedded payload fraction
repaired[22] = 32; // min embedded payload fraction
repaired[23] = 32; // leaf payload fraction

// Bytes 24–27: File change counter (any non-zero value is fine for recovery)
repaired.writeUInt32BE(1, 24);

// Bytes 28–31: Size of database in pages
repaired.writeUInt32BE(pageCount, 28);

// Bytes 32–35: Page number of first freelist trunk (0 = no freelist)
repaired.writeUInt32BE(0, 32);

// Bytes 36–39: Total number of freelist pages
repaired.writeUInt32BE(0, 36);

// Bytes 40–43: Schema cookie (1 = valid schema exists)
repaired.writeUInt32BE(1, 40);

// Bytes 44–47: Schema format number (4 = most common, supports all modern SQLite features)
repaired.writeUInt32BE(4, 44);

// Bytes 48–51: Default page cache size (0 = use SQLite default)
repaired.writeUInt32BE(0, 48);

// Bytes 52–55: Page number of largest root b-tree page (0 = non-auto-vacuum)
repaired.writeUInt32BE(0, 52);

// Bytes 56–59: Text encoding (1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be)
repaired.writeUInt32BE(1, 56);

// Bytes 60–63: User version
repaired.writeUInt32BE(0, 60);

// Bytes 64–67: Incremental vacuum mode (0 = off)
repaired.writeUInt32BE(0, 64);

// Bytes 68–71: Application ID
repaired.writeUInt32BE(0, 68);

// Bytes 72–91: Reserved for future use (must be zero)
repaired.fill(0, 72, 92);

// Bytes 92–95: Version-valid-for number (must match bytes 24–27 for header to be trusted)
repaired.writeUInt32BE(1, 92);

// Bytes 96–99: SQLite library version number that last wrote the file
//   Using 3040001 = SQLite 3.40.1 (a widely deployed version; exact value doesn't matter for recovery)
repaired.writeUInt32BE(3040001, 96);

// ---------------------------------------------------------------------------
// Save repaired file
// ---------------------------------------------------------------------------

fs.writeFileSync(outputPath, repaired);
console.log(`[Recovery] Repaired file saved: ${path.resolve(outputPath)}`);
console.log('[Recovery] Verifying with sql.js...');

// ---------------------------------------------------------------------------
// Verify with sql.js
// ---------------------------------------------------------------------------

const sqlJsPath = path.join(__dirname, '../node_modules/sql.js/dist/sql-wasm.js');
const wasmPath  = path.join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');

if (!fs.existsSync(sqlJsPath)) {
  console.log('[Recovery] sql.js not found — run this script from the project root.');
  console.log(`[Recovery] Saved to: ${outputPath}`);
  process.exit(0);
}

const initSqlJs = require(sqlJsPath);
initSqlJs({ locateFile: () => wasmPath })
  .then((SQL) => {
    try {
      const db = new SQL.Database(repaired);

      // List tables
      const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const tables = tablesResult[0]?.values?.map(r => r[0]) ?? [];
      console.log(`[Recovery] Tables found (${tables.length}): ${tables.join(', ')}`);

      // Show key row counts
      const keyCounts = ['users', 'transactions', 'products', 'expenses', 'shifts'];
      for (const tbl of keyCounts) {
        if (tables.includes(tbl)) {
          try {
            const cnt = db.exec(`SELECT COUNT(*) FROM ${tbl}`);
            console.log(`[Recovery]   ${tbl}: ${cnt[0]?.values[0]?.[0] ?? 0} rows`);
          } catch { /* ignore */ }
        }
      }

      db.close();

      console.log('');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║  ✓  RECOVERY SUCCESSFUL                                      ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('');
      console.log('Next steps:');
      console.log(`  1. Send "${path.basename(outputPath)}" to the customer`);
      console.log('  2. On their machine, navigate to:');
      console.log('       C:\\Users\\HP\\AppData\\Roaming\\pharmasys\\data\\');
      console.log('  3. Rename existing pharmasys.db → pharmasys.db.old  (keep as backup)');
      console.log(`  4. Copy the recovered file there and rename it to pharmasys.db`);
      console.log('  5. Launch PharmaSys — data should be restored');

    } catch (verifyErr) {
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║  ✗  Header repair did not fix the file                       ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
      console.error('Error:', verifyErr.message);
      console.error('');
      console.error('The data pages themselves may be corrupt (not just the header).');
      printCliInstructions();
    }
  })
  .catch((e) => {
    console.error('[Recovery] Failed to load sql.js:', e.message);
  });

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function printCliInstructions() {
  console.log('');
  console.log('──────────────────────────────────────────────────────────────────');
  console.log('Alternative: SQLite CLI deep recovery');
  console.log('──────────────────────────────────────────────────────────────────');
  console.log('1. Download sqlite3.exe for Windows from https://www.sqlite.org/download.html');
  console.log('   (look for "sqlite-tools-win-x64" under "Precompiled Binaries for Windows")');
  console.log('');
  console.log('2. Open Command Prompt in the folder containing pharmasys.db and run:');
  console.log('');
  console.log('   sqlite3 pharmasys.db ".recover" | sqlite3 pharmasys-recovered.db');
  console.log('');
  console.log('3. If that works, use pharmasys-recovered.db as the new database.');
  console.log('──────────────────────────────────────────────────────────────────');
}
