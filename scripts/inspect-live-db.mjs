/**
 * inspect-live-db.mjs — shows summary of the live pharmasys.db
 */
import * as fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const dbPath = 'data/pharmasys.db';
if (!fs.existsSync(dbPath)) { console.error('No DB found at', dbPath); process.exit(1); }

const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
const db  = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));

function q(sql, p = []) {
  const stmt = db.prepare(sql);
  if (p.length) stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function cnt(t) { return db.exec(`SELECT COUNT(*) FROM ${t}`)[0]?.values[0]?.[0] ?? 0; }

console.log('\n=== LIVE DATABASE SUMMARY ===\n');
for (const t of ['users','categories','products','batches','transactions','shifts','expenses','suppliers','purchases']) {
  try { console.log(`  ${t.padEnd(20)} ${cnt(t)} rows`); } catch { /* skip */ }
}

console.log('\n=== USERS ===');
for (const u of q('SELECT id, username, full_name, role FROM users'))
  console.log(`  [${u.id}] ${u.username} (${u.role}) — ${u.full_name}`);

console.log('\n=== CATEGORIES ===');
for (const c of q('SELECT id, name FROM categories ORDER BY id'))
  console.log(`  [${c.id}] ${c.name}`);

// Check if demo products present (seeded demo products have specific names)
const demoCheck = q("SELECT COUNT(*) as n FROM products WHERE name IN ('Amoxicillin 500mg','Paracetamol 500mg','Ibuprofen 400mg')")[0];
console.log(`\n  Demo products present: ${demoCheck.n > 0 ? 'YES ('+demoCheck.n+')' : 'NO'}`);

console.log('\n=== PRODUCTS (first 20) ===');
for (const p of q('SELECT id, name, parent_unit, child_unit, conversion_factor FROM products ORDER BY id LIMIT 20'))
  console.log(`  [${p.id}] ${p.name} — ${p.child_unit ? p.parent_unit+'/'+p.child_unit+'(x'+p.conversion_factor+')' : p.parent_unit}`);

const totalProducts = cnt('products');
console.log(`  ... total: ${totalProducts} products`);

db.close();
