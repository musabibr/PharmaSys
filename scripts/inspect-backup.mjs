/**
 * inspect-backup.mjs
 * Decrypts a PharmaSys .enc backup and shows a summary of its contents.
 * Usage: node scripts/inspect-backup.mjs [backup-file.enc]
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
  console.error('No backup file found or specified.');
  process.exit(1);
}

console.log(`\n📦 Inspecting: ${backupFile}\n`);

// ── Load encryption key ─────────────────────────────────────────────────────
const keyPath = path.join('data', '.backup-key');
if (!fs.existsSync(keyPath)) {
  console.error('No .backup-key found in data/. Cannot decrypt.');
  process.exit(1);
}
const key = fs.readFileSync(keyPath);

// ── Decrypt ─────────────────────────────────────────────────────────────────
const buf     = fs.readFileSync(backupFile);
const iv      = buf.slice(0, 16);
const authTag = buf.slice(16, 32);
const data    = buf.slice(32);

let dbBuf;
try {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  dbBuf = Buffer.concat([decipher.update(data), decipher.final()]);
  console.log(`✅ Decryption successful. DB size: ${(dbBuf.length / 1024).toFixed(1)} KB\n`);
} catch (e) {
  console.error('❌ Decryption failed:', e.message);
  process.exit(1);
}

// ── Load with sql.js ─────────────────────────────────────────────────────────
const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
const db  = new SQL.Database(new Uint8Array(dbBuf));

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function count(table) {
  return db.exec(`SELECT COUNT(*) as n FROM ${table}`)[0]?.values[0]?.[0] ?? 0;
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('=== DATABASE SUMMARY ===\n');

const tables = ['users','categories','products','batches','transactions',
                'transaction_items','shifts','expenses','suppliers','purchases','audit_log'];
for (const t of tables) {
  try { console.log(`  ${t.padEnd(20)} ${count(t)} rows`); } catch { /* table may not exist */ }
}

// ── Users ────────────────────────────────────────────────────────────────────
console.log('\n=== USERS ===');
const users = query('SELECT id, username, full_name, role, is_active FROM users');
for (const u of users) {
  console.log(`  [${u.id}] ${u.username} (${u.role}) — ${u.full_name} — active:${u.is_active}`);
}

// ── Products ─────────────────────────────────────────────────────────────────
console.log('\n=== PRODUCTS (first 30) ===');
const products = query(`
  SELECT p.id, p.name, p.parent_unit, p.child_unit, p.conversion_factor,
         COALESCE(SUM(b.quantity_base), 0) as total_base,
         c.name as category
  FROM products p
  LEFT JOIN batches b ON b.product_id = p.id AND b.quantity_base > 0 AND b.status = 'active'
  LEFT JOIN categories c ON c.id = p.category_id
  GROUP BY p.id ORDER BY p.id LIMIT 30
`);
for (const p of products) {
  const unit = p.child_unit ? `${p.parent_unit}/${p.child_unit}(x${p.conversion_factor})` : p.parent_unit;
  console.log(`  [${p.id}] ${p.name} — ${unit} — stock:${p.total_base} base units — cat:${p.category ?? 'none'}`);
}

// ── Batches ───────────────────────────────────────────────────────────────────
console.log('\n=== BATCHES (first 20) ===');
const batches = query(`
  SELECT b.id, p.name as product, b.batch_number, b.expiry_date,
         b.quantity_base, b.cost_per_parent, b.cost_per_child, b.cost_per_child_override,
         b.selling_price_parent, p.conversion_factor, b.status
  FROM batches b
  JOIN products p ON p.id = b.product_id
  WHERE b.quantity_base > 0
  ORDER BY b.id LIMIT 20
`);
for (const b of batches) {
  const cf = b.conversion_factor || 1;
  const qtyParent = (b.quantity_base / cf).toFixed(1);
  console.log(`  [${b.id}] ${b.product} | batch:${b.batch_number ?? 'N/A'} | exp:${b.expiry_date} | qty_base:${b.quantity_base}(≈${qtyParent} parent) | cost_parent:${b.cost_per_parent} | cost_child:${b.cost_per_child_override ?? b.cost_per_child} | sell:${b.selling_price_parent} | ${b.status}`);
}

// ── Inventory Valuation Check ─────────────────────────────────────────────────
console.log('\n=== INVENTORY VALUATION CHECK ===');
const valuation = query(`
  SELECT
    p.name,
    p.conversion_factor as cf,
    COALESCE(SUM(b.quantity_base), 0) as total_base,
    COALESCE(SUM(b.quantity_base * COALESCE(
      NULLIF(b.cost_per_child_override, 0),
      b.cost_per_child,
      CASE WHEN p.conversion_factor > 0 THEN CAST(b.cost_per_parent / p.conversion_factor AS INTEGER)
           ELSE b.cost_per_parent END
    )), 0) as cost_value,
    COALESCE(SUM(b.quantity_base * COALESCE(
      NULLIF(b.selling_price_child_override, 0),
      b.selling_price_child,
      CASE WHEN p.conversion_factor > 0 THEN CAST(b.selling_price_parent / p.conversion_factor AS INTEGER)
           ELSE b.selling_price_parent END
    )), 0) as retail_value
  FROM products p
  LEFT JOIN batches b ON b.product_id = p.id AND b.quantity_base > 0 AND b.status = 'active'
  GROUP BY p.id
  HAVING total_base > 0
  ORDER BY cost_value DESC
  LIMIT 20
`);
let totalCost = 0, totalRetail = 0;
for (const v of valuation) {
  totalCost   += v.cost_value;
  totalRetail += v.retail_value;
  const margin = v.retail_value > 0 ? (((v.retail_value - v.cost_value) / v.retail_value) * 100).toFixed(1) : '0';
  console.log(`  ${v.name.substring(0,35).padEnd(35)} base:${String(v.total_base).padStart(6)} cost:${String(v.cost_value).padStart(8)} retail:${String(v.retail_value).padStart(8)} margin:${margin}%`);
}
console.log(`\n  TOTAL COST VALUE:   ${totalCost}`);
console.log(`  TOTAL RETAIL VALUE: ${totalRetail}`);
console.log(`  GROSS MARGIN:       ${totalRetail > 0 ? (((totalRetail-totalCost)/totalRetail)*100).toFixed(1) : 0}%`);

// ── Recent Transactions ────────────────────────────────────────────────────────
console.log('\n=== RECENT TRANSACTIONS (last 10) ===');
const txns = query(`
  SELECT t.id, t.transaction_type, t.total_amount, t.created_at, u.username
  FROM transactions t LEFT JOIN users u ON u.id = t.user_id
  ORDER BY t.id DESC LIMIT 10
`);
for (const t of txns) {
  console.log(`  [${t.id}] ${t.transaction_type} — ${t.total_amount} SDG — ${t.created_at?.slice(0,19)} — by:${t.username ?? 'N/A'}`);
}

// ── Settings ────────────────────────────────────────────────────────────────
console.log('\n=== KEY SETTINGS ===');
const settings = query("SELECT key, value FROM settings WHERE key IN ('pharmacy_name','default_markup_percent','currency_symbol','language')");
for (const s of settings) {
  console.log(`  ${s.key}: ${s.value}`);
}

db.close();
console.log('\n✅ Inspection complete.');
