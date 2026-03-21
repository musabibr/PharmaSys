import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { api } from '@/api';
import type { Purchase, Product, Supplier, CreatePurchaseItemInput } from '@/api/types';
import { useSettingsStore } from '@/stores/settings.store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Upload, ArrowLeft, ArrowRight, CheckCircle2, XCircle,
  FileSpreadsheet, Loader2, ChevronLeft, ChevronRight, Link2, Plus, RefreshCw, PlusCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProductImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

type ImportMode = 'create' | 'update';

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
  costPerParent: number;
  sellPricePerParent: number;
  sellPriceChild: number;
  // Match detection
  matchedProductId: number | null;
  matchedProductName: string | null;
  // Per-row import mode — only 'update' if matchedProductId != null
  importMode: ImportMode;
  // Selection & validity
  selected: boolean;
  valid: boolean;
  errors: string[];
}

interface ImportResult {
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

type Step = 'options' | 'preview' | 'importing';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  return !isNaN(d.getTime());
}

function normalizeDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const s = String(val).trim();
  if (/^\d{5}$/.test(s)) {
    const d = new Date((Number(s) - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
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

function mapRow(
  raw: Record<string, unknown>,
  rowIndex: number,
  t: (key: string) => string,
  existingProducts: Product[],
  defaultUpdateMode: boolean,
): ParsedRow {
  const errors: string[] = [];
  const get = (keywords: string[]): unknown => {
    for (const key of Object.keys(raw)) {
      const lower = key.toLowerCase();
      if (keywords.some(kw => lower.includes(kw))) return raw[key];
    }
    return undefined;
  };

  const name               = toStr(get(['product name', 'product']));
  const genericName        = toStr(get(['generic']));
  const category           = toStr(get(['category']));
  const barcode            = toStr(get(['barcode']));
  const parentUnit         = toStr(get(['base unit', 'base_unit', 'parent unit', 'parent_unit'])) || 'Unit';
  const childUnit          = toStr(get(['small unit', 'small_unit', 'child unit', 'child_unit']));
  const convFactor         = toInt(get(['conv', 'conversion']), 1);
  const minStock           = toInt(get(['min stock', 'min_stock']), 0);
  const batchNumber        = toStr(get(['batch']));
  const expiryDate         = normalizeDate(get(['expiry', 'exp']));
  const quantity           = toInt(get(['qty', 'quantity']), 0);
  const costPerParent      = toInt(get(['cost']), 0);
  const sellPricePerParent = toInt(get(['sell price', 'selling price', 'sell_price', 'selling_price']), 0);
  const sellPriceChild     = toInt(get(['sell price child', 'sell_price_child', 'small sell', 'small price']), 0);

  if (!name)          errors.push(t('Product name is required'));
  if (convFactor < 1) errors.push(t('Conversion factor must be at least 1'));
  if (convFactor > 1 && !childUnit) errors.push(t('Small unit is required when conversion factor > 1'));

  const hasBatchFields = batchNumber || expiryDate || quantity > 0 || costPerParent > 0;
  if (hasBatchFields) {
    if (!expiryDate) {
      errors.push(t('Expiry date is required'));
    } else if (!isValidDate(expiryDate)) {
      errors.push(t('Invalid date format (use YYYY-MM-DD)'));
    }
    if (quantity <= 0) errors.push(t('Quantity must be greater than 0'));
    if (costPerParent <= 0) errors.push(t('Cost must be greater than 0'));
  }

  // Match against existing products
  let matchedProductId: number | null = null;
  let matchedProductName: string | null = null;
  if (existingProducts.length > 0 && name) {
    const match = barcode
      ? existingProducts.find(p => p.barcode && p.barcode === barcode)
      : existingProducts.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (match) {
      matchedProductId = match.id;
      matchedProductName = match.name;
    }
  }

  const importMode: ImportMode = matchedProductId !== null && defaultUpdateMode ? 'update' : 'create';

  return {
    rowIndex, name, genericName, category, barcode, parentUnit, childUnit,
    convFactor, minStock, batchNumber, expiryDate, quantity, costPerParent,
    sellPricePerParent, sellPriceChild,
    matchedProductId, matchedProductName, importMode,
    selected: errors.length === 0,
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProductImportDialog({ open, onOpenChange, onImported }: ProductImportDialogProps) {
  const { t } = useTranslation();
  const getSetting    = useSettingsStore(s => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;
  const fileInputRef  = useRef<HTMLInputElement>(null);

  const [step, setStep]                     = useState<Step>('options');
  const [fileName, setFileName]             = useState('');
  const [updateExistingDefault, setUpdateExistingDefault] = useState(true);
  // 'none' | 'new' | '{id}' (existing purchase id)
  const [assignPurchaseId, setAssignPurchaseId] = useState<string>('none');
  const [purchases, setPurchases]           = useState<Purchase[]>([]);
  const [suppliers, setSuppliers]           = useState<Supplier[]>([]);
  const [loadingPurchases, setLoadingPurchases] = useState(false);
  // New-invoice fields
  const [newInvSupplierId, setNewInvSupplierId] = useState<string>('none');
  const [newInvRef, setNewInvRef]           = useState('');
  const [newInvDate, setNewInvDate]         = useState(new Date().toISOString().slice(0, 10));
  const [dragOver, setDragOver]             = useState(false);
  const [parsedRows, setParsedRows]         = useState<ParsedRow[]>([]);
  const [existingProducts, setExistingProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [currentPage, setCurrentPage]       = useState(0);
  const [importResult, setImportResult]     = useState<ImportResult | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importTotal, setImportTotal]       = useState(0);

  // ── Reset ──────────────────────────────────────────────────────────────────
  const resetState = useCallback(() => {
    setStep('options');
    setFileName('');
    setUpdateExistingDefault(true);
    setAssignPurchaseId('none');
    setNewInvSupplierId('none');
    setNewInvRef('');
    setNewInvDate(new Date().toISOString().slice(0, 10));
    setParsedRows([]);
    setCurrentPage(0);
    setImportResult(null);
    setImportProgress(0);
    setImportTotal(0);
    setDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) resetState();
    onOpenChange(isOpen);
  }

  // Load purchases + products when dialog opens
  useEffect(() => {
    if (!open) return;
    setLoadingPurchases(true);
    api.purchases.getAll({ limit: 100, payment_status_exclude: 'paid' } as Record<string, unknown>)
      .then(r => setPurchases(Array.isArray(r.data) ? r.data : []))
      .catch(() => setPurchases([]))
      .finally(() => setLoadingPurchases(false));

    api.suppliers.getAll()
      .then(s => setSuppliers(Array.isArray(s) ? s : []))
      .catch(() => setSuppliers([]));

    setLoadingProducts(true);
    api.products.getAll()
      .then(products => setExistingProducts(Array.isArray(products) ? products : []))
      .catch(() => setExistingProducts([]))
      .finally(() => setLoadingProducts(false));
  }, [open]);

  // Re-run matching when updateExistingDefault changes
  useEffect(() => {
    if (parsedRows.length === 0) return;
    setParsedRows(prev => prev.map(row => {
      const newMode: ImportMode = row.matchedProductId !== null && updateExistingDefault ? 'update' : 'create';
      return { ...row, importMode: newMode };
    }));
  }, [updateExistingDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── File parsing ────────────────────────────────────────────────────────────
  async function processFile(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) { toast.error(t('No worksheet found in the file')); return; }
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      if (rawRows.length === 0) { toast.error(t('No data rows found in file')); return; }
      const rows = rawRows.map((raw, i) => mapRow(raw, i + 1, t, existingProducts, updateExistingDefault));
      setParsedRows(rows);
      setFileName(file.name);
      setCurrentPage(0);
      setStep('preview');
    } catch {
      toast.error(t('Failed to read file. Make sure it is a valid Excel file.'));
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  function handleDragOver(e: React.DragEvent)  { e.preventDefault(); e.stopPropagation(); setDragOver(true); }
  function handleDragLeave(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setDragOver(false); }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const ext = file.name.toLowerCase().split('.').pop();
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        processFile(file);
      } else {
        toast.error(t('Please upload an Excel or CSV file'));
      }
    }
  }

  // ── Row toggles ─────────────────────────────────────────────────────────────
  const toggleRow = (rowIndex: number) => {
    setParsedRows(prev => prev.map(r =>
      r.rowIndex === rowIndex ? { ...r, selected: !r.selected } : r
    ));
  };

  const setRowMode = (rowIndex: number, mode: ImportMode) => {
    setParsedRows(prev => prev.map(r =>
      r.rowIndex === rowIndex ? { ...r, importMode: mode } : r
    ));
  };

  const selectAllValid = () => setParsedRows(prev => prev.map(r => ({ ...r, selected: r.valid })));
  const deselectAll    = () => setParsedRows(prev => prev.map(r => ({ ...r, selected: false })));

  const setAllMatchedMode = (mode: ImportMode) => {
    setParsedRows(prev => prev.map(r =>
      r.matchedProductId !== null ? { ...r, importMode: mode } : r
    ));
  };

  // ── Import ───────────────────────────────────────────────────────────────────
  async function handleImport() {
    const selectedRows = parsedRows.filter(r => r.selected);
    if (selectedRows.length === 0) { toast.error(t('No rows selected')); return; }

    setStep('importing');
    setImportTotal(selectedRows.length);
    setImportProgress(0);

    let created = 0;
    let updated = 0;
    let failed  = 0;
    const errors: string[] = [];

    let currentExisting = [...existingProducts];

    const purchaseItems: CreatePurchaseItemInput[] = [];

    for (let i = 0; i < selectedRows.length; i++) {
      const row = selectedRows[i];
      setImportProgress(i + 1);

      try {
        let productId: number | undefined;

        if (row.importMode === 'update' && row.matchedProductId !== null) {
          // ── Update existing product ──────────────────────────────────────────
          await api.products.update(row.matchedProductId, {
            generic_name:        row.genericName       || undefined,
            min_stock_level:     row.minStock          || undefined,
            selling_price:       row.sellPricePerParent || undefined,
            selling_price_child: row.sellPriceChild    || undefined,
          });
          productId = row.matchedProductId;
          updated++;

          // Add batch if cost/expiry/qty provided
          if (row.expiryDate && row.quantity > 0 && row.costPerParent > 0) {
            await api.batches.create({
              product_id:           row.matchedProductId,
              batch_number:         row.batchNumber         || undefined,
              expiry_date:          row.expiryDate,
              quantity_base:        row.quantity * row.convFactor,
              cost_per_parent:      row.costPerParent,
              selling_price_parent: row.sellPricePerParent ||
                Math.round(row.costPerParent * (1 + defaultMarkup / 100)),
              selling_price_child:  row.sellPriceChild      || undefined,
              status: 'active' as const,
            } as Parameters<typeof api.batches.create>[0]);
          }

        } else {
          // ── Create new product ────────────────────────────────────────────────
          const result = await api.products.bulkCreate([{
            name:                 row.name,
            generic_name:         row.genericName    || undefined,
            category_name:        row.category       || undefined,
            barcode:              row.barcode         || undefined,
            parent_unit:          row.parentUnit      || 'Unit',
            child_unit:           row.childUnit       || undefined,
            conversion_factor:    row.convFactor,
            min_stock_level:      row.minStock,
            batch_number:         row.batchNumber     || undefined,
            expiry_date:          row.expiryDate,
            quantity_base:        row.quantity * row.convFactor,
            cost_per_parent:      row.costPerParent,
            selling_price_parent: row.sellPricePerParent ||
              Math.round(row.costPerParent * (1 + defaultMarkup / 100)),
          }]);
          const arr   = Array.isArray(result) ? result : (result as { data?: unknown[] }).data ?? [];
          const first = arr[0] as { success?: boolean; id?: number; error?: string } | undefined;
          if (first?.success && first.id) {
            productId = first.id;
            created++;
            // Refresh local cache for subsequent dedup
            const fresh = await api.products.getAll().catch(() => currentExisting);
            currentExisting = Array.isArray(fresh) ? fresh : currentExisting;
          } else {
            failed++;
            errors.push(`Row ${row.rowIndex}: ${first?.error ?? t('Unknown error')}`);
            continue;
          }
        }

        // Collect for purchase link
        if (productId && assignPurchaseId !== 'none' && row.expiryDate && row.quantity > 0 && row.costPerParent > 0) {
          purchaseItems.push({
            product_id:           productId,
            quantity:             row.quantity,
            cost_per_parent:      row.costPerParent,
            selling_price_parent: row.sellPricePerParent ||
              Math.round(row.costPerParent * (1 + defaultMarkup / 100)),
            selling_price_child:  row.sellPriceChild || undefined,
            expiry_date:          row.expiryDate,
            batch_number:         row.batchNumber    || undefined,
          });
        }
      } catch (err: unknown) {
        failed++;
        errors.push(`Row ${row.rowIndex}: ${err instanceof Error ? err.message : t('Unknown error')}`);
      }
    }

    // Link to purchase or create new invoice
    if (purchaseItems.length > 0) {
      if (assignPurchaseId === 'new') {
        // Create a new invoice with all purchase items
        const total = purchaseItems.reduce((s, it) => s + it.cost_per_parent * it.quantity, 0);
        try {
          await api.purchases.create({
            purchase_date:     newInvDate,
            supplier_id:       newInvSupplierId !== 'none' ? Number(newInvSupplierId) : undefined,
            invoice_reference: newInvRef || undefined,
            total_amount:      total,
            items:             purchaseItems,
            payment_plan: { type: 'full' },
          });
        } catch (err: unknown) {
          errors.push(t('Failed to create new invoice: {{msg}}', {
            msg: err instanceof Error ? err.message : t('Unknown error'),
          }));
        }
      } else if (assignPurchaseId !== 'none') {
        // Add to existing invoice
        try {
          await api.purchases.addItems(Number(assignPurchaseId), { items: purchaseItems });
        } catch (err: unknown) {
          errors.push(t('Failed to link items to purchase: {{msg}}', {
            msg: err instanceof Error ? err.message : t('Unknown error'),
          }));
        }
      }
    }

    setImportResult({ created, updated, failed, errors });

    if (created > 0 || updated > 0) {
      toast.success(t('Import complete: {{c}} created, {{u}} updated', { c: created, u: updated }));
      onImported();
    }
    if (failed > 0) toast.warning(t('{{count}} rows failed', { count: failed }));
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const selectedCount  = parsedRows.filter(r => r.selected).length;
  const validCount     = parsedRows.filter(r => r.valid).length;
  const invalidCount   = parsedRows.filter(r => !r.valid).length;
  const matchedCount   = parsedRows.filter(r => r.matchedProductId !== null).length;
  const updateCount    = parsedRows.filter(r => r.selected && r.importMode === 'update').length;
  const createCount    = parsedRows.filter(r => r.selected && r.importMode === 'create').length;
  const totalPages     = Math.max(1, Math.ceil(parsedRows.length / PAGE_SIZE));
  const pageRows       = parsedRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              {t('Smart Import Products')}
            </DialogTitle>
            <DialogDescription>
              {step === 'options'   && t('Upload an Excel file and configure import options.')}
              {step === 'preview'   && t('Review and assign an import action to each row, then confirm.')}
              {step === 'importing' && t('Importing products...')}
            </DialogDescription>
          </DialogHeader>

          {/* ─── Step 1: Options ───────────────────────────────────────────── */}
          {step === 'options' && (
            <div className="flex flex-1 flex-col gap-4 overflow-hidden">
              <div className="space-y-4 rounded-lg border p-4">
                {/* Default mode for matched products */}
                <div>
                  <p className="text-sm font-medium mb-2">{t('Default action for matched products')}</p>
                  <div className="flex gap-3">
                    <label className={cn(
                      'flex flex-1 items-start gap-3 cursor-pointer rounded-md border p-3 transition-colors',
                      !updateExistingDefault ? 'border-primary bg-primary/5' : 'border-muted hover:border-muted-foreground/40',
                    )}>
                      <input
                        type="radio"
                        name="updateMode"
                        checked={!updateExistingDefault}
                        onChange={() => setUpdateExistingDefault(false)}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          <Plus className="h-3.5 w-3.5" />
                          {t('Always Create New')}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t('Ignore existing products — always add as new.')}
                        </p>
                      </div>
                    </label>
                    <label className={cn(
                      'flex flex-1 items-start gap-3 cursor-pointer rounded-md border p-3 transition-colors',
                      updateExistingDefault ? 'border-primary bg-primary/5' : 'border-muted hover:border-muted-foreground/40',
                    )}>
                      <input
                        type="radio"
                        name="updateMode"
                        checked={updateExistingDefault}
                        onChange={() => setUpdateExistingDefault(true)}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          <RefreshCw className="h-3.5 w-3.5" />
                          {t('Update Matched Products')}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t('Match by barcode → name. Updates prices and adds new batch. You can override per-row.')}
                        </p>
                      </div>
                    </label>
                  </div>
                  {loadingProducts && (
                    <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t('Loading product catalogue for matching...')}
                    </p>
                  )}
                  {!loadingProducts && existingProducts.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('{{n}} products in catalogue ready for matching', { n: existingProducts.length })}
                    </p>
                  )}
                </div>

                {/* Purchase assignment */}
                <div className="space-y-2">
                  <Label className="text-sm">{t('Invoice / Purchase (optional)')}</Label>
                  <Select value={assignPurchaseId} onValueChange={setAssignPurchaseId} disabled={loadingPurchases}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('Select...')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('None — do not link to an invoice')}</SelectItem>
                      <SelectItem value="new">
                        <span className="flex items-center gap-1.5 text-primary font-medium">
                          <PlusCircle className="h-3.5 w-3.5" />
                          {t('Create New Invoice from Import')}
                        </span>
                      </SelectItem>
                      {purchases.length > 0 && (
                        <>
                          <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
                            {t('Add to Existing Invoice')}
                          </div>
                          {purchases.map(p => (
                            <SelectItem key={p.id} value={p.id.toString()}>
                              {p.purchase_number}
                              {p.supplier_name ? ` — ${p.supplier_name}` : ''}
                              {p.invoice_reference ? ` (${p.invoice_reference})` : ''}
                            </SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {assignPurchaseId === 'new'
                      ? t('A new invoice will be created with all imported items and their costs.')
                      : assignPurchaseId !== 'none'
                        ? t('Items with cost and quantity will be added to the selected invoice.')
                        : t('Items are imported as products only — no purchase record created.')}
                  </p>

                  {/* New invoice fields */}
                  {assignPurchaseId === 'new' && (
                    <div className="space-y-3 rounded-md border bg-muted/30 p-3 mt-1">
                      <p className="text-xs font-medium text-primary flex items-center gap-1.5">
                        <PlusCircle className="h-3.5 w-3.5" />
                        {t('New Invoice Details')}
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5 col-span-2">
                          <Label className="text-xs">{t('Supplier')}</Label>
                          <Select value={newInvSupplierId} onValueChange={setNewInvSupplierId}>
                            <SelectTrigger className="h-8">
                              <SelectValue placeholder={t('Select supplier...')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('No Supplier')}</SelectItem>
                              {suppliers.map(s => (
                                <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">{t('Invoice Reference')}</Label>
                          <Input
                            value={newInvRef}
                            onChange={e => setNewInvRef(e.target.value)}
                            placeholder={t('e.g. INV-2024-001')}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">{t('Purchase Date')}</Label>
                          <Input
                            type="date"
                            value={newInvDate}
                            onChange={e => setNewInvDate(e.target.value)}
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'flex flex-1 min-h-[140px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors',
                  dragOver
                    ? 'border-primary bg-primary/5'
                    : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
                )}
              >
                <Upload className={cn('h-10 w-10', dragOver ? 'text-primary' : 'text-muted-foreground/40')} />
                <div className="text-center">
                  <p className="text-sm font-medium">{t('Drop Excel/CSV file here or click to browse')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('Supported formats')}: .xlsx, .xls, .csv</p>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileChange}
                className="hidden"
              />

              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)}>{t('Cancel')}</Button>
              </DialogFooter>
            </div>
          )}

          {/* ─── Step 2: Preview ─────────────────────────────────────────────── */}
          {step === 'preview' && (
            <div className="flex flex-1 flex-col gap-3 overflow-hidden min-h-0">
              {/* Summary bar */}
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                {fileName && (
                  <Badge variant="outline">
                    <FileSpreadsheet className="me-1 h-3 w-3" />
                    {fileName}
                  </Badge>
                )}
                <Badge variant="secondary">{t('Total')}: {parsedRows.length}</Badge>
                <Badge variant="secondary" className="text-emerald-700 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30">
                  <CheckCircle2 className="me-1 h-3 w-3" />
                  {t('Valid')}: {validCount}
                </Badge>
                {invalidCount > 0 && (
                  <Badge variant="destructive">
                    <XCircle className="me-1 h-3 w-3" />
                    {t('Errors')}: {invalidCount}
                  </Badge>
                )}
                {matchedCount > 0 && (
                  <Badge variant="outline" className="text-blue-700 border-blue-300 bg-blue-50 dark:bg-blue-950/30">
                    <Link2 className="me-1 h-3 w-3" />
                    {t('Matched')}: {matchedCount}
                  </Badge>
                )}
                <Badge variant="outline" className="text-primary border-primary/40">
                  {t('Selected')}: {selectedCount}
                  {selectedCount > 0 && (
                    <span className="ms-1 text-muted-foreground">
                      ({createCount > 0 ? `${createCount} ${t('new')}` : ''}
                      {createCount > 0 && updateCount > 0 ? ', ' : ''}
                      {updateCount > 0 ? `${updateCount} ${t('update')}` : ''})
                    </span>
                  )}
                </Badge>

                <div className="ms-auto flex items-center gap-2 flex-wrap">
                  {matchedCount > 0 && (
                    <>
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                        onClick={() => setAllMatchedMode('create')}>
                        <Plus className="h-3 w-3" />
                        {t('All matched → New')}
                      </Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"
                        onClick={() => setAllMatchedMode('update')}>
                        <RefreshCw className="h-3 w-3" />
                        {t('All matched → Update')}
                      </Button>
                    </>
                  )}
                  <Button variant="outline" size="sm" onClick={selectAllValid}>{t('Select All Valid')}</Button>
                  <Button variant="outline" size="sm" onClick={deselectAll}>{t('Deselect All')}</Button>
                </div>
              </div>

              {/* Preview table */}
              <ScrollArea className="flex-1 min-h-0 rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">{t('Use')}</TableHead>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead className="w-8">{t('OK')}</TableHead>
                      <TableHead>{t('Product Name')}</TableHead>
                      <TableHead>{t('Matched Product')}</TableHead>
                      <TableHead className="w-36">{t('Action')}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t('Batch #')}</TableHead>
                      <TableHead>{t('Expiry')}</TableHead>
                      <TableHead className="text-end">{t('Qty')}</TableHead>
                      <TableHead className="text-end">{t('Cost')}</TableHead>
                      <TableHead>{t('Errors')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map(row => (
                      <TableRow
                        key={row.rowIndex}
                        className={cn(
                          !row.valid && 'bg-destructive/5',
                          row.selected && row.importMode === 'update' && 'bg-blue-50/50 dark:bg-blue-950/20',
                        )}
                      >
                        {/* Checkbox */}
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={row.selected}
                            disabled={!row.valid}
                            onChange={() => toggleRow(row.rowIndex)}
                            className="h-4 w-4 accent-primary"
                          />
                        </TableCell>

                        {/* Row # */}
                        <TableCell className="text-muted-foreground text-xs">{row.rowIndex}</TableCell>

                        {/* Status icon */}
                        <TableCell>
                          {row.valid
                            ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                            : <XCircle className="h-4 w-4 text-destructive" />}
                        </TableCell>

                        {/* Product name */}
                        <TableCell className="font-medium">{row.name || '---'}</TableCell>

                        {/* Matched product */}
                        <TableCell>
                          {row.matchedProductId !== null ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400 text-xs font-medium cursor-default">
                                  <Link2 className="h-3 w-3 shrink-0" />
                                  <span className="truncate max-w-[120px]">{row.matchedProductName}</span>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {t('Matched existing product: {{name}}', { name: row.matchedProductName })}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">{t('No match')}</span>
                          )}
                        </TableCell>

                        {/* Per-row action selector */}
                        <TableCell>
                          {row.matchedProductId !== null ? (
                            <Select
                              value={row.importMode}
                              onValueChange={v => setRowMode(row.rowIndex, v as ImportMode)}
                              disabled={!row.valid || !row.selected}
                            >
                              <SelectTrigger className="h-7 text-xs w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="create">
                                  <span className="flex items-center gap-1.5">
                                    <Plus className="h-3 w-3" />
                                    {t('Create New')}
                                  </span>
                                </SelectItem>
                                <SelectItem value="update">
                                  <span className="flex items-center gap-1.5">
                                    <RefreshCw className="h-3 w-3" />
                                    {t('Update')}
                                  </span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Plus className="h-3 w-3" />
                              {t('Create New')}
                            </span>
                          )}
                        </TableCell>

                        {/* Batch */}
                        <TableCell className="hidden lg:table-cell text-muted-foreground text-xs">
                          {row.batchNumber || '---'}
                        </TableCell>

                        {/* Expiry */}
                        <TableCell className="text-xs">{row.expiryDate || '---'}</TableCell>

                        {/* Qty */}
                        <TableCell className="text-end tabular-nums text-sm">
                          {row.quantity > 0 ? row.quantity : '---'}
                        </TableCell>

                        {/* Cost */}
                        <TableCell className="text-end tabular-nums text-sm">
                          {row.costPerParent > 0 ? row.costPerParent : '---'}
                        </TableCell>

                        {/* Errors */}
                        <TableCell>
                          {row.errors.length > 0 && (
                            <span className="text-xs text-destructive">{row.errors.join('; ')}</span>
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
                  <Button variant="outline" size="sm"
                    onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                    disabled={currentPage === 0}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {t('Page {{page}} of {{total}}', { page: currentPage + 1, total: totalPages })}
                  </span>
                  <Button variant="outline" size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={currentPage >= totalPages - 1}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => { setStep('options'); setParsedRows([]); setFileName(''); }}>
                  <ArrowLeft className="me-1.5 h-4 w-4" />
                  {t('Back')}
                </Button>
                <Button onClick={handleImport} disabled={selectedCount === 0}>
                  <ArrowRight className="me-1.5 h-4 w-4" />
                  {t('Import {{n}} rows', { n: selectedCount })}
                  {(createCount > 0 || updateCount > 0) && (
                    <span className="ms-1 opacity-70 text-xs">
                      ({[
                        createCount > 0 ? `${createCount} ${t('new')}` : '',
                        updateCount > 0 ? `${updateCount} ${t('update')}` : '',
                      ].filter(Boolean).join(', ')})
                    </span>
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* ─── Step 3: Importing / Results ──────────────────────────────────── */}
          {step === 'importing' && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8">
              {importResult === null ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin text-primary" />
                  <p className="text-sm font-medium">
                    {t('Processing {{current}} / {{total}}...', { current: importProgress, total: importTotal })}
                  </p>
                  <div className="w-full max-w-xs rounded-full bg-muted h-2">
                    <div
                      className="rounded-full bg-primary h-2 transition-all"
                      style={{ width: `${importTotal > 0 ? (importProgress / importTotal) * 100 : 0}%` }}
                    />
                  </div>
                </>
              ) : (
                <div className="w-full space-y-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    {importResult.created > 0 && (
                      <Badge variant="secondary" className="text-emerald-700">
                        <CheckCircle2 className="me-1 h-3 w-3" />
                        {t('Created')}: {importResult.created}
                      </Badge>
                    )}
                    {importResult.updated > 0 && (
                      <Badge variant="secondary" className="text-blue-700">
                        <RefreshCw className="me-1 h-3 w-3" />
                        {t('Updated')}: {importResult.updated}
                      </Badge>
                    )}
                    {importResult.failed > 0 && (
                      <Badge variant="destructive">
                        <XCircle className="me-1 h-3 w-3" />
                        {t('Failed')}: {importResult.failed}
                      </Badge>
                    )}
                  </div>

                  {importResult.errors.length > 0 && (
                    <div className="rounded-md border bg-destructive/5 p-3 max-h-40 overflow-y-auto">
                      <p className="text-sm font-medium text-destructive mb-1">{t('Errors:')}</p>
                      <ul className="list-disc list-inside space-y-0.5">
                        {importResult.errors.map((e, i) => (
                          <li key={i} className="text-xs text-destructive">{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <DialogFooter>
                    <Button onClick={() => handleOpenChange(false)}>{t('Done')}</Button>
                  </DialogFooter>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
