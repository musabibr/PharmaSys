/**
 * restore-backup.mjs — restores a PharmaSys backup directly to data/pharmasys.db
 * Usage: node scripts/restore-backup.mjs [backup-file.enc]
 * Make sure the app is NOT running before using this script.
 */
import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const backupFile = process.argv[2] ?? path.join('data', 'backups',
  fs.readdirSync(path.join('data', 'backups'))
    .filter(f => f.endsWith('.enc') && !f.includes('pre_restore') && !f.includes('pre-restore'))
    .sort().at(-1)
);

if (!backupFile || !fs.existsSync(backupFile)) {
  console.error('No backup file found.'); process.exit(1);
}
console.log(`\n📦 Restoring from: ${backupFile}`);

const keyPath = path.join('data', '.backup-key');
if (!fs.existsSync(keyPath)) { console.error('No .backup-key found.'); process.exit(1); }
const key = fs.readFileSync(keyPath);

const buf     = fs.readFileSync(backupFile);
const iv      = buf.slice(0, 16);
const authTag = buf.slice(16, 32);
const data    = buf.slice(32);

let dbBuf;
try {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  dbBuf = Buffer.concat([decipher.update(data), decipher.final()]);
} catch (e) {
  console.error('❌ Decryption failed:', e.message); process.exit(1);
}

// Verify it's a valid SQLite file
if (dbBuf.slice(0, 6).toString() !== 'SQLite') {
  console.error('❌ Decrypted data is not a valid SQLite database.'); process.exit(1);
}

// Quick snapshot with sql.js before writing
const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
const db = new SQL.Database(new Uint8Array(dbBuf));
const counts = {};
for (const t of ['products','batches','transactions','shifts','expenses','suppliers','purchases']) {
  try { counts[t] = db.exec(`SELECT COUNT(*) FROM ${t}`)[0]?.values[0]?.[0]; } catch { counts[t] = 'N/A'; }
}
db.close();

console.log('\nBackup contains:');
for (const [k,v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)} ${v}`);

// Safety snapshot of current db
const livePath = path.join('data', 'pharmasys.db');
if (fs.existsSync(livePath)) {
  const safePath = livePath + '.pre-restore-manual';
  fs.copyFileSync(livePath, safePath);
  console.log(`\n✅ Current DB saved to: ${safePath}`);
}

// Write backup to db atomically
const tmp = livePath + '.restore.tmp';
fs.writeFileSync(tmp, dbBuf);
fs.renameSync(tmp, livePath);

console.log(`✅ Restored successfully → ${livePath}`);
console.log('\n⚠️  Restart the app (npm run dev) to see the restored data.\n');
