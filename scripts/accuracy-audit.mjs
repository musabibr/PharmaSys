/**
 * accuracy-audit.mjs — comprehensive data accuracy check on pharmasys.db
 */
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
function cnt(t) { return db.exec(`SELECT COUNT(*) FROM ${t}`)[0]?.values[0]?.[0] ?? 0; }

let issues = 0;
function warn(msg) { console.log(`  ⚠️  ${msg}`); issues++; }
function ok(msg)   { console.log(`  ✅ ${msg}`); }

console.log('\n══════════════════════════════════════════════════════');
console.log('  PHARMASYS DATA ACCURACY AUDIT');
console.log('══════════════════════════════════════════════════════\n');

// ── Counts ──────────────────────────────────────────────────────────────────
console.log('── Row Counts ─────────────────────────────────────────');
const products   = cnt('products');
const batches    = cnt('batches');
const activeBatch = db.exec("SELECT COUNT(*) FROM batches WHERE quantity_base > 0 AND status='active'")[0]?.values[0]?.[0];
console.log(`  Products:  ${products}`);
console.log(`  Batches:   ${batches} total (${activeBatch} active with stock)`);
console.log(`  Suppliers: ${cnt('suppliers')}`);
console.log(`  Purchases: ${cnt('purchases')}`);
console.log(`  Transactions: ${cnt('transactions')} | Shifts: ${cnt('shifts')}`);

// ── Pricing Sanity ───────────────────────────────────────────────────────────
console.log('\n── Pricing Sanity Checks ──────────────────────────────');

// cost_per_parent = 0
const zeroCost = q("SELECT p.name, b.id as bid FROM batches b JOIN products p ON p.id=b.product_id WHERE b.cost_per_parent = 0");
if (zeroCost.length > 0) { warn(`${zeroCost.length} batches with cost_per_parent = 0`); zeroCost.slice(0,5).forEach(r => console.log(`      [${r.bid}] ${r.name}`)); }
else ok('All batches have non-zero cost_per_parent');

// selling_price_parent = 0
const zeroSell = q("SELECT p.name, b.id as bid FROM batches b JOIN products p ON p.id=b.product_id WHERE b.selling_price_parent = 0 AND b.quantity_base > 0");
if (zeroSell.length > 0) { warn(`${zeroSell.length} active batches with selling_price_parent = 0`); zeroSell.slice(0,5).forEach(r => console.log(`      [${r.bid}] ${r.name}`)); }
else ok('All active batches have non-zero selling_price_parent');

// sell < cost (negative margin)
const negMargin = q(`
  SELECT p.name, b.cost_per_parent, b.selling_price_parent, b.id as bid
  FROM batches b JOIN products p ON p.id=b.product_id
  WHERE b.quantity_base > 0 AND b.status='active'
    AND b.selling_price_parent > 0
    AND b.selling_price_parent < b.cost_per_parent
`);
if (negMargin.length > 0) { warn(`${negMargin.length} batches selling BELOW cost:`); negMargin.slice(0,10).forEach(r => console.log(`      [${r.bid}] ${r.name} — cost:${r.cost_per_parent} sell:${r.selling_price_parent}`)); }
else ok('No batches selling below cost');

// Extreme margins (>200% or sell = cost i.e. 0 margin for non-free items)
const extremeMargin = q(`
  SELECT * FROM (
    SELECT p.name, b.cost_per_parent, b.selling_price_parent, b.id as bid,
      CAST((b.selling_price_parent - b.cost_per_parent) * 100.0 / b.cost_per_parent AS INTEGER) as margin_pct
    FROM batches b JOIN products p ON p.id=b.product_id
    WHERE b.quantity_base > 0 AND b.status='active' AND b.cost_per_parent > 0
  ) WHERE margin_pct > 200 OR margin_pct = 0
`);
if (extremeMargin.length > 0) { console.log(`  ℹ️  ${extremeMargin.length} batches with unusual margin (0% or >200%):`); extremeMargin.slice(0,10).forEach(r => console.log(`      [${r.bid}] ${r.name} — margin:${r.margin_pct}% cost:${r.cost_per_parent} sell:${r.selling_price_parent}`)); }
else ok('All margins within normal range');

// ── Conversion Factor / Child Unit Consistency ───────────────────────────────
console.log('\n── Conversion Factor Checks ───────────────────────────');

// Products with child_unit but cf=1 or cf=0
const badCf = q(`
  SELECT id, name, child_unit, conversion_factor FROM products
  WHERE child_unit IS NOT NULL AND child_unit != ''
    AND (conversion_factor IS NULL OR conversion_factor <= 1)
`);
if (badCf.length > 0) { warn(`${badCf.length} products have child_unit but conversion_factor <= 1:`); badCf.slice(0,5).forEach(r => console.log(`      [${r.id}] ${r.name} — child:${r.child_unit} cf:${r.conversion_factor}`)); }
else ok('All products with child_unit have conversion_factor > 1');

// cost_per_child mismatch (should be floor(cost_per_parent / cf))
const childMismatch = q(`
  SELECT p.name, p.conversion_factor as cf, b.cost_per_parent, b.cost_per_child,
         b.cost_per_child_override, b.id as bid,
         CAST(b.cost_per_parent / p.conversion_factor AS INTEGER) as expected_child
  FROM batches b JOIN products p ON p.id = b.product_id
  WHERE p.conversion_factor > 1
    AND b.cost_per_child_override != CAST(b.cost_per_parent / p.conversion_factor AS INTEGER)
    AND b.cost_per_child_override != 0
    AND b.quantity_base > 0
`);
if (childMismatch.length > 0) {
  console.log(`  ℹ️  ${childMismatch.length} batches where cost_per_child_override ≠ floor(cost_per_parent/cf):`);
  childMismatch.slice(0,10).forEach(r => console.log(`      [${r.bid}] ${r.name} — cf:${r.cf} cost_parent:${r.cost_per_parent} child_override:${r.cost_per_child_override} expected:${r.expected_child}`));
} else ok('cost_per_child_override matches floor(cost_per_parent/cf) on all active batches');

// ── Quantity / Stock Checks ──────────────────────────────────────────────────
console.log('\n── Stock Quantity Checks ──────────────────────────────');

const negStock = q("SELECT p.name, b.id, b.quantity_base FROM batches b JOIN products p ON p.id=b.product_id WHERE b.quantity_base < 0");
if (negStock.length > 0) { warn(`${negStock.length} batches with NEGATIVE quantity_base`); negStock.forEach(r => console.log(`      [${r.id}] ${r.name}: ${r.quantity_base}`)); }
else ok('No negative quantities');

const productsNoStock = q(`
  SELECT p.id, p.name FROM products p
  WHERE NOT EXISTS (SELECT 1 FROM batches b WHERE b.product_id=p.id AND b.quantity_base > 0 AND b.status='active')
  AND p.is_active=1
`);
console.log(`  ℹ️  ${productsNoStock.length} active products with zero stock (may be intentional)`);

// ── Batch number format check ─────────────────────────────────────────────────
const batchFormat = q("SELECT batch_number, COUNT(*) as n FROM batches WHERE batch_number LIKE 'BN-20260316-%' GROUP BY 1 LIMIT 1");
if (batchFormat.length > 0) {
  console.log(`  ℹ️  Batches use auto-generated IDs (BN-20260316-XXXX format) — ${cnt('batches')} total`);
}

// ── Full Inventory Valuation ─────────────────────────────────────────────────
console.log('\n── Inventory Valuation (active stock only) ────────────');

const valRows = q(`
  SELECT
    p.name, p.conversion_factor as cf,
    COALESCE(SUM(b.quantity_base), 0) as qty_base,
    COALESCE(SUM(b.quantity_base * COALESCE(
      NULLIF(b.cost_per_child_override, 0),
      b.cost_per_child,
      CASE WHEN p.conversion_factor > 0 THEN CAST(b.cost_per_parent / p.conversion_factor AS INTEGER)
           ELSE b.cost_per_parent END
    )), 0) as cost_val,
    COALESCE(SUM(b.quantity_base * COALESCE(
      NULLIF(b.selling_price_child_override, 0),
      b.selling_price_child,
      CASE WHEN p.conversion_factor > 0 THEN CAST(b.selling_price_parent / p.conversion_factor AS INTEGER)
           ELSE b.selling_price_parent END
    )), 0) as sell_val
  FROM products p
  LEFT JOIN batches b ON b.product_id=p.id AND b.quantity_base>0 AND b.status='active'
  GROUP BY p.id HAVING qty_base > 0
  ORDER BY cost_val DESC
`);

let totalCost = 0, totalSell = 0;
console.log(`\n  ${'Product'.padEnd(40)} ${'Qty(base)'.padStart(10)} ${'Cost Value'.padStart(12)} ${'Sell Value'.padStart(12)} ${'Margin'.padStart(8)}`);
console.log('  ' + '-'.repeat(86));
for (const v of valRows) {
  totalCost += v.cost_val;
  totalSell += v.sell_val;
  const margin = v.sell_val > 0 ? (((v.sell_val - v.cost_val) / v.sell_val) * 100).toFixed(1) + '%' : 'N/A';
  const name = v.name.replace(/\n/g,' ').substring(0, 38).padEnd(40);
  console.log(`  ${name} ${String(v.qty_base).padStart(10)} ${String(v.cost_val).padStart(12)} ${String(v.sell_val).padStart(12)} ${margin.padStart(8)}`);
}
console.log('  ' + '-'.repeat(86));
console.log(`  ${'TOTAL'.padEnd(40)} ${' '.repeat(10)} ${String(totalCost).padStart(12)} ${String(totalSell).padStart(12)} ${(((totalSell-totalCost)/totalSell)*100).toFixed(1).padStart(7)}%`);
console.log(`\n  Total cost value:   ${totalCost.toLocaleString()} SDG`);
console.log(`  Total retail value: ${totalSell.toLocaleString()} SDG`);
console.log(`  Potential profit:   ${(totalSell - totalCost).toLocaleString()} SDG`);
console.log(`  Gross margin:       ${(((totalSell - totalCost) / totalSell) * 100).toFixed(2)}%`);

// ── Expiry Status ─────────────────────────────────────────────────────────────
console.log('\n── Expiry Status ──────────────────────────────────────');
const expired   = q("SELECT COUNT(*) as n FROM batches WHERE expiry_date < date('now') AND quantity_base>0 AND status='active'")[0].n;
const exp30     = q("SELECT COUNT(*) as n FROM batches WHERE expiry_date BETWEEN date('now') AND date('now','+30 days') AND quantity_base>0 AND status='active'")[0].n;
const exp90     = q("SELECT COUNT(*) as n FROM batches WHERE expiry_date BETWEEN date('now','+1 day') AND date('now','+90 days') AND quantity_base>0 AND status='active'")[0].n;
if (expired > 0) warn(`${expired} batches ALREADY EXPIRED with remaining stock`);
else ok('No expired batches with active stock');
if (exp30 > 0) console.log(`  ⚠️  ${exp30} batches expire within 30 days`);
if (exp90 > 0) console.log(`  ℹ️  ${exp90} batches expire within 90 days`);

// ── Purchases / Payables ─────────────────────────────────────────────────────
console.log('\n── Purchases & Payables ───────────────────────────────');
const payables = q(`
  SELECT s.name as supplier, p.purchase_number, p.total_amount, p.total_paid, p.payment_status, p.purchase_date
  FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id
  ORDER BY p.id
`);
let totalOwed = 0;
for (const p of payables) {
  const owed = (p.total_amount ?? 0) - (p.total_paid ?? 0);
  totalOwed += owed;
  const status = p.payment_status === 'paid' ? '✅' : p.payment_status === 'partial' ? '⚠️ ' : '❌';
  console.log(`  ${status} ${(p.purchase_number ?? 'N/A').padEnd(22)} ${(p.supplier ?? 'N/A').padEnd(30)} total:${String(p.total_amount).padStart(9)} paid:${String(p.total_paid??0).padStart(9)} owed:${String(owed).padStart(9)}`);
}
console.log(`\n  TOTAL PAYABLES: ${totalOwed.toLocaleString()} SDG`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
if (issues === 0) {
  console.log('  ✅ DATA IS ACCURATE — No critical issues found.');
} else {
  console.log(`  ⚠️  ${issues} issue(s) found — review warnings above.`);
}
console.log('══════════════════════════════════════════════════════\n');

db.close();
