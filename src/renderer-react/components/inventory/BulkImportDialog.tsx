import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { api } from '@/api';
import { invalidateProducts } from '@/stores/products.store';
import { TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROW, resolveImportRow } from './productIeSchema';
import { useSettingsStore } from '@/stores/settings.store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Upload,
  Download,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  FileSpreadsheet,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

// Template columns + example row come from the shared import/export schema
// (productIeSchema.ts) so the template, export, and both import dialogs all use
// identical headers.

// ---------------------------------------------------------------------------
// Parsed row type
// ---------------------------------------------------------------------------

interface ParsedRow {
  rowIndex: number;
  name: string;
  genericName: string;
  category: string;
  barcode: string;
  parentUnit: string;
  childUnit: string;
  convFactor: number;
  minStock: number;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  quantitySmall: number;
  costPerParent: number;
  sellPricePerParent: number;
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Import result type
// ---------------------------------------------------------------------------

interface ImportResult {
  created: number;
  errors: Array<{ row?: number; message?: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  return !isNaN(d.getTime());
}

function isPastDate(dateStr: string): boolean {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Normalize a spreadsheet date value to YYYY-MM-DD. Handles JS Date objects,
 * Excel serial numbers, ISO strings, and common DD/MM/YYYY or M/D/YYYY inputs.
 */
function normalizeDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    return `${val.getFullYear()}-${pad2(val.getMonth() + 1)}-${pad2(val.getDate())}`;
  }
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{5}$/.test(s)) {
    const d = new Date((Number(s) - 25569) * 86400 * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad2(Number(iso[2]))}-${pad2(Number(iso[3]))}`;
  const dmy = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (dmy) {
    const [, a, b, y] = dmy;
    let yr = Number(y);
    if (yr < 100) yr += 2000;
    const first = Number(a);
    const second = Number(b);
    const day = first > 12 ? first : (second > 12 ? second : first);
    const month = first > 12 ? second : (second > 12 ? first : second);
    return `${yr}-${pad2(month)}-${pad2(day)}`;
  }
  return s;
}

function toStr(val: unknown): string {
  if (val == null) return '';
  return String(val).trim();
}

function toInt(val: unknown, fallback = 0): number {
  if (val == null || val === '') return fallback;
  const n = parseInt(String(val), 10);
  return isNaN(n) ? fallback : n;
}

/** Float-capable parser for quantity (preserves fractional parent units). */
function toNum(val: unknown, fallback = 0): number {
  if (val == null || val === '') return fallback;
  const n = parseFloat(String(val));
  return isNaN(n) ? fallback : n;
}

/**
 * Map a raw row object (from sheet_to_json) into a ParsedRow.
 * Column matching is case-insensitive and flexible.
 */
function mapRow(
  raw: Record<string, unknown>,
  rowIndex: number,
  t: (key: string) => string
): ParsedRow {
  const errors: string[] = [];
  const cell = resolveImportRow(raw);

  const name = toStr(cell.name);
  const genericName = toStr(cell.generic_name);
  const category = toStr(cell.category);
  const barcode = toStr(cell.barcode);
  const parentUnit = toStr(cell.parent_unit) || 'Unit';
  const childUnit = toStr(cell.child_unit);
  const convFactor = toInt(cell.conversion_factor, 1);
  const minStock = toInt(cell.min_stock_level, 0);
  const batchNumber = toStr(cell.batch_number);
  const expiryDate = normalizeDate(cell.expiry_date);
  const quantity = toNum(cell.quantity, 0);
  const quantitySmall = toInt(cell.quantity_small, 0);
  const costPerParent = toNum(cell.cost_per_parent, 0);
  const sellPricePerParent = toInt(cell.selling_price_parent, 0);

  if (!name) {
    errors.push(t('Product name is required'));
  }

  if (convFactor < 1) {
    errors.push(t('Conversion factor must be at least 1'));
  }

  if (convFactor > 1 && !childUnit) {
    errors.push(t('Small unit is required when conversion factor > 1'));
  }

  // Only require batch details when the row actually carries stock (qty > 0).
  // Mirrors the backend, which creates a batch only when quantity_base > 0 and
  // an expiry date is present — partial fields no longer fail the whole row.
  const hasStock = quantity > 0 || quantitySmall > 0;

  if (hasStock) {
    if (!expiryDate) {
      errors.push(t('Expiry date is required for stock'));
    } else if (!isValidDate(expiryDate)) {
      errors.push(t('Invalid date format (use YYYY-MM-DD)'));
    } else if (isPastDate(expiryDate)) {
      errors.push(t('Expiry date is in the past'));
    }

    if (costPerParent <= 0) {
      errors.push(t('Cost is required for stock'));
    }
  }

  return {
    rowIndex,
    name,
    genericName,
    category,
    barcode,
    parentUnit,
    childUnit,
    convFactor,
    minStock,
    batchNumber,
    expiryDate,
    quantity,
    quantitySmall,
    costPerParent,
    sellPricePerParent,
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// BulkImportDialog
// ---------------------------------------------------------------------------

export function BulkImportDialog({ open, onOpenChange, onImported }: BulkImportDialogProps) {
  const { t } = useTranslation();
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- State ----
  const [step, setStep] = useState<'upload' | 'preview'>('upload');
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Pagination
  const [currentPage, setCurrentPage] = useState(0);

  // ---- Reset ----
  const resetState = useCallback(() => {
    setStep('upload');
    setFileName('');
    setParsedRows([]);
    setImporting(false);
    setImportResult(null);
    setDragOver(false);
    setCurrentPage(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ---- Open change handler ----
  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) resetState();
    onOpenChange(isOpen);
  }

  // ---- Download template ----
  function handleDownloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROW]);
    ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(h.length + 2, 15) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Products');
    XLSX.writeFile(wb, 'pharmasys-import-template.xlsx');
  }

  // ---- Process Excel file ----
  async function processExcelFile(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) {
        toast.error(t('No worksheet found in the file'));
        return;
      }
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      if (rawRows.length === 0) {
        toast.error(t('No data rows found in file'));
        return;
      }
      const rows = rawRows.map((raw, i) => mapRow(raw, i + 1, t));
      setParsedRows(rows);
      setFileName(file.name);
      setCurrentPage(0);
      setStep('preview');
    } catch {
      toast.error(t('Failed to read file. Make sure it is a valid Excel file.'));
    }
  }

  // ---- File input handler ----
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processExcelFile(file);
  }

  // ---- Drag & drop handlers ----
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const ext = file.name.toLowerCase().split('.').pop();
      if (ext === 'xlsx' || ext === 'xls') {
        processExcelFile(file);
      } else {
        toast.error(t('Please upload an Excel file (.xlsx or .xls)'));
      }
    }
  }

  // ---- Import ----
  async function handleImport() {
    const validRows = parsedRows.filter((r) => r.valid);
    if (validRows.length === 0) {
      toast.error(t('No valid rows to import'));
      return;
    }

    setImporting(true);
    setImportResult(null);

    try {
      const items = validRows.map((row) => ({
        name: row.name,
        generic_name: row.genericName || undefined,
        category_name: row.category || undefined,
        barcode: row.barcode || undefined,
        parent_unit: row.parentUnit || 'Unit',
        child_unit: row.childUnit || undefined,
        conversion_factor: row.convFactor,
        min_stock_level: row.minStock,
        batch_number: row.batchNumber || undefined,
        expiry_date: row.expiryDate,
        quantity_base: Math.round(row.quantity * row.convFactor) + row.quantitySmall,
        cost_per_parent: row.costPerParent,
        selling_price_parent: row.sellPricePerParent || Math.round(row.costPerParent * (1 + defaultMarkup / 100)),
      }));

      const raw = await api.products.bulkCreate(items);
      invalidateProducts();
      // API returns Array<{success, name, error?}> — normalize to {created, errors}
      const rawArr = Array.isArray(raw) ? raw : (raw as any).data ?? [];
      const created = rawArr.filter((r: any) => r.success).length;
      const errors = rawArr
        .map((r: any, i: number) => r.success ? null : { row: i + 1, message: r.error ?? r.name ?? 'Unknown error' })
        .filter(Boolean) as ImportResult['errors'];

      setImportResult({ created, errors });

      if (created > 0) {
        toast.success(
          t('Successfully imported {{count}} products', { count: created })
        );
        onImported();
        // Auto-close if all rows succeeded (no errors to review)
        if (errors.length === 0) {
          handleOpenChange(false);
          return;
        }
      }

      if (errors.length > 0) {
        toast.warning(
          t('{{count}} rows had errors', { count: errors.length })
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  // ---- Derived ----
  const validCount = parsedRows.filter((r) => r.valid).length;
  const invalidCount = parsedRows.filter((r) => !r.valid).length;

  // Pagination
  const totalPages = Math.max(1, Math.ceil(parsedRows.length / PAGE_SIZE));
  const pageRows = parsedRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  // ---- Render ----
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {t('Bulk Import Products')}
          </DialogTitle>
          <DialogDescription>
            {step === 'upload'
              ? t('Upload an Excel file (.xlsx) or download the template to get started.')
              : t('Review parsed data below. Fix any errors and import valid rows.')}
          </DialogDescription>
        </DialogHeader>

        {/* ---- Step 1: Upload ---- */}
        {step === 'upload' && (
          <div className="flex flex-1 flex-col gap-4 overflow-hidden">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                <Download className="me-1.5 h-4 w-4" />
                {t('Download Template')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('Supported formats')}: .xlsx, .xls
              </span>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-1 min-h-[200px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors ${
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
              }`}
            >
              <Upload className={`h-10 w-10 ${dragOver ? 'text-primary' : 'text-muted-foreground/40'}`} />
              <div className="text-center">
                <p className="text-sm font-medium">
                  {t('Drop Excel file here or click to browse')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Supported formats')}: .xlsx, .xls
                </p>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
            />

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('Cancel')}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ---- Step 2: Preview ---- */}
        {step === 'preview' && (
          <div className="flex flex-1 flex-col gap-4 overflow-hidden min-h-0">
            {/* Summary badges */}
            <div className="flex items-center gap-3">
              {fileName && (
                <Badge variant="outline">
                  <FileSpreadsheet className="me-1 h-3 w-3" />
                  {fileName}
                </Badge>
              )}
              <Badge variant="secondary">
                {t('Total')}: {parsedRows.length}
              </Badge>
              <Badge variant="success">
                <CheckCircle2 className="me-1 h-3 w-3" />
                {t('Valid')}: {validCount}
              </Badge>
              {invalidCount > 0 && (
                <Badge variant="destructive">
                  <XCircle className="me-1 h-3 w-3" />
                  {t('Errors')}: {invalidCount}
                </Badge>
              )}
            </div>

            {/* Import result message */}
            {importResult && (
              <div className="rounded-lg border bg-muted/50 p-3 text-sm">
                <p className="font-medium">
                  {t('Import complete')}: {importResult.created} {t('created')}
                  {importResult.errors.length > 0 &&
                    `, ${importResult.errors.length} ${t('errors')}`}
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="mt-2 list-inside list-disc space-y-0.5 text-destructive">
                    {importResult.errors.map((err, i) => (
                      <li key={i}>
                        {err.row != null && `${t('Row')} ${err.row}: `}
                        {err.message || err.error || t('Unknown error')}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Preview table */}
            <ScrollArea className="flex-1 min-h-0 rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead className="w-12">{t('Status')}</TableHead>
                    <TableHead>{t('Product Name')}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t('Category')}</TableHead>
                    <TableHead>{t('Base Unit')}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t('Batch #')}</TableHead>
                    <TableHead>{t('Expiry Date')}</TableHead>
                    <TableHead className="text-end">{t('Qty')}</TableHead>
                    <TableHead className="text-end">{t('Cost')}</TableHead>
                    <TableHead className="text-end">{t('Sell')}</TableHead>
                    <TableHead>{t('Errors')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow
                      key={row.rowIndex}
                      className={row.valid ? '' : 'bg-destructive/5'}
                    >
                      <TableCell className="text-muted-foreground">
                        {row.rowIndex}
                      </TableCell>
                      <TableCell>
                        {row.valid ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive" />
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{row.name || '---'}</TableCell>
                      <TableCell className="hidden xl:table-cell">{row.category || '---'}</TableCell>
                      <TableCell>{row.parentUnit}</TableCell>
                      <TableCell className="hidden xl:table-cell">{row.batchNumber || '---'}</TableCell>
                      <TableCell>{row.expiryDate || '---'}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {row.quantity > 0 || row.quantitySmall > 0
                          ? `${row.quantity || 0}${row.quantitySmall > 0 ? ` + ${row.quantitySmall}` : ''}`
                          : '---'}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {row.costPerParent || '---'}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {row.sellPricePerParent || '---'}
                      </TableCell>
                      <TableCell>
                        {row.errors.length > 0 && (
                          <span className="text-xs text-destructive">
                            {row.errors.join('; ')}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex shrink-0 items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t('Page {{page}} of {{total}}', { page: currentPage + 1, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={currentPage >= totalPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setStep('upload');
                  setImportResult(null);
                  setParsedRows([]);
                  setFileName('');
                  setCurrentPage(0);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                disabled={importing}
              >
                <ArrowLeft className="me-1.5 h-4 w-4" />
                {t('Back')}
              </Button>
              <Button
                onClick={handleImport}
                disabled={importing || validCount === 0 || importResult !== null}
              >
                {importing ? (
                  <>
                    <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                    {t('Importing...')}
                  </>
                ) : (
                  <>
                    <Upload className="me-1.5 h-4 w-4" />
                    {t('Import All')} ({validCount})
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
