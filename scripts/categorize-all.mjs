/**
 * Categorize all products in one pass.
 * Run: node scripts/categorize-all.mjs
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'pharmasys.db');

// ── Category definitions with keyword rules ────────────────────────────────
const CATEGORIES = [
  {
    name: 'Medical Supplies',
    keywords: [
      'cannula', 'syringe', 'syring', 'catheter', 'gauze', 'bandage',
      'plaster', 'iv set', 'infusion set', 'gloves', 'examination glove',
      'microdroper', 'water for inj', 'ringer lactate', 'normal saline',
      'شاش', 'رباط', 'condom', 'd comfort', 'dr comfort', 'under pad',
      'breast pad', 'spirt solution', 'potassium permanganate', 'boracare',
      'cid water', 'gention voilet',
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
      'cerelac', 'celia ', 'baby light',
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
      'بالمرز كريم', 'كريم كانتو',
      'زيت البصل', 'زيت الخروع', 'زيت اللوز', 'زيت جنين',
      'صابونة كوجي', 'صابون لايف', 'ناموسية',
      'شامبو جونسون',
    ],
  },
  {
    name: 'Eye & Ear Care',
    keywords: [
      'eye drop', 'eye/ear drop', 'ear drop', 'ophthalmic', 'ophtalmic',
      'tears guard', 'hyfresh', 'polyfresh', 'twinzol', 'episopt',
      'optifucin', 'dexatorbin', 'ciprocin eye', 'brimosalam', 'brimonidine',
      'prisoline', 'xynosine', 'nostamine e/n', 'travatan',
      'candid ear', 'epifenac eye',
    ],
  },
  {
    name: 'Antibiotics',
    keywords: [
      'amoxicillin', 'amoclan', 'azimax', 'azithromycin',
      'zirocin', 'azura', 'ciprofloxacin', 'ciprocin', 'ciprodar',
      'azoflox', 'ofloxacin', 'wafrafloxacin', 'ificipro',
      'ceftriaxone', 'ryxon', 'amixone', 'samixon',
      'cefixime', 'suprax', 'amixime', 'bactofix',
      'cefuroxime', 'amiroxime', 'zetum', 'cefutil',
      'cefotaxime', 'ediceft', 'cefpodoxime', 'cefodox', 'proditil',
      'clarithromycin', 'clarncin',
      'gentamicin', 'gentamax',
      'penicillin', 'benzyl penicillin',
      'ampiclox', 'amixillin', 'amixilline', 'flumox',
      'amiclav', 'clavenen', 'augram', 'novamentin',
      'levofloxacin', 'levocin',
      'moxifloxacin', 'moxin',
      'metronidazole', 'flagyl', 'flancogyl', 'aminidazole', 'aminidazol',
      'nodigyl', 'metronab',
      'meropenem', 'actipenem',
      'amikacin', 'amitrim', 'doxim',
      'amilox', 'edixone',
    ],
  },
  {
    name: 'Antifungal',
    keywords: [
      'fluconazole', 'proflucan', 'itraconazole', 'itranox', 'canditral',
      'itrazol', 'griseofulvin', 'griscor', 'fungistatin', 'nystatin',
      'nocandida', 'terbinafine', 'terbin', 'kenazol', 'kenazole',
      'ketoconazole', 'miconaz',
      'gyno-mikonazol',
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
      'ispaghol',
    ],
  },
  {
    name: 'Analgesics & Antipyretics',
    keywords: [
      'paracetamol', 'cetal', 'amidol', 'azadol',
      'diclofenac', 'diclogesic', 'diclopinda', 'dicloran', 'remethan',
      'rofenac', 'romafen', 'balnac', 'adwiaflam',
      'ibuprofen', 'rumafen', 'amiprofen', 'profen 600',
      'mefenamic', 'monstan forte',
      'etoricoxib', 'starcox',
      'celecoxib', 'celcox',
      'aspirin', 'aspruna', 'aspirem',
      'flam-k',
      'melocam', 'meloxicam',
      'pain care', 'rapid cool', 'ice analgesic',
      'pain relief', 'voligesic', 'moover gel', 'nopain',
      'revanin', 'paragesic', 'airtal', 'amifenac',
      'divido', 'myogesic', 'traxamic', 'panol',
      'hydroxychloroquine', 'hydroxychloraquin',
      'dorofen',
    ],
  },
  {
    name: 'Cardiovascular',
    keywords: [
      'amlodipine', 'amlodac', 'amlodipin', 'amlovan', 'amidipin',
      'amilo 10', 'amlo 5', 'pronor',
      'bisoprolol', 'bisopro',
      'losartan', 'amilosan', 'losart',
      'candesartan', 'cansart', 'candestan', 'procand',
      'lisinopril', 'zinopril',
      'atorvastatin', 'atorvast', 'amistatin', 'rovista',
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
      'atenolol', 'ateno ',
      'isorem', 'isosorbide',
      'metoprolol', 'metomed',
      'methyldopa', 'medialpha',
      'diltiazem', 'aquanart',
      'nicorandil', 'amicor',
    ],
  },
  {
    name: 'Diabetes',
    keywords: [
      'metformin', 'formin', 'biguaphage', 'metfor', 'formit', 'mystro',
      'glimepiride', 'piramyl', 'amarax',
      'pioglitazone', 'zolid',
      'sitagliptin', 'glynuvia', 'gleptomet', 'sitamet',
      'vildagliptin', 'vilda', 'vilget', 'gliptus',
      'empagliflozin', 'empa ', 'empalina',
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
      'loperamide', 'imodal',
      'hyoscine', 'hyomax',
      'electroscot', 'ors',
      'microenema', 'hilac',
      'hydrotalcite', 'hydrogem',
      'bralix',
      'orazone',
    ],
  },
  {
    name: 'Respiratory',
    keywords: [
      'salbutamol', 'farcolin', 'vental', 'amibutamol',
      'montelukast', 'monkast', 'montiget',
      'symbicort',
      'asmatropim', 'nebulizer',
      'bronchopane', 'bronkal',
      'teeline', 'terbutaline',
      'mucolytic', 'muconab', 'mucobrave',
      'acetylcysteine', 'n-acetyl',
      'expectorant', 'amilyn',
      'nocuf', 'ecuf', 'ivycuf',
      'zecuf', 'cold rub',
      'balsam ped', 'pulmocare',
      'unifed', 'amrox',
      'nilodol', 'flutab', 'cold and flu',
      'cetam syrup',
      'ispaghol',
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
      'epilat', 'clofinil',
    ],
  },
  {
    name: 'Vitamins & Supplements',
    keywords: [
      'vitamin', 'multivitamin', 'omega', 'omevox',
      'iron', 'folic', 'foliclap', 'folicare', 'voxfol',
      'calcium', 'calci', 'calsyd',
      'zinc sulphate', 'ronin', 'zestcal',
      'b complex', 'b-complex', 'neo - vit', 'omnevora',
      'cod liver', 'halorange', 'halicare',
      'ferron', 'feroglobin', 'vitaferrol', 'combifer', 'haemovox', 'haematin',
      'carnivita', 'immunace', 'osteocare',
      'pregnacare', 'wellman', 'perfectil', 'jointace',
      'natrol', 'chromax', 'sanotact',
      'a-z vital', 'vital caps', 'vitum',
      'aileron plus', 'i-tose',
      'burly bone', 'mecoba', 'mecovil', 'methycobal',
      'fe-full', 'amiron',
      'prewell', 'maxivit',
      'v-pharma', 'hsn care',
      'fenugreek', 'honey care',
      'vitconex', 'pro-high',
      'kellagon', 'mag b6',
      'euthyrox',
      'hairfolic',
      'vision-aid', 'green zyme',
      'kifol', 'stevia', 'sweetener', 'sweetner',
      'ptc cod liver',
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
      'dexamethasone', 'prednisolone', 'pharmacort', 'prednil',
      'promegan',
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
      'allopurinol', 'goutex', 'zylonil', 'no-uric',
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
      'povidone iodine', 'lidocaine gel', 'lidocane spray',
      'clove oil',
      'honey cure',
      'zinc oxide adhesive',
      'olive oil  cream',
      'urecare', 'magic cream',
      'mouth wash', 'clenora',
      'gluotna soap', 'salistar',
      'b care plaster',
    ],
  },
];

async function main() {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  // 1. Create categories
  for (const cat of CATEGORIES) {
    db.run('INSERT OR IGNORE INTO categories (name) VALUES (?)', [cat.name]);
  }

  // Build category id map
  const cats = {};
  const catRows = db.exec('SELECT id, name FROM categories');
  if (catRows.length > 0) catRows[0].values.forEach(r => { cats[r[1]] = r[0]; });
  console.log(`Categories: ${Object.keys(cats).length}`);

  // 2. Load all products
  const prodRows = db.exec('SELECT id, name FROM products WHERE is_active = 1');
  if (prodRows.length === 0) { console.log('No products'); db.close(); return; }
  const products = prodRows[0].values.map(r => ({ id: r[0], name: String(r[1]) }));

  // 3. Match products to categories (first match wins; priority = array order)
  const assignments = new Map();
  const stats = {};
  for (const cat of CATEGORIES) stats[cat.name] = 0;

  for (const prod of products) {
    const lower = prod.name.toLowerCase();
    // Skip internal "cash" entries
    if (lower.includes('كاااا')) continue;

    for (const cat of CATEGORIES) {
      let found = false;
      for (const kw of cat.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          found = true;
          break;
        }
      }
      if (found) {
        assignments.set(prod.id, cat.name);
        stats[cat.name]++;
        break; // first category wins
      }
    }
  }

  // 4. Apply
  for (const [prodId, catName] of assignments) {
    const catId = cats[catName];
    if (catId) {
      db.run('UPDATE products SET category_id = ? WHERE id = ?', [catId, prodId]);
    }
  }

  // 5. Save
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));

  // 6. Report
  console.log('\n=== CATEGORIES ===');
  let total = 0;
  for (const cat of CATEGORIES) {
    if (stats[cat.name] > 0) {
      console.log(`  ${cat.name}: ${stats[cat.name]}`);
      total += stats[cat.name];
    }
  }
  console.log(`\nCategorized: ${total} / ${products.length}`);

  const uncat = products.filter(p => !assignments.has(p.id));
  console.log(`Uncategorized: ${uncat.length}`);
  if (uncat.length > 0) {
    console.log('\n=== UNCATEGORIZED ===');
    for (const p of uncat) console.log(`  [${p.id}] ${p.name}`);
  }

  db.close();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
