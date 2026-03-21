import * as fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
const db = new SQL.Database(new Uint8Array(fs.readFileSync('data/pharmasys.db')));

function q(sql, p = []) {
  const stmt = db.prepare(sql);
  if (p.length) stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Date range of transactions
const range = q('SELECT MIN(created_at) as first, MAX(created_at) as last, COUNT(*) as n FROM transactions')[0];
console.log(`Transactions: ${range.n} total`);
console.log(`  First: ${range.first}`);
console.log(`  Last:  ${range.last}`);

// Shifts date range
const srange = q('SELECT MIN(opened_at) as first, MAX(opened_at) as last, COUNT(*) as n FROM shifts')[0];
console.log(`Shifts: ${srange.n} total`);
console.log(`  First: ${srange.first}`);
console.log(`  Last:  ${srange.last}`);

// Most recent 10 transactions
console.log('\nMost recent 10 transactions:');
for (const t of q('SELECT id, transaction_type, total_amount, created_at FROM transactions ORDER BY id DESC LIMIT 10'))
  console.log(`  [${t.id}] ${t.transaction_type} — ${t.total_amount} SDG — ${t.created_at}`);

// Most recent 5 purchases
console.log('\nMost recent 5 purchases:');
for (const p of q('SELECT id, created_at, total_amount, payment_status FROM purchases ORDER BY id DESC LIMIT 5'))
  console.log(`  [${p.id}] total:${p.total_amount} — status:${p.payment_status} — ${p.created_at}`);

// Expenses
console.log('\nAll expenses:');
for (const e of q('SELECT id, amount, description, created_at FROM expenses ORDER BY id'))
  console.log(`  [${e.id}] ${e.amount} SDG — ${e.description} — ${e.created_at}`);

// Suppliers
console.log('\nAll suppliers:');
for (const s of q('SELECT id, name, phone FROM suppliers ORDER BY id'))
  console.log(`  [${s.id}] ${s.name} — ${s.phone}`);

db.close();
