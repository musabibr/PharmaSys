/**
 * Shared product import / export / template column schema.
 *
 * This is the SINGLE SOURCE OF TRUTH for the columns used by:
 *   - ProductExportDialog  (export current products + their batches)
 *   - ProductImportDialog / BulkImportDialog  ("Download Template" + parsing)
 *
 * Because export, template, and import all derive their headers from the same
 * list, a file exported (or templated) by the app re-imports cleanly — the
 * header text matches exactly, so no column-mapping guesswork is needed.
 *
 * Product-level columns describe the product; batch-level columns describe a
 * single stock batch (cost / expiry / quantity). The export emits ONE ROW PER
 * BATCH so cost & expiry round-trip; products with no active batch get a single
 * row with blank batch fields.
 */

import type { Product, Batch } from '@/api/types';

export type ColumnLevel = 'product' | 'batch';

export interface IeColumn {
  /** Stable identifier used internally (not shown to the user). */
  id: string;
  /** Exact Excel header text (English). Used verbatim for export + template,
   *  and as the primary key for exact-match import resolution. */
  header: string;
  /** Lowercased substrings used as a fallback when an exact header match is not
   *  found (covers hand-made files, including a few Arabic aliases). */
  keywords: string[];
  level: ColumnLevel;
  /** Whether the column is required (cannot be deselected in the export UI). */
  required?: boolean;
  /** Cell value for a given product (+ optional batch) when exporting. */
  exportValue: (p: Product, b?: Batch) => string | number;
}

/** Whole parent units in a base-unit quantity (e.g. 105 strips @ cf 10 → 10 boxes).
 *  Paired with {@link baseToSmallRemainder} so export splits cleanly into two
 *  columns and re-imports exactly: `base = parentWhole * cf + smallRemainder`. */
export function baseToParentWhole(quantityBase: number, conversionFactor: number): number {
  const cf = conversionFactor > 0 ? conversionFactor : 1;
  return Math.floor(quantityBase / cf);
}

/** Leftover small units after taking whole parents (e.g. 105 @ cf 10 → 5). */
export function baseToSmallRemainder(quantityBase: number, conversionFactor: number): number {
  const cf = conversionFactor > 0 ? conversionFactor : 1;
  return quantityBase % cf;
}

export const PRODUCT_IE_COLUMNS: IeColumn[] = [
  {
    id: 'name', header: 'Product Name', level: 'product', required: true,
    keywords: ['product name', 'product', 'اسم المنتج', 'الاسم', 'اسم'],
    exportValue: (p) => p.name ?? '',
  },
  {
    id: 'generic_name', header: 'Generic Name', level: 'product',
    keywords: ['generic', 'الاسم العلمي', 'علمي'],
    exportValue: (p) => p.generic_name ?? '',
  },
  {
    id: 'category', header: 'Category', level: 'product',
    keywords: ['category', 'الفئة', 'التصنيف', 'فئة'],
    exportValue: (p) => p.category_name ?? '',
  },
  {
    id: 'barcode', header: 'Barcode', level: 'product',
    keywords: ['barcode', 'الباركود', 'باركود'],
    exportValue: (p) => p.barcode ?? '',
  },
  {
    id: 'parent_unit', header: 'Base Unit', level: 'product',
    keywords: ['base unit', 'base_unit', 'parent unit', 'parent_unit', 'الوحدة الكبيرة', 'وحدة كبيرة'],
    exportValue: (p) => p.parent_unit ?? '',
  },
  {
    id: 'child_unit', header: 'Small Unit', level: 'product',
    keywords: ['small unit', 'small_unit', 'child unit', 'child_unit', 'الوحدة الصغيرة', 'وحدة صغيرة'],
    exportValue: (p) => p.child_unit ?? '',
  },
  {
    id: 'conversion_factor', header: 'Conv Factor', level: 'product',
    keywords: ['conv', 'conversion', 'معامل التحويل', 'معامل'],
    exportValue: (p) => p.conversion_factor ?? 1,
  },
  {
    id: 'min_stock_level', header: 'Min Stock Level', level: 'product',
    keywords: ['min stock', 'min_stock', 'الحد الأدنى', 'حد أدنى'],
    exportValue: (p) => p.min_stock_level ?? 0,
  },
  {
    id: 'batch_number', header: 'Batch Number', level: 'batch',
    keywords: ['batch', 'رقم التشغيلة', 'تشغيلة', 'دفعة'],
    exportValue: (_p, b) => b?.batch_number ?? '',
  },
  {
    id: 'expiry_date', header: 'Expiry Date (YYYY-MM-DD)', level: 'batch',
    keywords: ['expiry', 'exp', 'تاريخ الانتهاء', 'انتهاء', 'الصلاحية', 'صلاحية'],
    exportValue: (_p, b) => b?.expiry_date ?? '',
  },
  {
    id: 'quantity', header: 'Qty (Parent Units)', level: 'batch',
    keywords: ['qty (parent', 'qty parent', 'quantity (parent', 'parent units', 'qty', 'quantity', 'الكمية (وحدات كبيرة)', 'الكمية', 'كمية'],
    exportValue: (p, b) => (b ? baseToParentWhole(b.quantity_base, b.conversion_factor ?? p.conversion_factor ?? 1) : ''),
  },
  {
    id: 'quantity_small', header: 'Qty (Small Units)', level: 'batch',
    keywords: ['qty (small', 'qty small', 'quantity (small', 'small units', 'الكمية (وحدات صغيرة)', 'كمية صغيرة'],
    exportValue: (p, b) => (b ? baseToSmallRemainder(b.quantity_base, b.conversion_factor ?? p.conversion_factor ?? 1) : ''),
  },
  {
    id: 'cost_per_parent', header: 'Cost per Parent Unit (SDG)', level: 'batch',
    keywords: ['cost', 'التكلفة', 'تكلفة', 'سعر الشراء'],
    exportValue: (_p, b) => (b ? b.cost_per_parent : ''),
  },
  {
    id: 'selling_price_parent', header: 'Sell Price per Parent Unit (SDG)', level: 'batch',
    // Note: 'sell price'/'selling price' also appear in the small-unit header, so
    // exact-header match (handled by resolveImportRow) disambiguates the two.
    keywords: ['sell price per parent', 'selling price per parent', 'sell price', 'selling price', 'sell_price', 'selling_price', 'سعر بيع الوحدة الكبيرة', 'سعر البيع'],
    exportValue: (p, b) => b?.selling_price_parent ?? p.selling_price ?? '',
  },
  {
    id: 'selling_price_child', header: 'Sell Price per Small Unit (SDG)', level: 'batch',
    keywords: ['sell price per small', 'selling price per small', 'small unit price', 'small price', 'sell price child', 'sell_price_child', 'small sell', 'سعر بيع الوحدة الصغيرة', 'سعر القطعة'],
    exportValue: (p, b) => b?.selling_price_child ?? p.selling_price_child ?? '',
  },
  {
    id: 'usage_instructions', header: 'Usage Instructions', level: 'product',
    keywords: ['usage', 'instructions', 'directions', 'تعليمات الاستخدام', 'الاستخدام', 'تعليمات'],
    exportValue: (p) => p.usage_instructions ?? '',
  },
];

const COLS_BY_ID: Record<string, IeColumn> = Object.fromEntries(
  PRODUCT_IE_COLUMNS.map((c) => [c.id, c]),
);

export function getColumn(id: string): IeColumn | undefined {
  return COLS_BY_ID[id];
}

/** Exact header labels in canonical order — used for export + template headers. */
export const TEMPLATE_HEADERS: string[] = PRODUCT_IE_COLUMNS.map((c) => c.header);

/** A filled example row for the downloadable template, in column order. */
export const TEMPLATE_EXAMPLE_ROW: Array<string | number> = [
  'Paracetamol 500mg', // Product Name
  'Paracetamol',       // Generic Name
  'Analgesics',        // Category
  '1234567890123',     // Barcode
  'Box',               // Base Unit
  'Strip',             // Small Unit
  10,                  // Conv Factor
  5,                   // Min Stock Level
  'B001',              // Batch Number
  '2027-06-30',        // Expiry Date
  50,                  // Qty (Parent Units)
  5,                   // Qty (Small Units)
  1200,                // Cost per Parent Unit
  1500,                // Sell Price per Parent Unit
  150,                 // Sell Price per Small Unit
  'Take as directed',  // Usage Instructions
];

/**
 * Resolve a raw spreadsheet row (object keyed by header text, as returned by
 * XLSX.utils.sheet_to_json) into a map keyed by column id.
 *
 * Two passes, each claiming a header so no header feeds two columns:
 *   1. Exact header match (case-insensitive, trimmed) — guarantees that files
 *      produced by the app's own export/template map perfectly.
 *   2. Keyword substring fallback — for hand-made or translated files.
 */
export function resolveImportRow(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(raw);
  const claimed = new Set<string>();
  const result: Record<string, unknown> = {};

  // Pass 1 — exact header match.
  for (const col of PRODUCT_IE_COLUMNS) {
    const k = keys.find(
      (key) => !claimed.has(key) && key.trim().toLowerCase() === col.header.toLowerCase(),
    );
    if (k !== undefined) {
      result[col.id] = raw[k];
      claimed.add(k);
    }
  }

  // Pass 2 — keyword substring fallback on still-unclaimed headers.
  for (const col of PRODUCT_IE_COLUMNS) {
    if (col.id in result) continue;
    const k = keys.find(
      (key) => !claimed.has(key) && col.keywords.some((w) => key.toLowerCase().includes(w)),
    );
    if (k !== undefined) {
      result[col.id] = raw[k];
      claimed.add(k);
    }
  }

  return result;
}
