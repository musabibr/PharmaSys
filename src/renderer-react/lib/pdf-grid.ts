/**
 * Grid-based PDF table extraction using pdfjs operator list.
 *
 * Instead of guessing column positions from text X-coordinates, this module
 * extracts the actual drawn table borders (lines/rectangles) from the PDF's
 * operator list. The resulting grid cells provide exact boundaries, making
 * column assignment trivial and RTL-agnostic.
 *
 * Exported for use by pdf-import.ts as a "grid-first, text-fallback" strategy.
 */

// ---------------------------------------------------------------------------
// pdfjs OPS / DrawOPS constants (from pdfjs-dist v5.5.207)
// ---------------------------------------------------------------------------

/** Operator IDs from the pdfjs operator list (fnArray values). */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  constructPath: 91,
} as const;

/** Sub-path drawing operations encoded inside the constructPath Float32Array. */
const DrawOPS = {
  moveTo: 0,
  lineTo: 1,
  curveTo: 2,
  quadraticCurveTo: 3,
  closePath: 4,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A line segment extracted from drawing commands. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A single cell in the detected grid. */
export interface GridCell {
  row: number;
  col: number;
  x: number;      // left edge
  y: number;      // bottom edge (PDF coordinates: Y goes up)
  w: number;
  h: number;
}

/** A row of string cell values extracted from the grid. */
export interface GridRow {
  rowIndex: number;
  cells: string[];
  /** Average Y of this row (for debugging). */
  y: number;
}

/** Text item — same shape as in pdf-import.ts. */
export interface GridTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

// ---------------------------------------------------------------------------
// Step 1: Extract line segments from operator list
// ---------------------------------------------------------------------------

/**
 * Apply a 2D affine transform matrix to a point.
 * Matrix format: [a, b, c, d, e, f] where:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
function applyTransform(x: number, y: number, m: number[]): [number, number] {
  return [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
}

/** Multiply two 2D affine matrices. */
function multiplyMatrix(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const IDENTITY: number[] = [1, 0, 0, 1, 0, 0];

/**
 * Extract horizontal and vertical line segments from a pdfjs page's operator list.
 * These segments represent table borders drawn by the PDF.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractSegments(page: any): Promise<Segment[]> {
  const opList = await page.getOperatorList();
  const fnArray: number[] = opList.fnArray;
  const argsArray: unknown[] = opList.argsArray;

  const segments: Segment[] = [];
  const matrixStack: number[][] = [];
  let currentMatrix = [...IDENTITY];

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = argsArray[i] as any;

    // Track graphics state transforms
    if (op === OPS.save) {
      matrixStack.push([...currentMatrix]);
      continue;
    }
    if (op === OPS.restore) {
      currentMatrix = matrixStack.pop() ?? [...IDENTITY];
      continue;
    }
    if (op === OPS.transform) {
      // args is a Float32Array [a, b, c, d, e, f]
      const m = Array.from(args as ArrayLike<number>);
      currentMatrix = multiplyMatrix(currentMatrix, m);
      continue;
    }

    // Only process constructPath
    if (op !== OPS.constructPath) continue;

    // args[0] = terminating op (stroke/fill/etc.)
    // args[1] = [Float32Array pathBuffer | null]
    // args[2] = Float32Array minMax | null
    const terminatingOp = args[0] as number;
    const pathBufArr = args[1] as (Float32Array | null)[];
    const pathBuf = pathBufArr?.[0];

    if (!pathBuf || pathBuf.length === 0) continue;

    // We mainly care about stroked paths (actual visible lines).
    // Also accept fillStroke for combined border+fill patterns.
    const isStroke =
      terminatingOp === OPS.stroke ||
      terminatingOp === OPS.closeStroke ||
      terminatingOp === OPS.fillStroke ||
      terminatingOp === OPS.closeFillStroke;

    // Also accept thin filled rectangles (some PDFs draw borders as filled rects)
    const isFill =
      terminatingOp === OPS.fill ||
      terminatingOp === OPS.eoFill;

    if (!isStroke && !isFill) continue;

    // Parse DrawOPS path buffer
    let curX = 0, curY = 0;
    let moveX = 0, moveY = 0;
    let j = 0;

    const rawSegs: Segment[] = [];

    while (j < pathBuf.length) {
      const drawOp = pathBuf[j];

      if (drawOp === DrawOPS.moveTo) {
        curX = pathBuf[j + 1];
        curY = pathBuf[j + 2];
        moveX = curX;
        moveY = curY;
        j += 3;
      } else if (drawOp === DrawOPS.lineTo) {
        const nx = pathBuf[j + 1];
        const ny = pathBuf[j + 2];
        rawSegs.push({ x1: curX, y1: curY, x2: nx, y2: ny });
        curX = nx;
        curY = ny;
        j += 3;
      } else if (drawOp === DrawOPS.curveTo) {
        // Skip curves (not table borders) — advance past 6 args
        curX = pathBuf[j + 5];
        curY = pathBuf[j + 6];
        j += 7;
      } else if (drawOp === DrawOPS.quadraticCurveTo) {
        curX = pathBuf[j + 3];
        curY = pathBuf[j + 4];
        j += 5;
      } else if (drawOp === DrawOPS.closePath) {
        // Close to the moveTo point
        if (curX !== moveX || curY !== moveY) {
          rawSegs.push({ x1: curX, y1: curY, x2: moveX, y2: moveY });
        }
        curX = moveX;
        curY = moveY;
        j += 1;
      } else {
        // Unknown op — skip
        j += 1;
      }
    }

    // For filled rectangles, filter to only thin ones (likely borders)
    if (isFill && !isStroke) {
      const bbox = args[2] as Float32Array | null;
      if (bbox) {
        const bw = Math.abs(bbox[2] - bbox[0]);
        const bh = Math.abs(bbox[3] - bbox[1]);
        // Only keep if it looks like a line (one dimension very thin)
        if (Math.min(bw, bh) > 3) continue;
      }
    }

    // Apply current transform and filter to horizontal/vertical segments
    for (const seg of rawSegs) {
      const [tx1, ty1] = applyTransform(seg.x1, seg.y1, currentMatrix);
      const [tx2, ty2] = applyTransform(seg.x2, seg.y2, currentMatrix);

      const dx = Math.abs(tx2 - tx1);
      const dy = Math.abs(ty2 - ty1);

      // Keep only horizontal (dy < 1.5) or vertical (dx < 1.5) segments
      // that have meaningful length (> 5 units)
      if (dy < 1.5 && dx > 5) {
        // Horizontal segment
        segments.push({
          x1: Math.min(tx1, tx2), y1: (ty1 + ty2) / 2,
          x2: Math.max(tx1, tx2), y2: (ty1 + ty2) / 2,
        });
      } else if (dx < 1.5 && dy > 5) {
        // Vertical segment
        segments.push({
          x1: (tx1 + tx2) / 2, y1: Math.min(ty1, ty2),
          x2: (tx1 + tx2) / 2, y2: Math.max(ty1, ty2),
        });
      }
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Step 2: Build grid from segments
// ---------------------------------------------------------------------------

/** Deduplicate values within tolerance, returning sorted unique values. */
function dedup(values: number[], tolerance: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const result: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - result[result.length - 1] > tolerance) {
      result.push(sorted[i]);
    } else {
      // Average the cluster
      result[result.length - 1] = (result[result.length - 1] + sorted[i]) / 2;
    }
  }
  return result;
}

/**
 * Build a table grid from extracted segments.
 *
 * Returns grid cells if a valid table is detected, or `null` if the segments
 * don't form a recognizable table (fewer than 3 columns or 2 rows).
 */
export function buildGrid(segments: Segment[], tolerance = 2): GridCell[] | null {
  if (segments.length === 0) return null;

  // Classify segments
  const hSegments: Segment[] = []; // horizontal
  const vSegments: Segment[] = []; // vertical

  for (const seg of segments) {
    if (Math.abs(seg.y1 - seg.y2) < 1.5) {
      hSegments.push(seg);
    } else if (Math.abs(seg.x1 - seg.x2) < 1.5) {
      vSegments.push(seg);
    }
  }

  // Collect boundary values
  const xValues: number[] = [];
  for (const seg of vSegments) {
    xValues.push(seg.x1); // x1 ≈ x2 for vertical
  }

  const yValues: number[] = [];
  for (const seg of hSegments) {
    yValues.push(seg.y1); // y1 ≈ y2 for horizontal
  }

  // Deduplicate
  const xBounds = dedup(xValues, tolerance);
  const yBounds = dedup(yValues, tolerance);

  // Need at least 3 column boundaries (= 2 columns) and 3 row boundaries (= 2 rows)
  // But for a real table: at least 4 columns (3 boundaries) and 2 rows (3 boundaries)
  if (xBounds.length < 4 || yBounds.length < 3) {
    console.log(`[pdf-grid] Not enough boundaries: ${xBounds.length} X, ${yBounds.length} Y`);
    return null;
  }

  // Sort Y descending (PDF: Y goes up, so top row = largest Y)
  yBounds.sort((a, b) => b - a);
  // X already ascending from dedup

  const numCols = xBounds.length - 1;
  const numRows = yBounds.length - 1;
  const cells: GridCell[] = [];

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      cells.push({
        row: r,
        col: c,
        x: xBounds[c],
        y: yBounds[r + 1], // bottom edge (smaller Y)
        w: xBounds[c + 1] - xBounds[c],
        h: yBounds[r] - yBounds[r + 1], // top - bottom
      });
    }
  }

  console.log(`[pdf-grid] Grid detected: ${numRows} rows × ${numCols} cols`);
  return cells;
}

// ---------------------------------------------------------------------------
// Step 3: Map text items to grid cells
// ---------------------------------------------------------------------------

/**
 * Map text items into grid cells.
 *
 * For each text item, finds the grid cell that contains the item's center point.
 * All text in the same cell is concatenated (handling multi-line names naturally).
 *
 * Returns rows of string cell values, sorted top-to-bottom.
 */
export function mapTextToGrid(
  textItems: GridTextItem[],
  cells: GridCell[],
  numCols: number,
  numRows: number,
): GridRow[] {
  // Index cells by (row, col) for fast lookup
  const cellMap = new Map<string, GridCell>();
  for (const cell of cells) {
    cellMap.set(`${cell.row},${cell.col}`, cell);
  }

  // Accumulate text per cell
  const cellTexts = new Map<string, Array<{ str: string; x: number; y: number }>>();

  // Pre-compute row Y ranges and column X ranges for faster lookup
  const rowYRanges: Array<{ row: number; yMin: number; yMax: number }> = [];
  const colXRanges: Array<{ col: number; xMin: number; xMax: number }> = [];
  for (let r = 0; r < numRows; r++) {
    const cell0 = cellMap.get(`${r},0`);
    if (cell0) rowYRanges.push({ row: r, yMin: cell0.y, yMax: cell0.y + cell0.h });
  }
  for (let c = 0; c < numCols; c++) {
    const cell0 = cellMap.get(`0,${c}`);
    if (cell0) colXRanges.push({ col: c, xMin: cell0.x, xMax: cell0.x + cell0.w });
  }

  for (const item of textItems) {
    // Use item.x directly (raw transform[4] from pdfjs).
    // For RTL text this is the right edge, for LTR the left edge.
    const cx = item.x;
    const cy = item.y;

    // Step 1: Find which ROW this item belongs to (Y is reliable)
    let bestRow = -1;
    let bestRowDist = Infinity;
    const yTol = 3; // tolerance for Y matching
    for (const rr of rowYRanges) {
      if (cy >= rr.yMin - yTol && cy <= rr.yMax + yTol) {
        bestRow = rr.row;
        break;
      }
      const rowMid = (rr.yMin + rr.yMax) / 2;
      const dist = Math.abs(cy - rowMid);
      if (dist < bestRowDist) {
        bestRowDist = dist;
        bestRow = rr.row;
      }
    }
    if (bestRow < 0) continue;
    // Only use fallback row if reasonably close
    const matchedRowRange = rowYRanges.find((r) => r.row === bestRow);
    if (matchedRowRange) {
      const inY = cy >= matchedRowRange.yMin - yTol && cy <= matchedRowRange.yMax + yTol;
      if (!inY && bestRowDist > (matchedRowRange.yMax - matchedRowRange.yMin)) continue;
    }

    // Step 2: Find which COLUMN — nearest column center (robust for RTL/LTR)
    let bestCol = -1;
    let bestColDist = Infinity;
    for (const cr of colXRanges) {
      const colMid = (cr.xMin + cr.xMax) / 2;
      const dist = Math.abs(cx - colMid);
      if (dist < bestColDist) {
        bestColDist = dist;
        bestCol = cr.col;
      }
    }
    if (bestCol < 0) continue;

    const key = `${bestRow},${bestCol}`;
    const arr = cellTexts.get(key) ?? [];
    arr.push({ str: item.str, x: item.x, y: item.y });
    cellTexts.set(key, arr);
  }

  // Build grid rows
  const rows: GridRow[] = [];

  for (let r = 0; r < numRows; r++) {
    const cellValues: string[] = [];
    let rowY = 0;
    let yCount = 0;

    for (let c = 0; c < numCols; c++) {
      const key = `${r},${c}`;
      const fragments = cellTexts.get(key);
      if (!fragments || fragments.length === 0) {
        cellValues.push('');
        continue;
      }

      // Sort fragments: first by Y descending (top to bottom in PDF coords),
      // then by X ascending within same line
      fragments.sort((a, b) => {
        const yDiff = b.y - a.y; // descending Y = top first
        if (Math.abs(yDiff) > 2) return yDiff;
        return a.x - b.x; // left to right within same line
      });

      cellValues.push(fragments.map((f) => f.str).join(' ').trim());

      for (const f of fragments) {
        rowY += f.y;
        yCount++;
      }
    }

    // Skip completely empty rows
    if (cellValues.every((v) => !v)) continue;

    rows.push({
      rowIndex: r,
      cells: cellValues,
      y: yCount > 0 ? rowY / yCount : 0,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Step 4: Identify columns from header row
// ---------------------------------------------------------------------------

/** Header keyword patterns for each semantic column. */
const HEADER_KEYWORDS: Record<string, string[]> = {
  rowNum: ['#', 'م', 'ر', 'الرقم', 'رقم', 'ت', 'S/N', 'No'],
  name: ['الصنف', 'المنتج', 'اسم', 'البيان', 'الوصف', 'Product', 'Description', 'Item'],
  expiry: ['Exp', 'exp', 'EXPIRE', 'تاريخ', 'الصلاحية', 'انتهاء'],
  cost: ['سعر', 'ثمن', 'Price', 'Cost', 'cost', 'السعر'],
  unit: ['الوحدة', 'وحدة', 'Unit', 'unit', 'UNIT'],
  qty: ['الكمية', 'كمية', 'العدد', 'Qty', 'qty', 'Quantity', 'QUANTIT'],
  total: ['الجملة', 'المبلغ', 'المجموع', 'إجمالي', 'اجمالي', 'الاجمالي', 'Total', 'total', 'Amount'],
};

/** Column map — same shape as in pdf-import.ts. */
export interface GridColumnMap {
  rowNum: number;
  name: number;
  expiry: number;
  unit: number;
  qty: number;
  cost: number;
  total: number;
}

/**
 * Check if a grid row is a header row (contains product + date/unit/qty keywords).
 */
function isGridHeaderRow(cells: string[]): boolean {
  const text = cells.join(' ');
  const hasProduct = HEADER_KEYWORDS.name.some((kw) => text.includes(kw));
  const hasDate = HEADER_KEYWORDS.expiry.some((kw) => text.includes(kw));
  const hasUnit = HEADER_KEYWORDS.unit.some((kw) => text.includes(kw));
  const hasQty = HEADER_KEYWORDS.qty.some((kw) => text.includes(kw));
  return hasProduct && (hasDate || hasUnit || hasQty);
}

/**
 * Identify the header row and build a semantic column map.
 *
 * Returns the header row index and column map, or `null` if no header is found.
 */
export function identifyColumns(
  gridRows: GridRow[],
): { headerIdx: number; colMap: GridColumnMap; numCols: number } | null {
  for (let i = 0; i < Math.min(gridRows.length, 5); i++) {
    const row = gridRows[i];
    if (!isGridHeaderRow(row.cells)) continue;

    const colMap: GridColumnMap = {
      rowNum: -1, name: -1, expiry: -1, unit: -1, qty: -1, cost: -1, total: -1,
    };

    for (let c = 0; c < row.cells.length; c++) {
      const cellText = row.cells[c];
      if (!cellText) continue;

      // ORDER MATTERS: check cost ('سعر') BEFORE unit ('الوحدة')
      // because 'سعر الوحدة' contains both.
      if (colMap.rowNum < 0 && HEADER_KEYWORDS.rowNum.some((kw) => cellText === kw || cellText.includes(kw))) {
        colMap.rowNum = c;
      } else if (colMap.name < 0 && HEADER_KEYWORDS.name.some((kw) => cellText.includes(kw))) {
        colMap.name = c;
      } else if (colMap.expiry < 0 && HEADER_KEYWORDS.expiry.some((kw) => cellText.includes(kw))) {
        colMap.expiry = c;
      } else if (colMap.cost < 0 && HEADER_KEYWORDS.cost.some((kw) => cellText.includes(kw))) {
        colMap.cost = c;
      } else if (colMap.unit < 0 && HEADER_KEYWORDS.unit.some((kw) => cellText.includes(kw))) {
        colMap.unit = c;
      } else if (colMap.qty < 0 && HEADER_KEYWORDS.qty.some((kw) => cellText.includes(kw))) {
        colMap.qty = c;
      } else if (colMap.total < 0 && HEADER_KEYWORDS.total.some((kw) => cellText.includes(kw))) {
        colMap.total = c;
      }
    }

    // Must have at least a name column
    if (colMap.name < 0) continue;

    console.log(`[pdf-grid] Header found at row ${i}:`, row.cells, colMap);
    return { headerIdx: i, colMap, numCols: row.cells.length };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Step 5: Full grid parse — combines all steps
// ---------------------------------------------------------------------------

/** Footer keywords to skip summary/total rows. */
const FOOTER_KEYWORDS = [
  'الإجمالي', 'إجمالي', 'اجمالي', 'المجموع الكلي',
  'Grand Total', 'الخصم', 'الضريبة', 'Discount', 'Tax',
  'Net Total', 'صافي', 'Page', 'صفحة',
];

function isGridFooterRow(cells: string[]): boolean {
  const text = cells.join(' ');
  return FOOTER_KEYWORDS.some((kw) => text.includes(kw));
}

/** Arabic-Indic digit normalization (same as pdf-import.ts). */
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
}

function normalizeNumberStr(s: string): string {
  let out = normalizeDigits(s.trim());
  out = out.replace(/٫/g, '.');
  out = out.replace(/[٬,]/g, '');
  return out;
}

function parseGridNumber(s: string): number {
  if (!s) return 0;
  const cleaned = normalizeNumberStr(s);
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

export interface GridParseResult {
  rows: Array<{
    rowNumber: number;
    name: string;
    expiryDate: string;
    unit: string;
    quantity: number;
    costPerUnit: number;
    lineTotal: number;
  }>;
  /** Number of grid columns detected. */
  numCols: number;
}

/**
 * Attempt to parse items from a single page using grid-based extraction.
 *
 * @param page - pdfjs PDFPageProxy
 * @param textItems - pre-extracted text items for this page
 * @returns parsed rows or null if grid extraction fails
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryGridParsePage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  textItems: GridTextItem[],
): Promise<GridParseResult | null> {
  // Step 1: Extract line segments
  const segments = await extractSegments(page);
  if (segments.length < 10) {
    console.log(`[pdf-grid] Only ${segments.length} segments — not enough for a table`);
    return null;
  }

  // Step 2: Build grid
  const cells = buildGrid(segments);
  if (!cells || cells.length === 0) return null;

  // Compute grid dimensions
  const numRows = Math.max(...cells.map((c) => c.row)) + 1;
  const numCols = Math.max(...cells.map((c) => c.col)) + 1;

  // Step 3: Map text to grid
  const gridRows = mapTextToGrid(textItems, cells, numCols, numRows);
  if (gridRows.length < 2) {
    console.log(`[pdf-grid] Only ${gridRows.length} non-empty rows`);
    return null;
  }

  // Step 4: Identify columns
  const colResult = identifyColumns(gridRows);
  if (!colResult) {
    console.log('[pdf-grid] Could not identify header columns');
    return null;
  }

  const { headerIdx, colMap } = colResult;

  // Step 5: Parse data rows
  const results: GridParseResult['rows'] = [];
  let autoRowNum = 1;

  for (let i = headerIdx + 1; i < gridRows.length; i++) {
    const row = gridRows[i];

    // Skip footer/summary rows
    if (isGridFooterRow(row.cells)) continue;

    const name = colMap.name >= 0 ? row.cells[colMap.name]?.trim() || '' : '';
    if (!name) continue; // skip empty rows

    const rowNumStr = colMap.rowNum >= 0 ? normalizeDigits(row.cells[colMap.rowNum] || '') : '';
    const rowNum = parseInt(rowNumStr, 10);
    const validRowNum = !isNaN(rowNum) && rowNum > 0 ? rowNum : autoRowNum;

    const expiry = colMap.expiry >= 0 ? row.cells[colMap.expiry]?.trim() || '' : '';
    const unit = colMap.unit >= 0 ? row.cells[colMap.unit]?.trim() || '' : '';
    const qty = colMap.qty >= 0 ? parseGridNumber(row.cells[colMap.qty] || '') : 0;
    const cost = colMap.cost >= 0 ? parseGridNumber(row.cells[colMap.cost] || '') : 0;
    const total = colMap.total >= 0 ? parseGridNumber(row.cells[colMap.total] || '') : 0;

    console.log(`[pdf-grid] Row ${validRowNum}: name="${name}" qty=${qty} cost=${cost}`);

    results.push({
      rowNumber: validRowNum,
      name,
      expiryDate: expiry,
      unit,
      quantity: qty,
      costPerUnit: cost,
      lineTotal: total || qty * cost,
    });

    autoRowNum = validRowNum + 1;
  }

  if (results.length === 0) return null;

  return { rows: results, numCols };
}
