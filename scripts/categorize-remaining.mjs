/**
 * Second pass: manually assign remaining uncategorized products.
 * Run: node scripts/categorize-remaining.mjs
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pharmasys.db');

async function main() {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  // Get category IDs
  const cats = {};
  const catRows = db.exec('SELECT id, name FROM categories');
  if (catRows.length > 0) catRows[0].values.forEach(r => { cats[r[1]] = r[0]; });

  // Manual assignments for the 32 remaining uncategorized products
  // Only ones we are 100% confident about
  const manual = {
    // Sildenafil / Tadalafil → Urological (erectile dysfunction)
    139: 'Urological',           // Azafil 100mg tabs (Sildenafil)
    309: 'Urological',           // CD Vegra 100 mg (Sildenafil)
    62:  'Urological',           // Super 50 (Sildenafil)
    153: 'Urological',           // Virecta 100mg tabs (Sildenafil)
    342: 'Urological',           // Flagoshown 20 mg (Tadalafil)

    // Clear drug class matches
    312: 'Antihistamines & Allergy',  // Chloropheniramine Inj (antihistamine)
    131: 'Antihistamines & Allergy',  // Ketofen Syrup (Ketotifen - antihistamine)
    250: 'Antiparasitic',             // Coartam ASA 480/80 (artemether/lumefantrine - antimalarial)
    347: 'Eye & Ear Care',            // Fuci Opthalmic (Fucidic Acid 1% - eye antibiotic)
    42:  'Analgesics & Antipyretics', // Paragesıc Baby 120mg/5ml (paracetamol - Turkish ı missed by keyword)
    373: 'Gastrointestinal',          // Amilans 30 mg (lansoprazole - PPI)
    555: 'Vitamins & Supplements',    // Ferpod 100mg tab (iron supplement)
    577: 'Vitamins & Supplements',    // Gentaplex (male health supplement)
    67:  'Dermatology',               // Virustst (Acyclovir 5%) Cream (topical)
    98:  'Medical Supplies',          // Breast Pad (breast pads)
  };

  let count = 0;
  for (const [id, catName] of Object.entries(manual)) {
    const catId = cats[catName];
    if (!catId) { console.log('Missing category:', catName); continue; }
    db.run(
      'UPDATE products SET category_id = ? WHERE id = ? AND (category_id IS NULL OR category_id = 0)',
      [catId, Number(id)]
    );
    count++;
  }

  console.log(`Updated ${count} products`);

  // Save
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));

  // Final stats
  const byCat = db.exec(`
    SELECT COALESCE(c.name, '(uncategorized)') as cat, COUNT(*) as cnt
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.is_active = 1
    GROUP BY p.category_id ORDER BY cnt DESC
  `);
  console.log('\n=== FINAL CATEGORY COUNTS ===');
  if (byCat.length > 0) byCat[0].values.forEach(r => console.log(`  ${r[0]}: ${r[1]}`));

  const remaining = db.exec(
    'SELECT id, name FROM products WHERE is_active = 1 AND (category_id IS NULL OR category_id = 0) ORDER BY name'
  );
  const remCount = remaining.length > 0 ? remaining[0].values.length : 0;
  const totalActive = db.exec('SELECT COUNT(*) FROM products WHERE is_active = 1')[0].values[0][0];
  console.log(`\nTotal categorized: ${totalActive - remCount} / ${totalActive}`);
  console.log(`Remaining uncategorized: ${remCount}`);

  if (remaining.length > 0) {
    console.log('\nStill uncategorized:');
    remaining[0].values.forEach(r => console.log(`  [${r[0]}] ${r[1]}`));
  }

  db.close();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
