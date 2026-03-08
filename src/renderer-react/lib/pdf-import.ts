/**
 * PDF vendor invoice parser.
 *
 * Extracts product rows from structured PDF invoices (e.g. "Medical Plus" vendor).
 * Uses pdfjs-dist for text extraction with position data, then reconstructs the
 * table by clustering text items into rows by Y coordinate and assigning columns
 * by X coordinate (nearest-center matching for RTL compatibility).
 *
 * The PDF is RTL — physical column order from left to right:
 *   الجملة | سعر الوحدة | الكمية | الوحدة | Exp Date | الصنف | #
 * Semantic order (right to left):
 *   # | الصنف (name) | Exp Date | الوحدة (unit) | الكمية (qty) | سعر الوحدة (cost) | الجملة (total)
 */

import { tryGridParsePage } from './pdf-grid';
import type { GridTextItem } from './pdf-grid';

// pdfjs-dist is loaded lazily inside getPdfjs() to avoid blocking module init.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pdfjs: any = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfInvoiceMetadata {
  purchaseDate: string | null;      // YYYY-MM-DD
  invoiceReference: string | null;
  totalDebt: number | null;         // whole SDG
  vendorName: string | null;
}

export interface PdfInvoiceResult {
  metadata: PdfInvoiceMetadata;
  items: PdfInvoiceRow[];
}

export interface PdfInvoiceRow {
  rowNumber: number;
  name: string;
  expiryDate: string;   // DD/MM/YYYY from PDF
  unit: string;         // raw unit string (e.g. "BOX", "BOX/3 STRIP")
  quantity: number;
  costPerUnit: number;
  lineTotal: number;
}

export interface ParsedUnitInfo {
  parentUnit: string;
  childUnit: string;
  conversionFactor: number;
}

interface TextItem {
  str: string;
  x: number;       // normalized X (RTL-adjusted) — for text-fallback parser
  y: number;
  width: number;
  rawX: number;     // raw transform[4] — for grid parser (same coord space as grid cells)
}

interface TextRow {
  y: number;
  items: TextItem[];
}

/** Semantic column indices resolved from the header */
interface ColumnMap {
  rowNum: number;
  name: number;
  expiry: number;
  unit: number;
  qty: number;
  cost: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Arabic-Indic digit normalization
// ---------------------------------------------------------------------------

/** Convert Arabic-Indic digits (٠-٩) to Western digits (0-9). */
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
}

/** Normalize number separators: Arabic comma (٬), Arabic decimal (٫), Western comma. */
function normalizeNumberStr(s: string): string {
  let out = normalizeDigits(s.trim());
  // Arabic decimal separator ٫ → dot
  out = out.replace(/٫/g, '.');
  // Remove thousands separators (Arabic comma ٬ and Western comma)
  out = out.replace(/[٬,]/g, '');
  return out;
}

// ---------------------------------------------------------------------------
// Unit mapping
// ---------------------------------------------------------------------------

const UNIT_MAP: Record<string, string> = {
  // English (matched after toUpperCase)
  'BOX':    'Box',
  'BOTELL': 'Bottle',
  'BOTTLE': 'Bottle',
  'BTL':    'Bottle',
  'TUB':    'Tube',
  'TUBE':   'Tube',
  'STRIP':  'Strip',
  'STRIPT': 'Strip',
  'PCS':    'Piece',
  'PC':     'Piece',
  'AMBOLS': 'Ampoule',
  'AMPOULE':'Ampoule',
  'DROP':   'Drop',
  'DROPS':  'Drop',
  'VAIL':   'Vial',
  'VIAL':   'Vial',
  'SACHET': 'Sachet',
  'SUPP':   'Suppository',
  'ROLL':   'Roll',
  'JAR':    'Jar',
  'CAN':    'Can',
  'BAG':    'Bag',
  'UNIT':   'Unit',
  'TAB':    'Tablet',
  'TABLET': 'Tablet',
  'CAPSULE':'Capsule',
  'CAP':    'Capsule',
  // Arabic (no case conversion needed — Arabic has no uppercase)
  'علبة':   'Box',
  'علب':    'Box',
  'قارورة': 'Bottle',
  'زجاجة':  'Bottle',
  'أنبوب':  'Tube',
  'أنبوبة': 'Tube',
  'شريط':   'Strip',
  'شرائط':  'Strip',
  'قطعة':   'Piece',
  'حبة':    'Piece',
  'أمبول':  'Ampoule',
  'أمبولة': 'Ampoule',
  'قطرة':   'Drop',
  'قطرات':  'Drop',
  'فيال':   'Vial',
  'كيس':    'Sachet',
  'أكياس':  'Sachet',
  'تحميلة': 'Suppository',
  'تحاميل': 'Suppository',
  'لفة':    'Roll',
  'برطمان': 'Jar',
  'عبوة':   'Unit',
  'وحدة':   'Unit',
  'كبسولة': 'Capsule',
  'قرص':    'Tablet',
  'أقراص':  'Tablet',
};

/**
 * Parse vendor unit string into parent/child/conversion factor.
 * Handles both English and Arabic unit names, including Arabic-Indic digits.
 */
export function parseUnitString(raw: string): ParsedUnitInfo {
  const trimmed = raw.trim();
  const normalized = normalizeDigits(trimmed);

  // Word pattern that matches English (\w) and Arabic (\u0600-\u06FF) characters
  const wordPat = '[\\w\\u0600-\\u06FF]+';

  // Compound pattern: "BOX/3 STRIP", "BOX/2STRIP", "BOX / 3 STRIP", "علبة/3 شريط"
  const compoundRe = new RegExp(`^(${wordPat})\\s*/\\s*(\\d+)\\s*(${wordPat})$`);
  const compoundMatch = normalized.match(compoundRe);
  if (compoundMatch) {
    const parentRaw = compoundMatch[1];
    const factor = parseInt(compoundMatch[2], 10);
    const childRaw = compoundMatch[3];
    // Try both original case and uppercase for English
    const parentKey = UNIT_MAP[parentRaw] ? parentRaw : parentRaw.toUpperCase();
    const childKey = UNIT_MAP[childRaw] ? childRaw : childRaw.toUpperCase();
    return {
      parentUnit: UNIT_MAP[parentKey] || parentRaw,
      childUnit: UNIT_MAP[childKey] || childRaw,
      conversionFactor: factor || 1,
    };
  }

  // Simple unit: try Arabic first (case-sensitive), then English (uppercased)
  const mapped = UNIT_MAP[trimmed] || UNIT_MAP[trimmed.toUpperCase()] || trimmed;
  return { parentUnit: mapped, childUnit: '', conversionFactor: 1 };
}

/**
 * Convert DD/MM/YYYY → YYYY-MM-DD.
 * Handles both Western and Arabic-Indic digits.
 */
export function convertDateFormat(ddmmyyyy: string): string {
  const normalized = normalizeDigits(ddmmyyyy.trim());
  const m = normalized.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return ddmmyyyy;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3];
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

/**
 * Lazily load pdfjs-dist and configure the worker.
 *
 * Strategy: Import the worker module, extract WorkerMessageHandler, and
 * register it on globalThis.pdfjsWorker. When pdfjs-dist's PDFWorker sees
 * this global, it uses a "fake worker" (runs on the main thread via message
 * passing) instead of spawning a Web Worker. This avoids all Worker URL
 * resolution, CSP, and ESM module-type issues in Electron's sandboxed renderer.
 *
 * For 6-page vendor invoices, main-thread execution is perfectly fast.
 */
async function getPdfjs() {
  if (_pdfjs) return _pdfjs;

  // Polyfill ReadableStream async iteration for Electron 28 (Chromium 120).
  // pdfjs-dist v5's getTextContent() uses `for await...of` on ReadableStream,
  // but Symbol.asyncIterator was only added to ReadableStream in Chrome 124.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RSProto = typeof ReadableStream !== 'undefined'
    ? (ReadableStream.prototype as any)
    : null;
  if (RSProto && !RSProto[Symbol.asyncIterator]) {
    RSProto[Symbol.asyncIterator] = async function* (
      this: ReadableStream,
    ) {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    };
  }

  // Step 1: Import the LEGACY worker module (polyfills Promise.try etc. for
  // Electron's Chromium) and explicitly register its WorkerMessageHandler on
  // globalThis. We set it explicitly because Vite pre-bundling may strip the
  // module's own `globalThis.pdfjsWorker = ...` side-effect assignment.
  // @ts-expect-error — no type declarations for the worker module
  const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).pdfjsWorker = {
    WorkerMessageHandler: workerModule.WorkerMessageHandler,
  };

  // Step 2: Import the LEGACY main pdfjs library (matches the legacy worker)
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Step 3: Set workerSrc to a data URI that errors immediately.
  // If the globalThis.pdfjsWorker check somehow fails and pdfjs creates a Worker,
  // this makes the Worker error out fast instead of hanging forever.
  // (A 'blob:noop' would cause an `import("blob:noop")` that hangs indefinitely.)
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'data:text/javascript,throw new Error("no-op worker")';

  _pdfjs = pdfjsLib;
  return pdfjsLib;
}

/** Wrap a promise with a timeout so worker hangs don't block forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Data extracted from a single PDF page: text items + pdfjs page reference. */
interface PageData {
  textItems: TextItem[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any; // pdfjs PDFPageProxy — kept for getOperatorList() in grid extraction
}

async function extractPageData(buffer: ArrayBuffer): Promise<PageData[]> {
  console.log('[pdf-import] loading pdfjs...');
  const pdfjsLib = await getPdfjs();
  console.log('[pdf-import] pdfjs loaded, calling getDocument...');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = await withTimeout(
    pdfjsLib.getDocument({ data: buffer }).promise,
    30_000,
    'PDF loading',
  );
  console.log('[pdf-import] document loaded, pages:', doc.numPages);
  const pages: PageData[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: TextItem[] = [];

    for (const item of content.items) {
      if (!('str' in item)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textItem = item as any;
      const str = textItem.str.trim();
      if (!str) continue;

      const tx = textItem.transform;
      // pdfjs width can be 0 or negative for RTL text.
      // Use absolute value, and if still 0, estimate from font size and text length.
      let w = Math.abs(textItem.width || 0);
      if (w === 0) {
        // Estimate: fontSize comes from transform scaleX (tx[0]) or fallback 10.
        const fontSize = tx ? Math.abs(tx[0]) || 10 : 10;
        w = str.length * fontSize * 0.5;
      }

      const rawX = tx ? tx[4] : 0;
      const dir: string = textItem.dir ?? 'ltr';
      // For RTL text, pdfjs gives x as the right edge; normalize to left edge
      const x = dir === 'rtl' ? rawX - w : rawX;
      items.push({ str, x, y: tx ? tx[5] : 0, width: w, rawX });
    }

    pages.push({ textItems: items, page });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Row clustering
// ---------------------------------------------------------------------------

function clusterIntoRows(items: TextItem[], tolerance = 3): TextRow[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: TextRow[] = [];
  let currentRow: TextRow = { y: sorted[0].y, items: [sorted[0]] };

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    if (Math.abs(item.y - currentRow.y) <= tolerance) {
      currentRow.items.push(item);
    } else {
      currentRow.items.sort((a, b) => a.x - b.x);
      rows.push(currentRow);
      currentRow = { y: item.y, items: [item] };
    }
  }
  currentRow.items.sort((a, b) => a.x - b.x);
  rows.push(currentRow);

  return rows;
}

// ---------------------------------------------------------------------------
// Header detection and column mapping
// ---------------------------------------------------------------------------

function isHeaderRow(row: TextRow): boolean {
  const text = row.items.map((i) => i.str).join(' ');
  const hasProductCol =
    text.includes('الصنف') || text.includes('المنتج') || text.includes('اسم') ||
    text.includes('Product') || text.includes('Description') || text.includes('Item') ||
    text.includes('DESCRIPTION');
  const hasDateCol =
    text.includes('Exp') || text.includes('exp') || text.includes('EXPIRE') ||
    text.includes('تاريخ') || text.includes('الصلاحية') || text.includes('انتهاء');
  const hasUnitCol =
    text.includes('الوحدة') || text.includes('وحدة') ||
    text.includes('Unit') || text.includes('UNIT');
  const hasQtyCol =
    text.includes('الكمية') || text.includes('كمية') ||
    text.includes('Qty') || text.includes('Quantity') || text.includes('QUANTIT');
  return hasProductCol && (hasDateCol || hasUnitCol || hasQtyCol);
}

/**
 * Build column mapping from header row.
 *
 * Computes two column-assignment structures:
 * - `headerCenters`: center X of each header item (for nearest-center matching)
 * - `headerBounds`: left/right edge of each header column (for range-overlap matching)
 *
 * Range-overlap is used first; nearest-center is the fallback.
 */
function buildColumnMap(headerRow: TextRow): {
  headerCenters: number[];
  headerBounds: Array<{ left: number; right: number }>;
  numCols: number;
  colMap: ColumnMap;
} {
  const items = headerRow.items;
  const colNames = items.map((i) => i.str);

  // Center X of each header item
  const headerCenters = items.map((it) => it.x + it.width / 2);

  // Compute column bounds: each column extends from midpoint-to-previous to midpoint-to-next.
  // This creates non-overlapping ranges that cover the full page width.
  const headerBounds: Array<{ left: number; right: number }> = items.map((it, idx) => {
    const myCenter = it.x + it.width / 2;
    const prevCenter = idx > 0 ? items[idx - 1].x + items[idx - 1].width / 2 : 0;
    const nextCenter = idx < items.length - 1
      ? items[idx + 1].x + items[idx + 1].width / 2
      : 1000;
    return {
      left: idx === 0 ? 0 : (prevCenter + myCenter) / 2,
      right: idx === items.length - 1 ? 1000 : (myCenter + nextCenter) / 2,
    };
  });

  // Semantic column detection — ORDER MATTERS: check 'سعر' BEFORE 'الوحدة'
  // because 'سعر الوحدة' contains both, and we want it to match cost, not unit.
  const colMap: ColumnMap = {
    rowNum: -1, name: -1, expiry: -1, unit: -1, qty: -1, cost: -1, total: -1,
  };

  for (let i = 0; i < colNames.length; i++) {
    const n = colNames[i];
    if (n === '#' || n === 'م' || n === 'ر' || n === 'الرقم' || n === 'رقم' || n === 'ت' ||
        /^S\/?N$/i.test(n) || /^No\.?$/i.test(n)) {
      colMap.rowNum = i;
    } else if (
      n.includes('الصنف') || n.includes('المنتج') || n.includes('اسم') ||
      n.includes('البيان') || n.includes('الوصف') ||
      n.includes('Product') || n.includes('Description') || n.includes('Item')
    ) {
      colMap.name = i;
    } else if (
      n.includes('Exp') || n.includes('exp') ||
      n.includes('تاريخ') || n.includes('الصلاحية') || n.includes('انتهاء')
    ) {
      colMap.expiry = i;
    } else if (
      n.includes('سعر') || n.includes('ثمن') ||
      n.includes('Price') || n.includes('Cost') || n.includes('cost')
    ) {
      // MUST check 'سعر' before 'الوحدة' — 'سعر الوحدة' includes both
      colMap.cost = i;
    } else if (
      n.includes('الوحدة') || n.includes('وحدة') ||
      n.includes('Unit') || n.includes('unit')
    ) {
      colMap.unit = i;
    } else if (
      n.includes('الكمية') || n.includes('كمية') || n.includes('العدد') ||
      n.includes('Qty') || n.includes('qty') || n.includes('Quantity') ||
      /QUANTIT/i.test(n)
    ) {
      colMap.qty = i;
    } else if (
      n.includes('الجملة') || n.includes('المبلغ') || n.includes('المجموع') ||
      n.includes('إجمالي') || n.includes('اجمالي') ||
      n.includes('Total') || n.includes('total') || n.includes('Amount')
    ) {
      colMap.total = i;
    }
    // Skip known non-data columns (HSN/SAC, Bonus, etc.) — no assignment needed
  }

  return { headerCenters, headerBounds, numCols: colNames.length, colMap };
}

// ---------------------------------------------------------------------------
// Column assignment (nearest center)
// ---------------------------------------------------------------------------

/**
 * Assign a text item to the column whose bounds contain the item's X position.
 *
 * Uses the item's left edge (x) as the primary anchor — this is more reliable
 * than center-matching for RTL text where pdfjs width values can be unreliable.
 *
 * Strategy:
 * 1. Check which column bound range contains the item's x position
 * 2. Fallback: nearest header center to item center
 */
function assignColumn(
  itemX: number,
  itemWidth: number,
  headerCenters: number[],
  headerBounds?: Array<{ left: number; right: number }>,
): number {
  // Primary: range-overlap using item's x position
  if (headerBounds) {
    for (let i = 0; i < headerBounds.length; i++) {
      if (itemX >= headerBounds[i].left && itemX < headerBounds[i].right) {
        return i;
      }
    }
  }

  // Fallback: nearest center
  const itemCenter = itemX + itemWidth / 2;
  let minDist = Infinity;
  let bestCol = 0;
  for (let i = 0; i < headerCenters.length; i++) {
    const dist = Math.abs(itemCenter - headerCenters[i]);
    if (dist < minDist) {
      minDist = dist;
      bestCol = i;
    }
  }
  return bestCol;
}

/**
 * Extract cell values from a row using nearest-center column assignment.
 *
 * Special handling for the row number (#) column: items assigned there that
 * are NOT pure integers get redirected to the name column. This is needed
 * because the name column is wide and some name text can be physically
 * closer to the # column header than to the name column header.
 */
function extractRowCells(
  row: TextRow,
  headerCenters: number[],
  numCols: number,
  colMap: ColumnMap,
  headerBounds?: Array<{ left: number; right: number }>,
): string[] {
  // Collect items per column with their X positions so we can sort by position later
  const colItems: Array<Array<{ str: string; x: number }>> = Array.from(
    { length: numCols },
    () => [],
  );

  for (const item of row.items) {
    let col = assignColumn(item.x, item.width, headerCenters, headerBounds);

    // Redirect non-integer items from the # column to the name column.
    // Check both Western and Arabic-Indic digits.
    if (col === colMap.rowNum && colMap.name >= 0 && !/^[\d٠-٩]+$/.test(item.str)) {
      col = colMap.name;
    }

    if (col < numCols) {
      colItems[col].push({ str: item.str, x: item.x });
    }
  }

  // Build cells: sort fragments within each cell by X position (left-to-right).
  // For the name column in RTL invoices, pdfjs delivers fragments in visual order
  // (left-to-right on screen) which is already the correct reading order for
  // mixed Arabic+English pharmaceutical names.
  const cells: string[] = colItems.map((fragments) => {
    if (fragments.length === 0) return '';
    fragments.sort((a, b) => a.x - b.x);
    return fragments.map((f) => f.str).join(' ');
  });

  return cells;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNumber(s: string): number {
  if (!s) return 0;
  const cleaned = normalizeNumberStr(s);
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function isFooterRow(row: TextRow): boolean {
  const text = row.items.map((i) => i.str).join(' ');
  const normalizedText = normalizeDigits(text);
  return (
    // Page indicators: "Page 1 of 6", "صفحة 1 من 6"
    /\bPage\s+\d/i.test(normalizedText) ||
    /صفحة\s*\d/.test(normalizedText) ||
    // Grand total / summary rows
    text.includes('الإجمالي') || text.includes('إجمالي') || text.includes('اجمالي') ||
    text.includes('المجموع الكلي') ||
    text.includes('Grand Total') ||
    // Net total / discount / tax rows (common in invoices below the item table)
    text.includes('الخصم') || text.includes('الضريبة') ||
    text.includes('Discount') || text.includes('Tax') ||
    text.includes('Net Total') || text.includes('صافي')
  );
}

/**
 * Check if a row is a "name-only" fragment — contains text only in the name column
 * and no recognizable data in numeric columns.
 */
function isNameFragment(
  row: TextRow,
  headerCenters: number[],
  numCols: number,
  colMap: ColumnMap,
  headerBounds?: Array<{ left: number; right: number }>,
  lastRowNum?: number,
): boolean {
  if (isHeaderRow(row) || isFooterRow(row)) return false;

  const cells = extractRowCells(row, headerCenters, numCols, colMap, headerBounds);

  // If it has a valid row number, it's a data row — but only if sequential
  if (colMap.rowNum >= 0) {
    const num = parseInt(normalizeDigits(cells[colMap.rowNum]), 10);
    if (!isNaN(num) && num > 0) {
      // If we know the expected sequence, only treat as data row if sequential
      if (lastRowNum == null || num === lastRowNum + 1 || num === 1) {
        return false;
      }
      // Out-of-sequence "row number" — likely a misassigned name fragment
    }
  }

  // If it has data in numeric columns (qty, cost, total), it's not a fragment
  if (colMap.qty >= 0 && parseNumber(cells[colMap.qty]) > 0) return false;
  if (colMap.cost >= 0 && parseNumber(cells[colMap.cost]) > 0) return false;
  if (colMap.total >= 0 && parseNumber(cells[colMap.total]) > 0) return false;

  // Has some text content
  return row.items.some((it) => it.str.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export async function parsePdfInvoice(buffer: ArrayBuffer): Promise<PdfInvoiceRow[]> {
  const allPagesData = await extractPageData(buffer);

  // --- Grid-first attempt ---
  try {
    const gridResults: PdfInvoiceRow[] = [];
    for (const pd of allPagesData) {
      // Use raw PDF coordinates (transform[4]) for grid mapping — grid cells
      // and rawX are in the same coordinate space, unlike the RTL-normalized x.
      const rawItems: GridTextItem[] = pd.textItems.map((it) => ({
        str: it.str, x: it.rawX, y: it.y, width: it.width,
      }));
      const gridResult = await tryGridParsePage(pd.page, rawItems);
      if (gridResult) {
        gridResults.push(...gridResult.rows);
      }
    }
    if (gridResults.length > 0) {
      console.log(`[pdf-import] Grid parse succeeded: ${gridResults.length} rows`);
      return gridResults;
    }
    console.log('[pdf-import] Grid parse found no rows, falling back to text-based');
  } catch (err) {
    console.warn('[pdf-import] Grid parse failed, falling back to text-based:', err);
  }

  // --- Fallback: text-based parsing (original approach) ---
  const allPages = allPagesData.map((pd) => pd.textItems);
  const results: PdfInvoiceRow[] = [];

  let headerCenters: number[] | null = null;
  let headerBounds: Array<{ left: number; right: number }> | null = null;
  let numCols = 0;
  let colMap: ColumnMap | null = null;

  for (const pageItems of allPages) {
    const rows = clusterIntoRows(pageItems);

    // Find header row on this page
    let headerFoundOnThisPage = false;
    let pageHeaderIdx = -1;

    for (let i = 0; i < rows.length; i++) {
      if (isHeaderRow(rows[i])) {
        const result = buildColumnMap(rows[i]);
        headerCenters = result.headerCenters;
        headerBounds = result.headerBounds;
        numCols = result.numCols;
        colMap = result.colMap;
        headerFoundOnThisPage = true;
        pageHeaderIdx = i;
        console.log('[pdf-import] Header detected:', rows[i].items.map(it => it.str).join(' | '));
        console.log('[pdf-import] Column map:', colMap);
        break;
      }
    }

    if (!headerCenters || !colMap) continue;

    const startIdx = headerFoundOnThisPage ? pageHeaderIdx + 1 : 0;

    // Process rows with lookahead for multi-line names
    let pendingNameFragments: string[] = [];
    let lastRowNum = 0;
    let i = startIdx;

    while (i < rows.length) {
      const row = rows[i];

      // Skip headers and footers
      if (isHeaderRow(row) || isFooterRow(row)) {
        i++;
        continue;
      }

      const cells = extractRowCells(row, headerCenters, numCols, colMap, headerBounds ?? undefined);

      // Check for row number (normalize Arabic-Indic digits → Western)
      const rowNumStr = colMap.rowNum >= 0 ? normalizeDigits(cells[colMap.rowNum]) : '';
      const rowNum = parseInt(rowNumStr, 10);

      // Sequential validation: real row numbers are sequential (1, 2, 3...).
      // A jump from e.g. 5 to 500 means a continuation line's text landed in the # column.
      const isSequential = rowNum === lastRowNum + 1 || (lastRowNum === 0 && rowNum >= 1);

      if (isNaN(rowNum) || rowNum <= 0 || !isSequential) {
        // No valid sequential row number → name fragment (prefix for next data row)
        const nameText = colMap.name >= 0 ? cells[colMap.name] : '';
        // Also collect any other text in the row (sometimes name overflows to adjacent columns)
        const allText = cells.filter((c) => c.trim()).join(' ');
        const fragment = nameText.trim() || allText.trim();
        if (fragment) {
          pendingNameFragments.push(fragment);
        }
        i++;
        continue;
      }

      // Data row with row number
      const rawName = colMap.name >= 0 ? cells[colMap.name] : '';
      const expiry = colMap.expiry >= 0 ? cells[colMap.expiry] : '';
      const unit = colMap.unit >= 0 ? cells[colMap.unit] : '';
      const qty = colMap.qty >= 0 ? parseNumber(cells[colMap.qty]) : 0;
      const cost = colMap.cost >= 0 ? parseNumber(cells[colMap.cost]) : 0;
      const total = colMap.total >= 0 ? parseNumber(cells[colMap.total]) : 0;

      // Build name: pending prefix fragments + current name
      const nameParts: string[] = [...pendingNameFragments];
      if (rawName.trim()) nameParts.push(rawName.trim());

      // Lookahead: collect trailing name fragments (immediately below, no row number)
      let j = i + 1;
      while (j < rows.length && isNameFragment(rows[j], headerCenters, numCols, colMap, headerBounds ?? undefined, lastRowNum)) {
        const fragCells = extractRowCells(rows[j], headerCenters, numCols, colMap, headerBounds ?? undefined);
        const fragText = colMap.name >= 0 ? fragCells[colMap.name].trim() : '';
        const allText = fragCells.filter((c) => c.trim()).join(' ').trim();
        if (fragText || allText) {
          nameParts.push(fragText || allText);
        }
        j++;
      }

      pendingNameFragments = [];

      const fullName = nameParts.join(' ').trim();
      if (!fullName) {
        i = j;
        continue;
      }

      console.log(`[pdf-import] Row ${rowNum}: name="${fullName}" qty=${qty} cost=${cost}`);

      results.push({
        rowNumber: rowNum,
        name: fullName,
        expiryDate: expiry.trim(),
        unit: unit.trim(),
        quantity: qty,
        costPerUnit: cost,
        lineTotal: total,
      });

      lastRowNum = rowNum;
      i = j; // Skip past any trailing fragments we consumed
    }
  }

  if (results.length === 0 && !headerCenters) {
    throw new Error('Could not find invoice table header in PDF. Expected columns: الصنف, Exp Date');
  }

  console.log(`[pdf-import] Extracted ${results.length} product rows`);
  return results;
}

// ---------------------------------------------------------------------------
// Invoice metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract invoice-level metadata from pre-header/footer rows.
 *
 * Scans for:
 *  - التاريخ / Date    → purchaseDate
 *  - رقم الفاتورة / Invoice # → invoiceReference
 *  - اجمالي / Total    → totalDebt
 *  - Vendor name        → vendorName (first large-text row at top)
 */
function extractMetadata(allPages: TextItem[][]): PdfInvoiceMetadata {
  const meta: PdfInvoiceMetadata = {
    purchaseDate: null,
    invoiceReference: null,
    totalDebt: null,
    vendorName: null,
  };

  if (allPages.length === 0) return meta;

  // Scan all pages for metadata (usually in page 1 header or last page footer)
  for (const pageItems of allPages) {
    const rows = clusterIntoRows(pageItems);

    for (const row of rows) {
      const text = row.items.map(i => i.str).join(' ');
      const normalizedText = normalizeDigits(text);

      // ─── Date ──────────────────────────────────────────────────
      if (!meta.purchaseDate) {
        // Look for "التاريخ" or "Date" followed by a date-like value
        const datePatterns = [
          /التاريخ\s*[:\s]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
          /Date\s*[:\s]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
          // Also try YYYY-MM-DD format
          /التاريخ\s*[:\s]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/,
          /Date\s*[:\s]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/i,
        ];
        for (const pat of datePatterns) {
          const m = normalizedText.match(pat);
          if (m) {
            const raw = m[1];
            // Detect if YYYY-first or DD-first
            if (/^\d{4}/.test(raw)) {
              meta.purchaseDate = raw.replace(/\//g, '-');
            } else {
              meta.purchaseDate = convertDateFormat(raw);
            }
            break;
          }
        }
      }

      // ─── Invoice reference ─────────────────────────────────────
      if (!meta.invoiceReference) {
        const refPatterns = [
          /رقم\s*الفاتورة\s*[:\s]\s*([^\s]+)/,
          /فاتورة\s*(?:رقم|#|مبيعات)\s*[:\s]*\s*([^\s]+)/,
          /Invoice\s*(?:#|No\.?|Number)\s*[:\s]*\s*([^\s]+)/i,
          // "رقم" followed by a number (common in Arabic invoices: "آجل رقم 4884")
          /(?:آجل|نقد|نقدي)\s+رقم\s+(\d+)/,
          /رقم\s+(\d{3,})/,
        ];
        for (const pat of refPatterns) {
          const m = normalizedText.match(pat);
          if (m) {
            meta.invoiceReference = m[1].trim();
            break;
          }
        }
      }

      // ─── Total debt ────────────────────────────────────────────
      if (meta.totalDebt === null) {
        const totalPatterns = [
          /(?:اجمالي|إجمالي|المجموع|الإجمالي)\s*(?:المبلغ\s*المطلوب|الفاتورة)?\s*[:\s]\s*([\d,٬.٫]+)/,
          /(?:Grand\s*)?Total\s*(?:Due|Amount)?\s*[:\s]\s*([\d,٬.٫]+)/i,
        ];
        for (const pat of totalPatterns) {
          const m = normalizedText.match(pat);
          if (m) {
            const val = parseNumber(m[1]);
            if (val > 0) {
              meta.totalDebt = Math.round(val);
              break;
            }
          }
        }
      }

      // ─── Vendor name ──────────────────────────────────────────
      // Take the first non-header, non-date, non-total row near the top of page 1
      // that has significant text (likely the vendor/company name)
      if (!meta.vendorName && pageItems === allPages[0]) {
        // Only consider first few rows (top of document)
        const rowIdx = rows.indexOf(row);
        if (rowIdx < 5) {
          const combined = text.trim();
          // Skip if it looks like a date, ref, or total line
          const isDataLine = /التاريخ|Date|رقم|Invoice|اجمالي|إجمالي|Total|فاتورة/i.test(combined);
          // Skip very short text or pure numbers
          if (!isDataLine && combined.length > 3 && !/^[\d\s,.٬٫]+$/.test(combined)) {
            meta.vendorName = combined;
          }
        }
      }
    }
  }

  return meta;
}

/**
 * Parse a PDF invoice and return both metadata and items.
 *
 * This is the main entry point for the purchase import flow. Returns:
 * - `metadata`: Invoice-level fields (date, reference, total, vendor)
 * - `items`: Line items extracted from the table
 */
export async function parsePdfInvoiceFull(buffer: ArrayBuffer): Promise<PdfInvoiceResult> {
  const allPagesData = await extractPageData(buffer);
  const allPages = allPagesData.map((pd) => pd.textItems);

  // Extract metadata from all pages
  const metadata = extractMetadata(allPages);

  // --- Grid-first attempt for items ---
  try {
    const gridItems: PdfInvoiceRow[] = [];
    for (const pd of allPagesData) {
      // Use raw PDF coordinates (transform[4]) for grid mapping
      const rawItems: GridTextItem[] = pd.textItems.map((it) => ({
        str: it.str, x: it.rawX, y: it.y, width: it.width,
      }));
      const gridResult = await tryGridParsePage(pd.page, rawItems);
      if (gridResult) {
        gridItems.push(...gridResult.rows);
      }
    }
    if (gridItems.length > 0) {
      console.log(`[pdf-import] Grid parse succeeded: ${gridItems.length} items, metadata:`, metadata);
      return { metadata, items: gridItems };
    }
    console.log('[pdf-import] Grid parse found no items, falling back to text-based');
  } catch (err) {
    console.warn('[pdf-import] Grid parse failed, falling back to text-based:', err);
  }

  // --- Fallback: text-based parsing (original approach) ---
  const items: PdfInvoiceRow[] = [];

  let headerCenters: number[] | null = null;
  let headerBounds: Array<{ left: number; right: number }> | null = null;
  let numCols = 0;
  let colMap: ColumnMap | null = null;

  for (const pageItems of allPages) {
    const rows = clusterIntoRows(pageItems);

    let headerFoundOnThisPage = false;
    let pageHeaderIdx = -1;

    for (let i = 0; i < rows.length; i++) {
      if (isHeaderRow(rows[i])) {
        const result = buildColumnMap(rows[i]);
        headerCenters = result.headerCenters;
        headerBounds = result.headerBounds;
        numCols = result.numCols;
        colMap = result.colMap;
        headerFoundOnThisPage = true;
        pageHeaderIdx = i;
        console.log('[pdf-import] Header detected:', rows[i].items.map(it => it.str).join(' | '));
        console.log('[pdf-import] Column map:', colMap);
        console.log('[pdf-import] Header bounds:', headerBounds.map((b, idx) =>
          `col${idx}: [${b.left.toFixed(0)}-${b.right.toFixed(0)}]`).join(', '));
        break;
      }
    }

    if (!headerCenters || !colMap) continue;

    const startIdx = headerFoundOnThisPage ? pageHeaderIdx + 1 : 0;

    let pendingNameFragments: string[] = [];
    let lastRowNum = 0;
    let i = startIdx;

    while (i < rows.length) {
      const row = rows[i];

      if (isHeaderRow(row) || isFooterRow(row)) {
        i++;
        continue;
      }

      const cells = extractRowCells(row, headerCenters, numCols, colMap, headerBounds ?? undefined);

      const rowNumStr = colMap.rowNum >= 0 ? normalizeDigits(cells[colMap.rowNum]) : '';
      const rowNum = parseInt(rowNumStr, 10);

      // Sequential validation: real row numbers are sequential (1, 2, 3...).
      const isSequential = rowNum === lastRowNum + 1 || (lastRowNum === 0 && rowNum >= 1);

      if (isNaN(rowNum) || rowNum <= 0 || !isSequential) {
        const nameText = colMap.name >= 0 ? cells[colMap.name] : '';
        const allText = cells.filter((c) => c.trim()).join(' ');
        const fragment = nameText.trim() || allText.trim();
        if (fragment) {
          pendingNameFragments.push(fragment);
        }
        i++;
        continue;
      }

      const rawName = colMap.name >= 0 ? cells[colMap.name] : '';
      const expiry = colMap.expiry >= 0 ? cells[colMap.expiry] : '';
      const unit = colMap.unit >= 0 ? cells[colMap.unit] : '';
      const qty = colMap.qty >= 0 ? parseNumber(cells[colMap.qty]) : 0;
      const cost = colMap.cost >= 0 ? parseNumber(cells[colMap.cost]) : 0;
      const total = colMap.total >= 0 ? parseNumber(cells[colMap.total]) : 0;

      const nameParts: string[] = [...pendingNameFragments];
      if (rawName.trim()) nameParts.push(rawName.trim());

      let j = i + 1;
      while (j < rows.length && isNameFragment(rows[j], headerCenters, numCols, colMap, headerBounds ?? undefined, lastRowNum)) {
        const fragCells = extractRowCells(rows[j], headerCenters, numCols, colMap, headerBounds ?? undefined);
        const fragText = colMap.name >= 0 ? fragCells[colMap.name].trim() : '';
        const allText = fragCells.filter((c) => c.trim()).join(' ').trim();
        if (fragText || allText) {
          nameParts.push(fragText || allText);
        }
        j++;
      }

      pendingNameFragments = [];

      const fullName = nameParts.join(' ').trim();
      if (!fullName) {
        i = j;
        continue;
      }

      console.log(`[pdf-import] Row ${rowNum}: name="${fullName}" qty=${qty} cost=${cost}`);

      items.push({
        rowNumber: rowNum,
        name: fullName,
        expiryDate: expiry.trim(),
        unit: unit.trim(),
        quantity: qty,
        costPerUnit: cost,
        lineTotal: total,
      });

      lastRowNum = rowNum;
      i = j;
    }
  }

  if (items.length === 0 && !headerCenters) {
    throw new Error('Could not find invoice table header in PDF. Expected columns: الصنف, Exp Date');
  }

  console.log(`[pdf-import] Full parse: ${items.length} items, metadata:`, metadata);
  return { metadata, items };
}
