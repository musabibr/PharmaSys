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
import { Card, CardContent } from '@/components/ui/card';
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
}

interface AddItemsDialogProps {
  purchaseId: number;
  purchaseNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function fuzzyMatch(itemName: string, productName: string): boolean {
  const a = normalizeForMatch(itemName);
  const b = normalizeForMatch(productName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wordsA = a.split(' ');
  const wordsB = b.split(' ');
  const common = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return common.length >= Math.min(wordsA.length, wordsB.length) * 0.6;
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

  // Items
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [matchedItems, setMatchedItems] = useState<MatchedItem[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [editedKeys, setEditedKeys] = useState<Set<string>>(new Set());

  // Pagination
  const [reviewPage, setReviewPage] = useState(0);
  const [matchPage, setMatchPage] = useState(0);
  const [matchLoading, setMatchLoading] = useState(false);

  // Edit dialog
  const [editingItem, setEditingItem] = useState<ImportItem | null>(null);

  // Match search
  const [matchSearches, setMatchSearches] = useState<Record<string, string>>({});

  // Create product dialog
  const [showCreateProduct, setShowCreateProduct] = useState(false);

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
    }
  }, [open]);

  // Load categories
  useEffect(() => {
    if (open) {
      api.categories.getAll().then(cats => setAllCategories(cats)).catch(() => {});
    }
  }, [open]);

  // ─── Import handlers ────────────────────────────────────────────────────

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

      const items: ImportItem[] = pdfRows.map((row: Record<string, unknown>) => ({
        _key: `item-${(row.row_number as number) || 0}-${Date.now()}`,
        name: (row.name as string) || '',
        genericName: (row.generic_name as string) || '',
        expiryDate: (row.expiry_date as string) || '',
        parentUnit: (row.parent_unit as string) || 'Unit',
        childUnit: (row.child_unit as string) || '',
        convFactor: (row.conversion_factor as number) || 1,
        quantity: (row.quantity as number) || 0,
        costPerParent: (row.cost_per_parent as number) || 0,
        sellPrice: (row.cost_per_parent as number) > 0
          ? Math.round((row.cost_per_parent as number) * (1 + defaultMarkup / 100))
          : 0,
        sellPriceChild: (row.cost_per_parent as number) > 0 && (row.child_unit as string) && ((row.conversion_factor as number) || 1) > 1
          ? Math.floor(Math.round((row.cost_per_parent as number) * (1 + defaultMarkup / 100)) / ((row.conversion_factor as number) || 1))
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

  function addEmptyItem() {
    setImportItems(prev => [...prev, {
      _key: `item-new-${Date.now()}`,
      name: '', genericName: '', expiryDate: '',
      parentUnit: 'Unit', childUnit: '', convFactor: 1,
      quantity: 0, costPerParent: 0, sellPrice: 0, sellPriceChild: 0,
      batchNumber: generateBatchNumber(),
      barcode: '', categoryName: '', usageInstructions: '',
    }]);
    if (step === 'import') setStep('review');
    const newTotal = importItems.length + 1;
    const lastPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1);
    setReviewPage(lastPage);
  }

  // ─── Review handlers ───────────────────────────────────────────────────

  function updateItem(key: string, field: keyof ImportItem, value: string | number) {
    setImportItems(prev => prev.map(item => {
      if (item._key !== key) return item;
      const updated = { ...item, [field]: value };
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

  function removeItem(key: string) {
    setImportItems(prev => prev.filter(item => item._key !== key));
  }

  function saveEditingItem(updated: ImportItem) {
    setImportItems(prev => prev.map(item => item._key === updated._key ? updated : item));
    setEditedKeys(prev => new Set(prev).add(updated._key));
    setEditingItem(null);
  }

  const reviewErrors = importItems.filter(item => getItemErrors(item, t).length > 0).length;
  const reviewValid = importItems.length - reviewErrors;
  const reviewTotal = importItems.reduce((sum, item) => sum + (item.costPerParent * item.quantity), 0);
  const reviewTotalPages = Math.max(1, Math.ceil(importItems.length / PAGE_SIZE));
  const reviewPageItems = importItems.slice(reviewPage * PAGE_SIZE, (reviewPage + 1) * PAGE_SIZE);

  function canProceedFromReview(): boolean {
    return importItems.length > 0 && reviewErrors === 0;
  }

  // ─── Match handlers ────────────────────────────────────────────────────

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

  async function handleProductCreated() {
    try {
      const products = await api.products.getAll();
      setAllProducts(products);
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
      // Non-critical
    }
  }

  const matchTotalPages = Math.max(1, Math.ceil(matchedItems.length / PAGE_SIZE));
  const matchPageItems = matchedItems.slice(matchPage * PAGE_SIZE, (matchPage + 1) * PAGE_SIZE);
  const matchedCount = matchedItems.filter(i => i.matchType === 'existing').length;
  const newCount = matchedItems.filter(i => i.matchType === 'new').length;

  // ─── Submit ────────────────────────────────────────────────────────────

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

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Add Items to Purchase')} — {purchaseNumber}</DialogTitle>
          <DialogDescription>
            {step === 'import' && t('Import items from a PDF invoice or add them manually.')}
            {step === 'review' && t('Review and edit the imported items before matching.')}
            {step === 'match' && t('Match imported items to existing products or create new ones.')}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={step === 'import' ? 'default' : 'secondary'}>1. {t('Import')}</Badge>
          <ChevronRight className="h-3 w-3" />
          <Badge variant={step === 'review' ? 'default' : 'secondary'}>2. {t('Review')}</Badge>
          <ChevronRight className="h-3 w-3" />
          <Badge variant={step === 'match' ? 'default' : 'secondary'}>3. {t('Match')}</Badge>
        </div>

        {/* ─── Step 1: Import ─────────────────────────────────────────── */}
        {step === 'import' && (
          <div className="space-y-4">
            <div
              className={cn(
                'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors',
                dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25',
              )}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
              onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file && file.name.toLowerCase().endsWith('.pdf')) handlePdfFile(file);
                else toast.error(t('Please upload a PDF file'));
              }}
            >
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('Drag & drop a PDF invoice or click to browse')}</p>
              <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleFileChange} />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={parsing}>
                {parsing ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : <FileText className="me-1 h-4 w-4" />}
                {t('Choose PDF')}
              </Button>
            </div>
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

        {/* ─── Step 2: Review ─────────────────────────────────────────── */}
        {step === 'review' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={addEmptyItem} className="gap-1">
                <Plus className="h-3.5 w-3.5" />
                {t('Add Row')}
              </Button>
              <div className="flex-1" />
              <Badge variant="default">{reviewValid} {t('valid')}</Badge>
              {reviewErrors > 0 && <Badge variant="destructive">{reviewErrors} {t('errors')}</Badge>}
            </div>

            <div className="overflow-auto rounded-md border max-h-[45vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>{t('Name')}</TableHead>
                    <TableHead className="w-20">{t('Qty')}</TableHead>
                    <TableHead className="w-24">{t('Cost')}</TableHead>
                    <TableHead className="w-24">{t('Sell')}</TableHead>
                    <TableHead className="w-28">{t('Expiry')}</TableHead>
                    <TableHead className="w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewPageItems.map((item, idx) => {
                    const errors = getItemErrors(item, t);
                    const globalIdx = reviewPage * PAGE_SIZE + idx + 1;
                    return (
                      <TableRow key={item._key} className={cn(errors.length > 0 && 'bg-destructive/5')}>
                        <TableCell className={cn(
                          'text-xs font-mono',
                          editedKeys.has(item._key) && 'text-emerald-600 font-bold',
                        )}>
                          {editedKeys.has(item._key) && <CheckCircle2 className="inline h-3 w-3 me-0.5" />}
                          {globalIdx}
                        </TableCell>
                        <TableCell>
                          <Input
                            value={item.name}
                            onChange={e => updateItem(item._key, 'name', e.target.value)}
                            className="h-7 text-xs"
                            placeholder={t('Product name')}
                          />
                          {errors.length > 0 && (
                            <div className="flex items-center gap-1 mt-0.5">
                              <XCircle className="h-3 w-3 text-destructive shrink-0" />
                              <span className="text-[10px] text-destructive">{errors.join(', ')}</span>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number" min={0}
                            value={item.quantity || ''}
                            onChange={e => updateItem(item._key, 'quantity', Number(e.target.value) || 0)}
                            className="h-7 text-xs w-16"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number" min={0}
                            value={item.costPerParent || ''}
                            onChange={e => updateItem(item._key, 'costPerParent', Number(e.target.value) || 0)}
                            className="h-7 text-xs w-20"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number" min={0}
                            value={item.sellPrice || ''}
                            onChange={e => updateItem(item._key, 'sellPrice', Number(e.target.value) || 0)}
                            className="h-7 text-xs w-20"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="date"
                            value={item.expiryDate}
                            onChange={e => updateItem(item._key, 'expiryDate', e.target.value)}
                            className="h-7 text-xs"
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-0.5">
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingItem(item)}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => removeItem(item._key)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Review pagination */}
            {reviewTotalPages > 1 && (
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-muted-foreground">{reviewPage + 1} / {reviewTotalPages}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={reviewPage <= 0} onClick={() => setReviewPage(p => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={reviewPage >= reviewTotalPages - 1} onClick={() => setReviewPage(p => p + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t('Total')}: {formatCurrency(reviewTotal)} — {importItems.length} {t('items')}
            </p>
          </div>
        )}

        {/* ─── Step 3: Match ──────────────────────────────────────────── */}
        {step === 'match' && (
          <div className="space-y-3">
            {matchLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Badge variant="default">{matchedCount} {t('matched')}</Badge>
                  <Badge variant="secondary">{newCount} {t('new')}</Badge>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => setShowCreateProduct(true)} className="gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    {t('Create Product')}
                  </Button>
                </div>

                <div className="overflow-auto rounded-md border max-h-[45vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>{t('Imported Name')}</TableHead>
                        <TableHead>{t('Match')}</TableHead>
                        <TableHead className="w-32">{t('Type')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchPageItems.map((item, idx) => {
                        const globalIdx = matchPage * PAGE_SIZE + idx + 1;
                        const searchVal = matchSearches[item._key] ?? '';
                        const filteredProducts = searchVal
                          ? allProducts.filter(p => p.name.toLowerCase().includes(searchVal.toLowerCase()))
                          : allProducts;
                        return (
                          <TableRow key={item._key}>
                            <TableCell className="text-xs font-mono">{globalIdx}</TableCell>
                            <TableCell className="text-sm">{item.name}</TableCell>
                            <TableCell>
                              {item.matchType === 'existing' ? (
                                <div className="flex items-center gap-1.5">
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                                  <span className="text-xs">{item.matchedProductName}</span>
                                  <Button
                                    variant="ghost" size="icon" className="h-5 w-5 ms-1"
                                    onClick={() => setMatchType(item._key, 'new')}
                                  >
                                    <XCircle className="h-3 w-3" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  <div className="relative">
                                    <Search className="absolute start-1.5 top-1.5 h-3 w-3 text-muted-foreground" />
                                    <Input
                                      value={searchVal}
                                      onChange={e => setMatchSearches(prev => ({ ...prev, [item._key]: e.target.value }))}
                                      className="h-6 text-xs ps-6"
                                      placeholder={t('Search products...')}
                                    />
                                  </div>
                                  {searchVal && filteredProducts.length > 0 && (
                                    <div className="max-h-24 overflow-auto rounded border text-xs">
                                      {filteredProducts.slice(0, 5).map(p => (
                                        <button
                                          key={p.id}
                                          className="w-full text-start px-2 py-1 hover:bg-muted"
                                          onClick={() => {
                                            setMatchType(item._key, 'existing', p.id, p.name, p.category_name || '');
                                            setMatchSearches(prev => ({ ...prev, [item._key]: '' }));
                                          }}
                                        >
                                          {p.name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant={item.matchType === 'existing' ? 'default' : 'secondary'}>
                                {item.matchType === 'existing' ? t('Existing') : t('New')}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Match pagination */}
                {matchTotalPages > 1 && (
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground">{matchPage + 1} / {matchTotalPages}</span>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={matchPage <= 0} onClick={() => setMatchPage(p => p - 1)}>
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={matchPage >= matchTotalPages - 1} onClick={() => setMatchPage(p => p + 1)}>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ─── Footer ─────────────────────────────────────────────────── */}
        <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
          <div className="flex gap-2">
            {step === 'review' && (
              <Button variant="outline" onClick={() => setStep('import')} className="gap-1">
                <ChevronLeft className="h-4 w-4" />
                {t('Back')}
              </Button>
            )}
            {step === 'match' && (
              <Button variant="outline" onClick={() => setStep('review')} className="gap-1">
                <ChevronLeft className="h-4 w-4" />
                {t('Back')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            {step === 'review' && (
              <Button onClick={enterMatchStep} disabled={!canProceedFromReview()} className="gap-1">
                {t('Next')}
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
            {step === 'match' && (
              <Button onClick={handleSubmit} disabled={submitting || matchedItems.length === 0} className="gap-1.5">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('Add Items')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      {/* ─── Edit Item Dialog ──────────────────────────────────────────── */}
      <EditItemDialog
        item={editingItem}
        onClose={() => setEditingItem(null)}
        onSave={saveEditingItem}
        categories={allCategories}
        onCreateCategory={async (name: string) => {
          try {
            await api.categories.create(name);
            const cats = await api.categories.getAll();
            setAllCategories(cats);
          } catch { /* non-critical */ }
        }}
        defaultMarkup={defaultMarkup}
      />

      {/* ─── Create Product Dialog ─────────────────────────────────────── */}
      {showCreateProduct && (
        <Dialog open={showCreateProduct} onOpenChange={setShowCreateProduct}>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('Create Product')}</DialogTitle>
              <DialogDescription>{t('Create a new product in the system.')}</DialogDescription>
            </DialogHeader>
            <ProductForm
              onSaved={() => { setShowCreateProduct(false); handleProductCreated(); }}
              onCancel={() => setShowCreateProduct(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}

// ─── Edit Item Dialog (matches CreatePurchaseFlow EditItemDialog) ─────────

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

  // Sync draft when item changes
  useEffect(() => {
    if (item) {
      setDraft({ ...item });
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
      // Reverse-calculate parent sell price from child sell price
      if (field === 'sellPriceChild' && updated.childUnit && updated.convFactor > 1) {
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
