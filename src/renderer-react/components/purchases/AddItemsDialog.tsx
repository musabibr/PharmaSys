import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Loader2, Plus, Trash2, Upload, ChevronLeft, ChevronRight,
  CheckCircle2, XCircle, Search, FileText, Pencil,
} from 'lucide-react';
import { api, throwIfError } from '@/api';
import type { Product, Category } from '@/api/types';
import { useSettingsStore } from '@/stores/settings.store';
import { formatCurrency, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ProductForm } from '@/components/inventory/ProductForm';

// ─── Constants ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

let _batchSeq = 0;
function generateBatchNumber(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  _batchSeq = (_batchSeq % 999) + 1;
  return `BN-${y}${m}${day}-${String(_batchSeq).padStart(3, '0')}`;
}

// ─── Types ─────────────────────────────────────────────────────────────────

type Step = 'import' | 'review' | 'match';

interface ImportItem {
  _key: string;
  name: string;
  genericName: string;
  expiryDate: string;
  parentUnit: string;
  childUnit: string;
  convFactor: number;
  quantity: number;
  costPerParent: number;
  sellPrice: number;
  sellPriceChild: number;
  batchNumber: string;
  barcode: string;
  categoryName: string;
  usageInstructions: string;
}

interface MatchedItem extends ImportItem {
  matchType: 'new' | 'existing';
  matchedProductId: number | null;
  matchedProductName: string;
  categoryName: string;
}

interface AddItemsDialogProps {
  purchaseId: number;
  purchaseNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeForMatch(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function fuzzyMatch(itemName: string, productName: string): boolean {
  const a = normalizeForMatch(itemName);
  const b = normalizeForMatch(productName);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(dateStr)) return false;
  const d = dateStr.length === 7
    ? new Date(dateStr + '-01T00:00:00')
    : new Date(dateStr + 'T00:00:00');
  return !isNaN(d.getTime());
}

function getItemErrors(item: ImportItem, t: (k: string) => string): string[] {
  const errors: string[] = [];
  if (!item.name.trim()) errors.push(t('Name is required'));
  if (item.expiryDate && !isValidDate(item.expiryDate)) errors.push(t('Invalid date format'));
  if (item.quantity <= 0) errors.push(t('Quantity must be greater than 0'));
  if (item.costPerParent <= 0) errors.push(t('Cost must be greater than 0'));
  return errors;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function AddItemsDialog({ purchaseId, purchaseNumber, open, onOpenChange, onSuccess }: AddItemsDialogProps) {
  const { t } = useTranslation();
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step state
  const [step, setStep] = useState<Step>('import');
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Step 2: Review state
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [reviewPage, setReviewPage] = useState(0);
  const [editingItem, setEditingItem] = useState<ImportItem | null>(null);
  const [editedKeys, setEditedKeys] = useState<Set<string>>(new Set());
  const [creatingCategoryForKey, setCreatingCategoryForKey] = useState<string | null>(null);

  // Step 3: Match state
  const [matchedItems, setMatchedItems] = useState<MatchedItem[]>([]);
  const [matchPage, setMatchPage] = useState(0);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [searchDialogKey, setSearchDialogKey] = useState<string | null>(null);
  const [searchDialogQuery, setSearchDialogQuery] = useState('');
  const [selectedMatchKeys, setSelectedMatchKeys] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showProductForm, setShowProductForm] = useState(false);

  // Reset on open
  useEffect(() => {
    if (open) {
      setStep('import');
      setImportItems([]);
      setMatchedItems([]);
      setEditedKeys(new Set());
      setReviewPage(0);
      setMatchPage(0);
      setEditingItem(null);
      setSelectedMatchKeys(new Set());
      setBulkCategory('');
      setNewCategoryName('');
      setSearchDialogKey(null);
      setSearchDialogQuery('');
      setCreatingCategoryForKey(null);
    }
  }, [open]);

  // Load categories on open
  useEffect(() => {
    if (open) {
      api.categories.getAll().then(cats => setAllCategories(cats)).catch(() => {});
    }
  }, [open]);

  // ─── Step 1: Import handlers ──────────────────────────────────────────────

  async function handlePdfFile(file: File) {
    setParsing(true);
    const toastId = toast.loading(t('Parsing invoice...'));
    try {
      const buffer = await file.arrayBuffer();
      const pdfRows = await api.pdf.parsePython(buffer);
      toast.dismiss(toastId);

      if (!pdfRows || pdfRows.length === 0) {
        toast.error(t('No product rows found in the PDF'));
        setParsing(false);
        return;
      }

      const items: ImportItem[] = pdfRows.map((row) => ({
        _key: `item-${row.row_number}-${Date.now()}`,
        name: row.name || '',
        genericName: row.generic_name || '',
        expiryDate: row.expiry_date || '',
        parentUnit: row.parent_unit || 'Unit',
        childUnit: row.child_unit || '',
        convFactor: row.conversion_factor || 1,
        quantity: row.quantity || 0,
        costPerParent: row.cost_per_parent || 0,
        sellPrice: row.cost_per_parent > 0
          ? Math.round(row.cost_per_parent * (1 + defaultMarkup / 100))
          : 0,
        sellPriceChild: row.cost_per_parent > 0 && row.child_unit && (row.conversion_factor || 1) > 1
          ? Math.floor(Math.round(row.cost_per_parent * (1 + defaultMarkup / 100)) / (row.conversion_factor || 1))
          : 0,
        batchNumber: generateBatchNumber(),
        barcode: '',
        categoryName: '',
        usageInstructions: '',
      }));

      setImportItems(items);
      setReviewPage(0);
      setStep('review');
      toast.success(t('Parsed {{count}} items from PDF', { count: items.length }));
    } catch (err: unknown) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handlePdfFile(file);
  }

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
      if (ext === 'pdf') {
        handlePdfFile(file);
      } else {
        toast.error(t('Please upload a PDF file'));
      }
    }
  }

  // ─── Step 2: Review handlers ──────────────────────────────────────────────

  function updateItem(key: string, field: keyof ImportItem, value: string | number) {
    setImportItems(prev => prev.map(item => {
      if (item._key !== key) return item;
      const updated = { ...item, [field]: value };
      // Auto-calculate child sell price when childUnit, convFactor, or sellPrice changes
      if (field === 'childUnit' || field === 'convFactor' || field === 'sellPrice') {
        if (updated.childUnit && updated.convFactor >= 1 && updated.sellPrice > 0) {
          updated.sellPriceChild = Math.floor(updated.sellPrice / updated.convFactor);
        } else if (!updated.childUnit) {
          updated.sellPriceChild = 0;
        }
      }
      return updated;
    }));
  }

  function saveEditingItem(updated: ImportItem) {
    setImportItems(prev => prev.map(item => item._key === updated._key ? updated : item));
    setEditedKeys(prev => new Set(prev).add(updated._key));
    setEditingItem(null);
  }

  function removeItem(key: string) {
    setImportItems(prev => prev.filter(item => item._key !== key));
  }

  function addEmptyItem() {
    setImportItems(prev => [...prev, {
      _key: `item-new-${Date.now()}`,
      name: '', genericName: '', expiryDate: '',
      parentUnit: 'Unit', childUnit: '', convFactor: 1,
      quantity: 0, costPerParent: 0, sellPrice: 0, sellPriceChild: 0, batchNumber: generateBatchNumber(),
      barcode: '', categoryName: '', usageInstructions: '',
    }]);
    if (step === 'import') setStep('review');
    const newTotal = importItems.length + 1;
    const lastPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1);
    setReviewPage(lastPage);
  }

  // Computed review stats
  const reviewErrors = importItems.filter(item => getItemErrors(item, t).length > 0).length;
  const reviewValid = importItems.length - reviewErrors;
  const reviewTotal = importItems.reduce((sum, item) => sum + (item.costPerParent * item.quantity), 0);
  const reviewTotalPages = Math.max(1, Math.ceil(importItems.length / PAGE_SIZE));
  const reviewPageItems = importItems.slice(reviewPage * PAGE_SIZE, (reviewPage + 1) * PAGE_SIZE);

  function canProceedFromReview(): boolean {
    return importItems.length > 0 && reviewErrors === 0;
  }

  // ─── Step 3: Match handlers ───────────────────────────────────────────────

  async function enterMatchStep() {
    setStep('match');
    setMatchLoading(true);
    try {
      const [products, categories] = await Promise.all([
        api.products.getAll(),
        api.categories.getAll(),
      ]);
      setAllProducts(products);
      setAllCategories(categories);

      // Auto-match each item
      const matched: MatchedItem[] = importItems.map(item => {
        const found = products.find(p => fuzzyMatch(item.name, p.name));
        if (found) {
          return {
            ...item,
            matchType: 'existing' as const,
            matchedProductId: found.id,
            matchedProductName: found.name,
            categoryName: found.category_name || '',
          };
        }
        return {
          ...item,
          matchType: 'new' as const,
          matchedProductId: null,
          matchedProductName: '',
          // Preserve category chosen in review step, or empty
          categoryName: item.categoryName || '',
        };
      });

      setMatchedItems(matched);
      setMatchPage(0);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to load products'));
    } finally {
      setMatchLoading(false);
    }
  }

  async function handleProductCreated() {
    try {
      const products = await api.products.getAll();
      setAllProducts(products);
      // Re-match: update any "new" items that now match an existing product
      setMatchedItems(prev => prev.map(item => {
        if (item.matchType !== 'new') return item;
        const found = products.find(p => fuzzyMatch(item.name, p.name));
        if (found) {
          return {
            ...item,
            matchType: 'existing' as const,
            matchedProductId: found.id,
            matchedProductName: found.name,
            categoryName: found.category_name || '',
          };
        }
        return item;
      }));
    } catch {
      // Non-critical — user can still manually match
    }
  }

  function setMatchType(key: string, type: 'new' | 'existing', productId?: number, productName?: string, catName?: string) {
    setMatchedItems(prev => prev.map(item =>
      item._key === key ? {
        ...item,
        matchType: type,
        matchedProductId: type === 'existing' ? (productId ?? null) : null,
        matchedProductName: type === 'existing' ? (productName ?? '') : '',
        categoryName: type === 'existing' ? (catName ?? '') : item.categoryName,
      } : item
    ));
  }

  function setItemCategory(key: string, catName: string) {
    setMatchedItems(prev => prev.map(item =>
      item._key === key ? { ...item, categoryName: catName } : item
    ));
  }

  function applyBulkCategory(catName: string) {
    setMatchedItems(prev => prev.map(item =>
      item.matchType === 'new' && selectedMatchKeys.has(item._key)
        ? { ...item, categoryName: catName }
        : item
    ));
  }

  function toggleMatchSelection(key: string) {
    setSelectedMatchKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const existingCount = matchedItems.filter(m => m.matchType === 'existing').length;
  const newCount = matchedItems.filter(m => m.matchType === 'new').length;
  const matchTotalPages = Math.max(1, Math.ceil(matchedItems.length / PAGE_SIZE));
  const matchPageItems = matchedItems.slice(matchPage * PAGE_SIZE, (matchPage + 1) * PAGE_SIZE);

  // ─── Submit ─────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (matchedItems.length === 0) return;

    setSubmitting(true);
    try {
      const items = matchedItems.map(item => {
        if (item.matchType === 'existing' && item.matchedProductId) {
          return {
            product_id: item.matchedProductId,
            quantity: item.quantity,
            cost_per_parent: item.costPerParent,
            selling_price_parent: item.sellPrice,
            selling_price_child: item.sellPriceChild || undefined,
            expiry_date: item.expiryDate,
            batch_number: item.batchNumber || undefined,
          };
        } else {
          return {
            new_product: {
              name: item.name,
              generic_name: item.genericName || undefined,
              usage_instructions: item.usageInstructions || undefined,
              category_name: item.categoryName || undefined,
              barcode: item.barcode || undefined,
              parent_unit: item.parentUnit || 'Unit',
              child_unit: item.childUnit || undefined,
              conversion_factor: item.convFactor || 1,
            },
            quantity: item.quantity,
            cost_per_parent: item.costPerParent,
            selling_price_parent: item.sellPrice,
            selling_price_child: item.sellPriceChild || undefined,
            expiry_date: item.expiryDate,
            batch_number: item.batchNumber || undefined,
          };
        }
      });

      throwIfError(await api.purchases.addItems(purchaseId, { items }));
      toast.success(t('Items added successfully'));
      onSuccess();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to add items'));
    } finally {
      setSubmitting(false);
    }
  }, [matchedItems, purchaseId, onSuccess, onOpenChange, t]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] flex flex-col p-0">
        <div className="shrink-0 px-6 pt-6">
          <DialogHeader>
            <DialogTitle>{t('Add Items to Purchase')} — {purchaseNumber}</DialogTitle>
            <DialogDescription>
              {step === 'import' && t('Import items from a PDF invoice or add them manually.')}
              {step === 'review' && t('Review and edit the imported items before matching.')}
              {step === 'match' && t('Match imported items to existing products or create new ones.')}
            </DialogDescription>
          </DialogHeader>

          {/* Step indicator */}
          <div className="flex items-center gap-1 mt-4">
            {(['import', 'review', 'match'] as Step[]).map((s, idx) => {
              const stepLabels: Record<Step, string> = {
                import: t('Import'),
                review: t('Review'),
                match: t('Match'),
              };
              const currentIdx = ['import', 'review', 'match'].indexOf(step);
              const isCompleted = idx < currentIdx;
              const isCurrent = idx === currentIdx;
              return (
                <div key={s} className="flex items-center gap-1 flex-1">
                  <div className={`flex items-center gap-1.5 ${
                    isCurrent ? 'text-primary font-semibold' :
                    isCompleted ? 'text-primary/70' : 'text-muted-foreground'
                  }`}>
                    <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                      isCompleted ? 'bg-primary text-primary-foreground' :
                      isCurrent ? 'bg-primary text-primary-foreground' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {isCompleted ? <CheckCircle2 className="h-3.5 w-3.5" /> : idx + 1}
                    </div>
                    <span className="text-xs whitespace-nowrap">{stepLabels[s]}</span>
                  </div>
                  {idx < 2 && (
                    <div className={`flex-1 h-px mx-1 ${
                      idx < currentIdx ? 'bg-primary' : 'bg-border'
                    }`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* Step 1: Import                                                      */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {step === 'import' && (
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !parsing && fileInputRef.current?.click()}
              className={`flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors ${
                parsing ? 'pointer-events-none opacity-60' :
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
              }`}
            >
              {parsing ? (
                <>
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                  <p className="text-sm font-medium">{t('Parsing invoice...')}</p>
                </>
              ) : (
                <>
                  <Upload className={`h-10 w-10 ${dragOver ? 'text-primary' : 'text-muted-foreground/40'}`} />
                  <div className="text-center">
                    <p className="text-sm font-medium">
                      {t('Drop PDF invoice here or click to browse')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('Supported formats')}: .pdf
                    </p>
                  </div>
                </>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="flex items-center gap-3">
              <div className="flex-1 border-t" />
              <span className="text-xs text-muted-foreground">{t('or')}</span>
              <div className="flex-1 border-t" />
            </div>

            <Button variant="outline" onClick={addEmptyItem} className="w-full gap-1.5">
              <Plus className="h-4 w-4" />
              {t('Add Item Manually')}
            </Button>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* Step 2: Review & Edit                                               */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {step === 'review' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('Review and fix the imported data. Fill any missing required fields.')}
            </p>

            {/* Editable table */}
            <div className="rounded-md border overflow-x-auto">
              <Table className="w-max min-w-full sticky-col">
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-8 whitespace-nowrap">#</TableHead>
                    <TableHead className="max-w-[15rem] whitespace-nowrap">{t('Name')}*</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Barcode')}</TableHead>
                    <TableHead className="max-w-[15rem] whitespace-nowrap">{t('Generic Name')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Category')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Usage Instructions')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Expiry Date')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Base Unit')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Small Unit')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Conv')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Qty')}*</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Cost')}*</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Sell/Base')}*</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Sell/Small')}</TableHead>
                    <TableHead className="w-8"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewPageItems.map((item, pageIdx) => {
                    const globalIdx = reviewPage * PAGE_SIZE + pageIdx;
                    const errors = getItemErrors(item, t);
                    const hasError = errors.length > 0;
                    return (
                      <TableRow
                        key={item._key}
                        className={hasError ? 'bg-destructive/5 border-s-2 border-s-destructive' : ''}
                      >
                        <TableCell className="text-muted-foreground text-xs">
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center gap-1 hover:text-primary",
                              editedKeys.has(item._key) && "text-emerald-600 font-semibold"
                            )}
                            onClick={() => setEditingItem(item)}
                            title={t('Edit item details')}
                          >
                            {editedKeys.has(item._key) && <CheckCircle2 className="h-3 w-3" />}
                            {globalIdx + 1}
                            <Pencil className="h-3 w-3 opacity-40 hover:opacity-100" />
                          </button>
                        </TableCell>
                        <TableCell className="max-w-[15rem]">
                          <Input
                            value={item.name}
                            onChange={e => updateItem(item._key, 'name', e.target.value)}
                            className={`h-8 text-xs min-w-[8rem] ${!item.name.trim() ? 'ring-1 ring-destructive' : ''}`}
                            placeholder={t('Product Name')}
                            maxLength={60}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            value={item.barcode}
                            onChange={e => updateItem(item._key, 'barcode', e.target.value)}
                            className="h-8 text-xs w-32"
                            placeholder={t('e.g. 6001234567890')}
                          />
                        </TableCell>
                        <TableCell className="max-w-[15rem]">
                          <Input
                            value={item.genericName}
                            onChange={e => updateItem(item._key, 'genericName', e.target.value)}
                            className="h-8 text-xs min-w-[6rem]"
                            placeholder={t('Generic')}
                            maxLength={60}
                          />
                        </TableCell>
                        <TableCell className="">
                          {creatingCategoryForKey === item._key ? (
                            <Input
                              className="h-8 text-xs"
                              placeholder={t('New category name')}
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  const name = (e.target as HTMLInputElement).value.trim();
                                  if (name) {
                                    if (!allCategories.find(c => c.name === name)) {
                                      setAllCategories(prev => [...prev, { id: -Date.now(), name }]);
                                    }
                                    updateItem(item._key, 'categoryName', name);
                                  }
                                  setCreatingCategoryForKey(null);
                                }
                                if (e.key === 'Escape') setCreatingCategoryForKey(null);
                              }}
                              onBlur={e => {
                                const name = e.target.value.trim();
                                if (name) {
                                  if (!allCategories.find(c => c.name === name)) {
                                    setAllCategories(prev => [...prev, { id: -Date.now(), name }]);
                                  }
                                  updateItem(item._key, 'categoryName', name);
                                }
                                setCreatingCategoryForKey(null);
                              }}
                            />
                          ) : (
                            <div className="flex items-center gap-1">
                              <Select
                                value={item.categoryName || ''}
                                onValueChange={(val) => updateItem(item._key, 'categoryName', val)}
                              >
                                <SelectTrigger className="h-8 text-xs flex-1">
                                  <SelectValue placeholder={t('Category')} />
                                </SelectTrigger>
                                <SelectContent>
                                  {allCategories.map(cat => (
                                    <SelectItem key={cat.id} value={cat.name}>
                                      {cat.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 shrink-0"
                                onClick={() => setCreatingCategoryForKey(item._key)}
                                title={t('Create new category')}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="">
                          <Input
                            value={item.usageInstructions}
                            onChange={e => updateItem(item._key, 'usageInstructions', e.target.value)}
                            className="h-8 text-xs"
                            placeholder={t('e.g. 3 times daily')}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            type="text"
                            value={item.expiryDate}
                            onChange={e => updateItem(item._key, 'expiryDate', e.target.value)}
                            className={`h-8 text-xs w-28 ${item.expiryDate && !isValidDate(item.expiryDate) ? 'ring-1 ring-destructive' : ''}`}
                            placeholder="YYYY-MM-DD"
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            value={item.parentUnit}
                            onChange={e => updateItem(item._key, 'parentUnit', e.target.value)}
                            className="h-8 text-xs w-20"
                            placeholder={t('Box')}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            value={item.childUnit}
                            onChange={e => updateItem(item._key, 'childUnit', e.target.value)}
                            className="h-8 text-xs w-20"
                            placeholder={t('Optional')}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            type="number"
                            step="1"
                            min="1"
                            value={item.childUnit ? (item.convFactor || '') : ''}
                            onChange={e => updateItem(item._key, 'convFactor', Math.max(1, Math.round(Number(e.target.value) || 1)))}
                            className="h-8 text-xs w-14"
                            placeholder="1"
                            disabled={!item.childUnit}
                            title={!item.childUnit ? t('Set small unit first') : ''}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            type="number"
                            step="1"
                            min="0"
                            value={item.quantity || ''}
                            onChange={e => updateItem(item._key, 'quantity', Math.round(Number(e.target.value) || 0))}
                            className={`h-8 text-xs w-16 ${item.quantity <= 0 ? 'ring-1 ring-destructive' : ''}`}
                            placeholder="0"
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            type="number"
                            step="1"
                            min="0"
                            value={item.costPerParent || ''}
                            onChange={e => {
                              const cost = Math.round(Number(e.target.value) || 0);
                              updateItem(item._key, 'costPerParent', cost);
                              // Auto-fill sell price if empty
                              if (cost > 0 && !item.sellPrice) {
                                const sell = Math.round(cost * (1 + defaultMarkup / 100));
                                updateItem(item._key, 'sellPrice', sell);
                              }
                            }}
                            className={`h-8 text-xs w-20 ${item.costPerParent <= 0 ? 'ring-1 ring-destructive' : ''}`}
                            placeholder="0"
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            type="number"
                            step="1"
                            min="0"
                            value={item.sellPrice || ''}
                            onChange={e => {
                              const sell = Math.round(Number(e.target.value) || 0);
                              updateItem(item._key, 'sellPrice', sell);
                            }}
                            className="h-8 text-xs w-20"
                            placeholder={item.costPerParent > 0 ? String(Math.round(item.costPerParent * (1 + defaultMarkup / 100))) : '0'}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Input
                            type="number"
                            step="1"
                            min="0"
                            value={item.childUnit ? (item.sellPriceChild || '') : ''}
                            disabled={!item.childUnit}
                            onChange={e => updateItem(item._key, 'sellPriceChild', Math.round(Number(e.target.value) || 0))}
                            className="h-8 text-xs w-20"
                            placeholder={!item.childUnit ? '—' : (item.sellPrice > 0 ? String(Math.floor(item.sellPrice / item.convFactor)) : '0')}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => removeItem(item._key)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Add row + pagination */}
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={addEmptyItem} className="gap-1">
                <Plus className="h-3.5 w-3.5" />
                {t('Add Row')}
              </Button>

              {reviewTotalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setReviewPage(p => Math.max(0, p - 1))}
                    disabled={reviewPage === 0}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t('Page {{page}} of {{total}}', { page: reviewPage + 1, total: reviewTotalPages })}
                  </span>
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setReviewPage(p => Math.min(reviewTotalPages - 1, p + 1))}
                    disabled={reviewPage >= reviewTotalPages - 1}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* Step 3: Product Matching                                            */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {step === 'match' && (
          <div className="space-y-4">
            {matchLoading ? (
              <div className="flex items-center justify-center py-12 gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">{t('Checking products...')}</span>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('The system checked each product against the database.')}
                </p>

                {/* Bulk category for selected items */}
                {newCount > 0 && (
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 flex-wrap">
                    <Label className="text-xs whitespace-nowrap">
                      {t('Set category for selected items')}
                      {selectedMatchKeys.size > 0 && (
                        <Badge variant="secondary" className="ms-1 text-[10px] px-1.5 py-0">{selectedMatchKeys.size} {t('selected')}</Badge>
                      )}:
                    </Label>
                    <Select
                      value={bulkCategory}
                      disabled={selectedMatchKeys.size === 0}
                      onValueChange={(val) => {
                        if (val === '__new__') {
                          return; // handled by inline input
                        }
                        setBulkCategory(val);
                        applyBulkCategory(val);
                      }}
                    >
                      <SelectTrigger className="h-8 w-[200px] text-xs">
                        <SelectValue placeholder={t('Select category')} />
                      </SelectTrigger>
                      <SelectContent>
                        {allCategories.map(cat => (
                          <SelectItem key={cat.id} value={cat.name}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* New category inline */}
                    <div className="flex items-center gap-1">
                      <Input
                        value={newCategoryName}
                        onChange={e => setNewCategoryName(e.target.value)}
                        placeholder={t('New category')}
                        className="h-8 w-[150px] text-xs"
                      />
                      <Button
                        variant="outline" size="sm"
                        className="h-8"
                        disabled={!newCategoryName.trim() || selectedMatchKeys.size === 0}
                        onClick={() => {
                          const name = newCategoryName.trim();
                          if (!name) return;
                          // Add to local categories list
                          if (!allCategories.find(c => c.name === name)) {
                            setAllCategories(prev => [...prev, { id: -Date.now(), name }]);
                          }
                          setBulkCategory(name);
                          applyBulkCategory(name);
                          setNewCategoryName('');
                        }}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}

                {/* Add new product button */}
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowProductForm(true)} className="gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    {t('Add New Product')}
                  </Button>
                  {newCount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t('{{count}} new products will be created', { count: newCount })}
                    </span>
                  )}
                </div>

                {/* Match table */}
                <div className="rounded-md border overflow-x-auto">
                  <Table className="sticky-col">
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="w-8">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-input accent-primary"
                            checked={matchedItems.filter(m => m.matchType === 'new').length > 0 && matchedItems.filter(m => m.matchType === 'new').every(m => selectedMatchKeys.has(m._key))}
                            onChange={(e) => {
                              const newItems = matchedItems.filter(m => m.matchType === 'new');
                              if (e.target.checked) {
                                setSelectedMatchKeys(prev => {
                                  const next = new Set(prev);
                                  newItems.forEach(m => next.add(m._key));
                                  return next;
                                });
                              } else {
                                setSelectedMatchKeys(new Set());
                              }
                            }}
                          />
                        </TableHead>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>{t('Invoice Name')}</TableHead>
                        <TableHead>{t('Status')}</TableHead>
                        <TableHead>{t('Matched Product')}</TableHead>
                        <TableHead className="">{t('Category')}</TableHead>
                        <TableHead className="w-16">{t('Actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchPageItems.map((item, pageIdx) => {
                        const globalIdx = matchPage * PAGE_SIZE + pageIdx;
                        return (
                          <TableRow key={item._key}>
                            <TableCell>
                              {item.matchType === 'new' ? (
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded border-input accent-primary"
                                  checked={selectedMatchKeys.has(item._key)}
                                  onChange={() => toggleMatchSelection(item._key)}
                                />
                              ) : (
                                <span className="block h-3.5 w-3.5" />
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {globalIdx + 1}
                            </TableCell>
                            <TableCell>
                              <div>
                                <span className="font-medium text-sm">{item.name}</span>
                                {item.genericName && (
                                  <span className="text-xs text-muted-foreground block">{item.genericName}</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              {item.matchType === 'existing' ? (
                                <Badge variant="default" className="text-xs">
                                  {t('Existing')}
                                </Badge>
                              ) : (
                                <Badge variant="success" className="text-xs">
                                  {t('New')}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              {item.matchType === 'existing' ? (
                                <span className="text-sm">{item.matchedProductName}</span>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="">
                              {item.matchType === 'existing' ? (
                                <span className="text-sm text-muted-foreground">{item.categoryName || '—'}</span>
                              ) : (
                                <Select
                                  value={item.categoryName || ''}
                                  onValueChange={(val) => setItemCategory(item._key, val)}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue placeholder={t('Select category')} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {allCategories.map(cat => (
                                      <SelectItem key={cat.id} value={cat.name}>
                                        {cat.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7"
                                title={t('Search Product')}
                                onClick={() => {
                                  setSearchDialogKey(item._key);
                                  setSearchDialogQuery(item.matchType === 'new' ? item.name : '');
                                }}
                              >
                                <Search className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination + summary */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-sm">
                    <Badge variant="default">{existingCount} {t('Existing — new batch')}</Badge>
                    <Badge variant="success">{newCount} {t('New — product + batch')}</Badge>
                  </div>

                  {matchTotalPages > 1 && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setMatchPage(p => Math.max(0, p - 1))}
                        disabled={matchPage === 0}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {t('Page {{page}} of {{total}}', { page: matchPage + 1, total: matchTotalPages })}
                      </span>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setMatchPage(p => Math.min(matchTotalPages - 1, p + 1))}
                        disabled={matchPage >= matchTotalPages - 1}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        </div>{/* end scrollable content area */}

        {/* ═══════════════════════════════════════════════════════════════════════ */}
        {/* Footer — pinned to bottom                                              */}
        {/* ═══════════════════════════════════════════════════════════════════════ */}

        {/* Step 2: Review footer */}
        {step === 'review' && (
          <div className="shrink-0 flex items-center justify-between border-t bg-background/95 backdrop-blur px-6 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep('import')}>
                <ChevronLeft className="me-1 h-4 w-4" />
                {t('Back')}
              </Button>
              <Button
                size="sm"
                onClick={() => enterMatchStep()}
                disabled={!canProceedFromReview()}
                title={!canProceedFromReview() ? t('Fix {{n}} errors to continue', { n: reviewErrors }) : ''}
              >
                {t('Next')}
                <ChevronRight className="ms-1 h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="success">
                <CheckCircle2 className="me-1 h-3 w-3" />
                {reviewValid} {t('valid')}
              </Badge>
              {reviewErrors > 0 && (
                <Badge variant="destructive">
                  <XCircle className="me-1 h-3 w-3" />
                  {reviewErrors} {t('errors')}
                </Badge>
              )}
              <span className="text-sm text-muted-foreground">
                {t('Total')}: <span className="font-medium text-foreground">{formatCurrency(reviewTotal)}</span>
              </span>
            </div>
          </div>
        )}

        {/* Step 3: Match footer */}
        {step === 'match' && !matchLoading && (
          <div className="shrink-0 flex items-center justify-between border-t bg-background/95 backdrop-blur px-6 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep('review')}>
                <ChevronLeft className="me-1 h-4 w-4" />
                {t('Back')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('Cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={submitting || matchedItems.length === 0} className="gap-1.5">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('Add Items')}
              </Button>
            </div>
          </div>
        )}

        {/* Import step footer — just cancel */}
        {step === 'import' && (
          <div className="shrink-0 flex items-center justify-end border-t bg-background/95 backdrop-blur px-6 py-2.5">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
          </div>
        )}

        {/* Product Search Dialog */}
        <Dialog open={!!searchDialogKey} onOpenChange={(open) => { if (!open) setSearchDialogKey(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('Search Product')}</DialogTitle>
              <DialogDescription>{t('Search for an existing product or create as new')}</DialogDescription>
            </DialogHeader>
            <Input
              value={searchDialogQuery}
              onChange={e => setSearchDialogQuery(e.target.value)}
              placeholder={t('Search products...')}
              autoFocus
              className="h-9"
            />
            <div className="max-h-64 overflow-y-auto space-y-0.5">
              {allProducts
                .filter(p =>
                  searchDialogQuery
                    ? normalizeForMatch(p.name).includes(normalizeForMatch(searchDialogQuery)) ||
                      (p.generic_name && normalizeForMatch(p.generic_name).includes(normalizeForMatch(searchDialogQuery)))
                    : true
                )
                .slice(0, 15)
                .map(p => (
                  <button
                    key={p.id}
                    className="w-full text-start px-3 py-2 hover:bg-accent rounded-md text-sm flex items-center justify-between"
                    onClick={() => {
                      if (searchDialogKey) {
                        setMatchType(searchDialogKey, 'existing', p.id, p.name, p.category_name || '');
                      }
                      setSearchDialogKey(null);
                    }}
                  >
                    <span>{p.name}</span>
                    {p.category_name && <span className="text-xs text-muted-foreground">{p.category_name}</span>}
                  </button>
                ))
              }
              {searchDialogQuery && allProducts.filter(p =>
                normalizeForMatch(p.name).includes(normalizeForMatch(searchDialogQuery)) ||
                (p.generic_name && normalizeForMatch(p.generic_name).includes(normalizeForMatch(searchDialogQuery)))
              ).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-3">
                  {t('No match found — will create new product')}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (searchDialogKey) {
                    setMatchType(searchDialogKey, 'new');
                  }
                  setSearchDialogKey(null);
                }}
              >
                {t('Create as new product')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Edit Item Dialog ──────────────────────────────────────────── */}
        <EditItemDialog
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={saveEditingItem}
          categories={allCategories}
          onCreateCategory={(name) => {
            if (!allCategories.find(c => c.name === name)) {
              setAllCategories(prev => [...prev, { id: -Date.now(), name }]);
            }
          }}
          defaultMarkup={defaultMarkup}
        />

        {/* ── Create Product Form ──────────────────────────────────────── */}
        <ProductForm
          open={showProductForm}
          onOpenChange={setShowProductForm}
          product={null}
          onSaved={handleProductCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// EditItemDialog — full-form view of an ImportItem for easier editing
// ---------------------------------------------------------------------------

interface EditItemDialogProps {
  item: ImportItem | null;
  onClose: () => void;
  onSave: (item: ImportItem) => void;
  categories: { id: number; name: string }[];
  onCreateCategory: (name: string) => void;
  defaultMarkup: number;
}

function EditItemDialog({ item, onClose, onSave, categories, onCreateCategory, defaultMarkup }: EditItemDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ImportItem | null>(null);
  const [markup, setMarkup] = useState(defaultMarkup);
  const [syncChildToParent, setSyncChildToParent] = useState(false);

  // Sync draft when item changes
  useEffect(() => {
    if (item) {
      setDraft({ ...item });
      setSyncChildToParent(false);
      // Compute effective markup from cost/sell
      if (item.costPerParent > 0 && item.sellPrice > 0) {
        setMarkup(Math.round(((item.sellPrice - item.costPerParent) / item.costPerParent) * 100));
      } else {
        setMarkup(defaultMarkup);
      }
    } else {
      setDraft(null);
    }
  }, [item, defaultMarkup]);

  if (!draft) return null;

  function update(field: keyof ImportItem, value: string | number) {
    setDraft(prev => {
      if (!prev) return prev;
      const updated = { ...prev, [field]: value };
      // Auto-calculate child sell price
      if (field === 'childUnit' || field === 'convFactor' || field === 'sellPrice') {
        if (updated.childUnit && updated.convFactor >= 1 && updated.sellPrice > 0) {
          updated.sellPriceChild = Math.floor(updated.sellPrice / updated.convFactor);
        } else if (!updated.childUnit) {
          updated.sellPriceChild = 0;
        }
      }
      // Auto-fill sell price from cost using current markup
      if (field === 'costPerParent') {
        const cost = Number(value) || 0;
        if (cost > 0) {
          updated.sellPrice = Math.round(cost * (1 + markup / 100));
          if (updated.childUnit && updated.convFactor >= 1 && updated.sellPrice > 0) {
            updated.sellPriceChild = Math.floor(updated.sellPrice / updated.convFactor);
          }
        }
      }
      // Update markup when sell price changes manually
      if (field === 'sellPrice' && updated.costPerParent > 0) {
        const sell = Number(value) || 0;
        setMarkup(Math.round(((sell - updated.costPerParent) / updated.costPerParent) * 100));
      }
      // Reverse-calculate parent sell price from child sell price (only when sync is enabled)
      if (field === 'sellPriceChild' && syncChildToParent && updated.childUnit && updated.convFactor > 1) {
        const childSell = Number(value) || 0;
        if (childSell > 0) {
          updated.sellPrice = childSell * updated.convFactor;
          if (updated.costPerParent > 0) {
            setMarkup(Math.round(((updated.sellPrice - updated.costPerParent) / updated.costPerParent) * 100));
          }
        }
      }
      return updated;
    });
  }

  function applyMarkup(newMarkup: number) {
    setMarkup(newMarkup);
    setDraft(prev => {
      if (!prev || prev.costPerParent <= 0) return prev;
      const sell = Math.round(prev.costPerParent * (1 + newMarkup / 100));
      const updated = { ...prev, sellPrice: sell };
      if (updated.childUnit && updated.convFactor >= 1 && sell > 0) {
        updated.sellPriceChild = Math.floor(sell / updated.convFactor);
      }
      return updated;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (draft) onSave(draft);
  }

  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Edit Item')}</DialogTitle>
          <DialogDescription>{t('Update the item details below.')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="ei-name">
                {t('Name')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ei-name"
                value={draft.name}
                onChange={e => update('name', e.target.value)}
                placeholder={t('Product Name')}
                autoFocus
                maxLength={60}
              />
            </div>

            {/* Generic Name */}
            <div className="space-y-1.5">
              <Label htmlFor="ei-generic">{t('Generic Name')}</Label>
              <Input
                id="ei-generic"
                value={draft.genericName}
                onChange={e => update('genericName', e.target.value)}
                placeholder={t('Generic')}
                maxLength={60}
              />
            </div>

            {/* Barcode */}
            <div className="space-y-1.5">
              <Label htmlFor="ei-barcode">{t('Barcode')}</Label>
              <Input
                id="ei-barcode"
                value={draft.barcode}
                onChange={e => update('barcode', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                placeholder={t('e.g. 6001234567890')}
              />
            </div>

            {/* Category */}
            <div className="space-y-1.5">
              <Label>{t('Category')}</Label>
              <Select
                value={draft.categoryName || ''}
                onValueChange={val => update('categoryName', val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select category')} />
                </SelectTrigger>
                <SelectContent>
                  {categories.map(cat => (
                    <SelectItem key={cat.id} value={cat.name}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Usage Instructions */}
            <div className="space-y-1.5">
              <Label htmlFor="ei-usage">{t('Usage Instructions')}</Label>
              <textarea
                id="ei-usage"
                value={draft.usageInstructions}
                onChange={e => update('usageInstructions', e.target.value)}
                placeholder={t('e.g. 3 times daily')}
                rows={2}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <Separator />

            {/* Unit configuration */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ei-parent-unit">{t('Base Unit')}</Label>
                <Input
                  id="ei-parent-unit"
                  value={draft.parentUnit}
                  onChange={e => update('parentUnit', e.target.value)}
                  placeholder="Box"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ei-child-unit">{t('Small Unit')}</Label>
                <Input
                  id="ei-child-unit"
                  value={draft.childUnit}
                  onChange={e => update('childUnit', e.target.value)}
                  placeholder={t('Optional')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ei-conv">{t('Conversion Factor')}</Label>
                <Input
                  id="ei-conv"
                  type="number"
                  min={1}
                  step={1}
                  value={draft.childUnit ? (draft.convFactor || '') : ''}
                  onChange={e => update('convFactor', Math.max(1, Math.round(Number(e.target.value) || 1)))}
                  disabled={!draft.childUnit}
                />
              </div>
            </div>

            {/* Unit preview */}
            {draft.childUnit && draft.convFactor > 1 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                1 {draft.parentUnit || t('Base Unit')} = {draft.convFactor} {draft.childUnit || t('Small Unit')}
              </p>
            )}

            <Separator />

            {/* Batch & Expiry */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ei-batch">{t('Batch #')}</Label>
                <Input
                  id="ei-batch"
                  value={draft.batchNumber}
                  onChange={e => update('batchNumber', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ei-expiry">{t('Expiry Date')}</Label>
                <Input
                  id="ei-expiry"
                  value={draft.expiryDate}
                  onChange={e => update('expiryDate', e.target.value)}
                  placeholder="YYYY-MM-DD"
                />
              </div>
            </div>

            <Separator />

            {/* Pricing */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ei-qty">
                  {t('Qty')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ei-qty"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.quantity || ''}
                  onChange={e => update('quantity', Math.round(Number(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ei-cost">
                  {t('Cost')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ei-cost"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.costPerParent || ''}
                  onChange={e => update('costPerParent', Math.round(Number(e.target.value) || 0))}
                />
              </div>
              {/* Selling prices grouped together */}
              <div className="space-y-1.5">
                <Label htmlFor="ei-sell">{t('Sell/Base')}</Label>
                <Input
                  id="ei-sell"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.sellPrice || ''}
                  onChange={e => update('sellPrice', Math.round(Number(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ei-sell-child">{t('Sell/Small')}</Label>
                <Input
                  id="ei-sell-child"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.childUnit ? (draft.sellPriceChild || '') : ''}
                  onChange={e => update('sellPriceChild', Math.round(Number(e.target.value) || 0))}
                  disabled={!draft.childUnit}
                />
              </div>
              {draft.childUnit && (
                <label htmlFor="sync-child-parent" className="flex items-center gap-2 col-span-2 cursor-pointer select-none">
                  <input
                    id="sync-child-parent"
                    type="checkbox"
                    checked={syncChildToParent}
                    onChange={e => setSyncChildToParent(e.target.checked)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">{t('Changing small price updates base price')}</span>
                </label>
              )}
              {/* Markup below selling prices */}
              <div className="space-y-1.5">
                <Label htmlFor="ei-markup">{t('Markup %')}</Label>
                <Input
                  id="ei-markup"
                  type="number"
                  min={0}
                  step={1}
                  value={markup || ''}
                  onChange={e => applyMarkup(Math.round(Number(e.target.value) || 0))}
                  disabled={!draft.costPerParent}
                />
              </div>
            </div>

            {/* Line total */}
            {draft.costPerParent > 0 && draft.quantity > 0 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
                {t('Total')}: {(draft.costPerParent * draft.quantity).toLocaleString()} SDG
              </p>
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit">
              {t('Save Changes')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
