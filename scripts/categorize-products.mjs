/**
 * One-time script: Categorize existing products.
 * Run: node scripts/categorize-products.mjs
 *
 * Creates pharmacy categories and assigns products using keyword matching.
 * Only assigns where the match is unambiguous.
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pharmasys.db');

// ── Categories with keyword rules ──────────────────────────────────────────
// priority: lower index = higher priority (first match wins)
const CATEGORIES = [
  {
    name: 'Medical Supplies',
    keywords: [
      'cannula', 'syringe', 'syring', 'catheter', 'gauze', 'bandage',
      'plaster', 'iv set', 'infusion set', 'gloves', 'examination glove',
      'microdroper', 'water for inj', 'ringer lactate', 'normal saline',
      'شاش', 'رباط',
    ],
  },
  {
    name: 'Orthopedic Supports',
    keywords: [
      'knee support', 'knee brace', 'ankle brace', 'cervical collar',
      'wrist splint', 'abdominal binder', 'anti -embolism', 'anti-embolism',
      'surgical stocking', 'شراب دوالي', 'ركبة', 'ريست thumb',
    ],
  },
  {
    name: 'Baby Care',
    keywords: [
      'بزازة', 'حلمه', 'بامبرز', 'حزام فتاك', 'navel band', 'nipple',
      'cerelac', 'celia ',
    ],
  },
  {
    name: 'Personal Care',
    keywords: [
      'دوف', 'بانتين', 'جونسون', 'بالمرز', 'لوشن', 'مزيل',
      'فازلين', 'ريكسونا', 'كانتو', 'لايفبوي', 'هيد اند شولدرز',
      'فلفت روز', 'فخر لطافة', 'مس سينس', 'ايموشن', 'جستتي',
      'رويال بلو', 'رويال رجالي', 'رومانس', 'بدرة اطغال',
      'صابون دوف', 'صابونة دوف', 'كريم دوف', 'لوشن دوف',
      'شامبو دوف', 'شامبو بانتين', 'شامبو هيد',
      'كريم جونسون', 'لوشن جونسون', 'زيت جونسون',
      'palmers', 'بالمرز كريم', 'كريم كانتو',
      'زيت البصل', 'زيت الخروع', 'زيت اللوز', 'زيت جنين',
      'صابونة كوجي', 'صابون لايف', 'ناموسية',
    ],
  },
  {
    name: 'Eye & Ear Care',
    keywords: [
      'eye drop', 'eye/ear drop', 'ear drop', 'ophthalmic', 'ophtalmic',
      'tears guard', 'hyfresh', 'polyfresh', 'twinzol', 'episopt',
      'optifucin', 'dexatorbin', 'ciprocin eye', 'brimosalam', 'brimonidine',
      'prisoline', 'xynosine', 'nostamine e/n', 'travatan',
    ],
  },
  {
    name: 'Antibiotics',
    keywords: [
      'amoxicillin', 'amoclan', 'amoclan ', 'azimax', 'azithromycin',
      'zirocin', 'azura', 'ciprofloxacin', 'ciprocin', 'ciprodar',
      'azoflox', 'ofloxacin', 'wafrafloxacin',
      'ceftriaxone', 'ryxon', 'amixone', 'cefixime', 'suprax', 'amixime', 'bactofix',
      'cefuroxime', 'amiroxime', 'zetum', 'cefutil',
      'cefotaxime', 'ediceft', 'cefpodoxime', 'ferpod', 'proditil',
      'clarithromycin', 'clarncin',
      'gentamicin', 'gentamax',
      'penicillin', 'benzyl penicillin',
      'ampiclox', 'amixillin', 'amixilline', 'flumox',
      'amiclav', 'clavenen', 'augram',
      'levofloxacin', 'levocin',
      'moxifloxacin', 'moxin',
      'metronidazole', 'flagyl', 'flancogyl', 'aminidazole', 'aminidazol',
      'nodigyl', 'flagoshown',
      'meropenem', 'actipenem',
      'amikacin',
    ],
  },
  {
    name: 'Antifungal',
    keywords: [
      'fluconazole', 'proflucan', 'itraconazole', 'itranox', 'canditral',
      'itrazol', 'griseofulvin', 'griscor', 'fungistatin', 'nystatin',
      'nocandida', 'terbinafine', 'terbin', 'kenazol', 'kenazole',
      'ketoconazole', 'ketofen',
    ],
  },
  {
    name: 'Antiparasitic',
    keywords: [
      'albendazole', 'zestaval', 'didal', 'mebendazole', 'vermoxine',
      'quinine', 'primaquine', 'amisunate', 'artemcare', 'coartem',
      'rtx plus', 'amither', 'epiquantel', 'scabenil', 'benzyl benzoate',
    ],
  },
  {
    name: 'Antihistamines & Allergy',
    keywords: [
      'cetirizine', 'cetrizine', 'alatrol', 'finallerge',
      'chlorpheniramine', 'histop', 'amihistin',
      'levocetrizine', 'levotrizin',
      'xylometazoline', 'rhi - trivin', 'rhi-trivin',
    ],
  },
  {
    name: 'Analgesics & Antipyretics',
    keywords: [
      'paracetamol', 'cetal', 'amidol', 'azadol',
      'diclofenac', 'diclogesic', 'diclopinda', 'dicloran', 'remethan',
      'rofenac', 'romafen', 'balnac', 'adwiaflam',
      'ibuprofen', 'rumafen', 'amiprofen',
      'mefenamic', 'monstan forte',
      'etoricoxib', 'starcox',
      'celecoxib', 'celcox',
      'aspirin', 'aspruna',
      'flam-k',
      'melocam', 'meloxicam',
      'pain care', 'rapid cool', 'ice analgesic',
      'pain relief',
    ],
  },
  {
    name: 'Cardiovascular',
    keywords: [
      'amlodipine', 'amlodac', 'amlodipin', 'amlovan',
      'bisoprolol', 'bisopro',
      'losartan', 'amilosan', 'losart',
      'candesartan', 'cansart', 'candestan',
      'lisinopril', 'zinopril',
      'atorvastatin', ' ator ', 'rovista',
      'furosemide', 'uremide', 'furosix',
      'spironolactone', 'spirdacton',
      'doxazosin', 'cardosyr',
      'propranolol', 'propranolo', 'inderal',
      'plavix', 'antiplatt',
      'hydrochlorothiazide', 'diurex',
      'cova-h', 'covam',
      'cardura', 'cardex',
      'ascard',
      'daflon',
      'regcor', 'ramsun',
      'cinnarin', 'angosmmoth',
      'azapril', 'capocard',
    ],
  },
  {
    name: 'Diabetes',
    keywords: [
      'metformin', 'formin', 'biguaphage', 'metfor',
      'glimepiride', 'piramyl', 'amarax',
      'pioglitazone', 'zolid',
      'sitagliptin', 'glynuvia', 'gleptomet', 'sitamet',
      'vildagliptin', 'vilda',
      'empagliflozin', 'empa ',
      'diamicron', 'diabetone', 'diabenone',
      'getryle',
    ],
  },
  {
    name: 'Gastrointestinal',
    keywords: [
      'pantoprazole', 'pantodac', 'pancid', 'pantam', 'pantoprazol',
      'omeprazole', 'omiz',
      'esomeprazole', 'esmol',
      'lansoprazole', 'lansol',
      'domperidone', 'motillio', 'vomilux', 'vomidoxine',
      'ondansetron', 'danset', 'ondan ',
      'mebeverine', 'colospasmine', 'mebever',
      'antiacid', 'amigel',
      'deflat', 'simethicone', 'metsil',
      'laxine', 'laxofin', 'bisacodyl', 'bisadyl', 'lax tabs',
      'eucarbon', 'spasmofree',
      'helicure', 'rowachol', 'rowatinex', 'bilichol',
      'librax',
      'metoclop', 'topride', 'itopri',
    ],
  },
  {
    name: 'Respiratory',
    keywords: [
      'salbutamol', 'farcolin', 'vental',
      'montelukast', 'monkast', 'montiget',
      'symbicort',
      'asmatropim', 'nebulizer',
      'bronchopane', 'bronkal',
      'teeline', 'terbutaline',
      'mucolytic', 'muconab', 'mucobrave',
      'acetylcysteine', 'n-acetyl',
      'expectorant', 'amilyn',
      'nocuf', 'ecuf',
      'zecuf syr', 'zecuf loz',
      'balsam ped', 'pulmocare',
      'unifed',
    ],
  },
  {
    name: 'Neurological & Psychiatric',
    keywords: [
      'gabapentin', 'gapentin', 'neuroglopentin',
      'pregabalin', 'hexgabalin',
      'olanzapine', 'lanzapine', 'olabenz',
      'quetiapine', 'qtpine',
      'risperidone', 'rsipdon',
      'fluoxetine', 'elevamood',
      'duloxetine', 'adwitine',
      'lamotrigine', 'amigen',
      'sodium valproate', 'sodium valporate', 'depavalolem', 'depox', 'valpoval',
      'carbamazepine', 'storilat', 'carbatec',
      'haloperidol', 'haloxen',
      'aripiprazole', 'adwiprazole',
      'neuroton', 'milga', 'neurozan',
      'cerebro', 'cerebroforte',
      'solosleep', 'deanxit', 'tenaxit',
      'epilat',
    ],
  },
  {
    name: 'Vitamins & Supplements',
    keywords: [
      'vitamin', 'multivitamin', 'omega', 'omevox',
      'iron', 'folic', 'foliclap', 'voxfol',
      'calcium', 'calci', 'calsyd',
      'zinc', 'zestcal',
      'b complex', 'b-complex', 'neo - vit', 'omnevora',
      'cod liver', 'halorange', 'halicare',
      'ferron', 'feroglobin', 'vitaferrol', 'combifer', 'haemovox', 'haematin',
      'carnivita', 'immunace', 'osteocare',
      'pregnacare', 'wellman', 'perfectil', 'jointace',
      'natrol', 'chromax', 'sanotact vit',
      'a-z vital', 'vital caps', 'vitum',
      'aileron plus',
      'burly bone', 'mecoba', 'mecovil', 'methycobal',
      'fe-full', 'amiron',
      'prewell', 'maxivit',
      'v-pharma', 'hsn care',
      'fenugreek', 'honey care', 'ispaghol',
      'vitconex', 'pro-high',
      'kellagon',
      'euthyrox',
      'hairfolic',
      'sanotact beauty',
    ],
  },
  {
    name: 'Hormones & Reproductive',
    keywords: [
      'clomiphene', 'incite',
      'duphaston', 'dydrogesterone', 'dydrosyn',
      'exluton', 'norethisterone', 'norcutin',
      'pregnyl', 'epifasi',
      'fertilex', 'ovasistol',
      'letrozole', 'letroz',
      'pregnavox',
      'depopizolone', 'palodal',
      'enoxaparin', 'enox',
      'carbimazole', 'neomercazole',
    ],
  },
  {
    name: 'Urological',
    keywords: [
      'tamsulosin', 'tamsulin', 'block alpha',
      'prostride', 'finasteride',
      'prostanorm', 'coli-urinal', 'coli - urinal',
      'pot cit', 'potassium citrate',
      'proximol', 'miocran-uro',
    ],
  },
  {
    name: 'Dermatology',
    keywords: [
      'fusidic', 'fusi cream', 'fusi ointment', 'fusirid', 'fusiderm',
      'betaderm', 'betamet', 'supricort',
      'cutisone', 'clobetasol',
      'methasalic',
      'mupirocin',
      'tacroz', 'acretin',
      'mabelle cream',
      'icthmol',
      'proctoheal',
      'lavender cream',
      'photoblock',
      'panderm',
      'corn remover',
      'candid b cream', 'candid cream', 'candid v',
      'monicure', 'byno-mikonazol',
      'denon soap', 'noori cream',
      'actolind',
      'nebanol',
      'marpalene',
      'salibet',
      'depopizolone',
      'povidone iodine', 'lidocaine gel', 'lidocane spray',
      'clove oil',
      'honey cure',
      'gentio', 'gention',
      'zinc oxide adhesive',
      'olive oil  cream',
    ],
  },
];

async function main() {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  // 1. Create categories
  for (const cat of CATEGORIES) {
    db.run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [cat.name]);
  }

  // Build category id map
  const catRows = db.exec('SELECT id, name FROM categories');
  const catMap = new Map();
  if (catRows.length > 0) {
    for (const row of catRows[0].values) {
      catMap.set(row[1], row[0]); // name → id
    }
  }
  console.log(`Created ${catMap.size} categories`);

  // 2. Load all products
  const prodRows = db.exec('SELECT id, name FROM products WHERE is_active = 1');
  if (prodRows.length === 0) { console.log('No products found'); db.close(); return; }
  const products = prodRows[0].values.map(r => ({ id: r[0], name: r[1] }));

  // 3. Match products to categories
  const assignments = new Map(); // product_id → category_name
  const stats = {};
  for (const cat of CATEGORIES) stats[cat.name] = 0;

  for (const prod of products) {
    const lower = String(prod.name).toLowerCase();

    // Skip ambiguous "cash" entries
    if (lower.includes('كاااا')) continue;

    let matched = null;
    for (const cat of CATEGORIES) {
      for (const kw of cat.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          if (matched && matched !== cat.name) {
            // Conflict — skip (ambiguous)
            matched = null;
            break;
          }
          matched = cat.name;
          break; // found a keyword in this category
        }
      }
      if (matched === null && assignments.has(prod.id)) break; // was reset by conflict
    }

    if (matched) {
      assignments.set(prod.id, matched);
      stats[matched]++;
    }
  }

  // 4. Apply assignments
  const stmt = db.prepare('UPDATE products SET category_id = ? WHERE id = ?');
  for (const [prodId, catName] of assignments) {
    const catId = catMap.get(catName);
    if (catId) {
      stmt.run([catId, prodId]);
    }
  }
  stmt.free();

  // 5. Save
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));

  // 6. Report
  console.log('\n=== ASSIGNMENT SUMMARY ===');
  let totalAssigned = 0;
  for (const cat of CATEGORIES) {
    if (stats[cat.name] > 0) {
      console.log(`  ${cat.name}: ${stats[cat.name]}`);
      totalAssigned += stats[cat.name];
    }
  }
  console.log(`\nTotal assigned: ${totalAssigned} / ${products.length}`);
  console.log(`Uncategorized: ${products.length - totalAssigned}`);

  // List uncategorized
  const uncat = products.filter(p => !assignments.has(p.id));
  if (uncat.length > 0) {
    console.log('\n=== UNCATEGORIZED PRODUCTS ===');
    for (const p of uncat) {
      console.log(`  [${p.id}] ${p.name}`);
    }
  }

  db.close();
  console.log('\nDone! Database saved.');
}

main().catch(e => { console.error(e); process.exit(1); });
