import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Loader2, Plus, Trash2, Save, Upload, ChevronLeft, ChevronRight,
  CheckCircle2, XCircle, Search, FileText, SkipForward, Clock,
} from 'lucide-react';
import { api, throwIfError } from '@/api';
import type { ExpensePaymentMethod, Product, Category } from '@/api/types';
import { useSettingsStore } from '@/stores/settings.store';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { SupplierSelect } from './SupplierSelect';

// ─── Constants ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

// ─── Types ─────────────────────────────────────────────────────────────────

type Step = 'import' | 'review' | 'match' | 'details';
const STEPS: Step[] = ['import', 'review', 'match', 'details'];

interface Installment {
  _key: string;
  dueDate: string;
  amount: number;
}

/** Editable row from PDF parsing (used in Step 2: Review) */
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
  categoryName: string;
  usageInstructions: string;
}

/** Match result (used in Step 3: Match) */
interface MatchedItem extends ImportItem {
  matchType: 'new' | 'existing';
  matchedProductId: number | null;
  matchedProductName: string;
  categoryName: string;
}

interface CreatePurchaseFlowProps {
  onComplete: () => void;
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
  // Allow YYYY-MM (will be stored as-is) and YYYY-MM-DD
  const d = dateStr.length === 7
    ? new Date(dateStr + '-01T00:00:00')
    : new Date(dateStr + 'T00:00:00');
  return !isNaN(d.getTime());
}

function getItemErrors(item: ImportItem, t: (k: string) => string): string[] {
  const errors: string[] = [];
  if (!item.name.trim()) errors.push(t('Name is required'));
  // Expiry is optional — price lists often don't include it
  if (item.expiryDate && !isValidDate(item.expiryDate)) errors.push(t('Invalid date format'));
  if (item.quantity <= 0) errors.push(t('Quantity must be greater than 0'));
  if (item.costPerParent <= 0) errors.push(t('Cost must be greater than 0'));
  return errors;
}

// ─── Stepper ───────────────────────────────────────────────────────────────

function Stepper({ currentStep, hasItems }: { currentStep: Step; hasItems: boolean }) {
  const { t } = useTranslation();
  const stepLabels: Record<Step, string> = {
    import: t('Import'),
    review: t('Review'),
    match: t('Match'),
    details: t('Purchase'),
  };

  const currentIdx = STEPS.indexOf(currentStep);

  // If no items (manual mode), only show the details step
  if (!hasItems && currentStep === 'details') {
    return null;
  }

  return (
    <div className="flex items-center gap-1 mb-4">
      {STEPS.map((step, idx) => {
        const isCompleted = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        return (
          <div key={step} className="flex items-center gap-1 flex-1">
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
              <span className="text-xs whitespace-nowrap">{stepLabels[step]}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-1 ${
                idx < currentIdx ? 'bg-primary' : 'bg-border'
              }`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export function CreatePurchaseFlow({ onComplete }: CreatePurchaseFlowProps) {
  const { t } = useTranslation();
  const getSetting = useSettingsStore((s) => s.getSetting);
  const defaultMarkup = Number(getSetting('default_markup_percent', '20')) || 20;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step
  const [step, setStep] = useState<Step>('import');

  // Step 1: Import state
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);

  // Step 2: Review state — editable items
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [reviewPage, setReviewPage] = useState(0);
  const [pdfFileName, setPdfFileName] = useState('');

  // Step 3: Match state
  const [matchedItems, setMatchedItems] = useState<MatchedItem[]>([]);
  const [matchPage, setMatchPage] = useState(0);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [productSearch, setProductSearch] = useState<{ key: string; query: string } | null>(null);
  const [bulkCategory, setBulkCategory] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingCategoryForKey, setCreatingCategoryForKey] = useState<string | null>(null);

  // Step 4: Purchase details
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [invoiceRef, setInvoiceRef] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [alertDays, setAlertDays] = useState<number>(7);
  const [notes, setNotes] = useState('');
  const [paymentType, setPaymentType] = useState<'full' | 'installments'>('installments');
  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>('cash');
  const [bankReference, setBankReference] = useState('');
  const [installments, setInstallments] = useState<Installment[]>([
    { _key: 'inst-1', dueDate: '', amount: 0 },
  ]);
  const [initialPayment, setInitialPayment] = useState<number>(0);
  const [initialPayMethod, setInitialPayMethod] = useState<ExpensePaymentMethod>('cash');
  const [initialPayRef, setInitialPayRef] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Whether we have items from PDF (vs manual total-only mode)
  const hasItems = importItems.length > 0;

  // Load categories on mount so they're available in Step 2 (Review)
  useEffect(() => {
    api.categories.getAll().then(cats => setAllCategories(cats)).catch(() => {});
  }, []);

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
        batchNumber: '',
        categoryName: '',
        usageInstructions: '',
      }));

      setImportItems(items);
      setPdfFileName(file.name);
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

  function handleSkipToManual() {
    setImportItems([]);
    setMatchedItems([]);
    setStep('details');
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

  function removeItem(key: string) {
    setImportItems(prev => prev.filter(item => item._key !== key));
  }

  function addEmptyItem() {
    setImportItems(prev => [...prev, {
      _key: `item-new-${Date.now()}`,
      name: '', genericName: '', expiryDate: '',
      parentUnit: 'Unit', childUnit: '', convFactor: 1,
      quantity: 0, costPerParent: 0, sellPrice: 0, sellPriceChild: 0, batchNumber: '',
      categoryName: '', usageInstructions: '',
    }]);
    // Navigate to the last page
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

  // ─── Step 3: Match — auto-match on entering ───────────────────────────────

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
      item.matchType === 'new' ? { ...item, categoryName: catName } : item
    ));
  }

  // Filtered product search results for inline picker
  const searchResults = productSearch
    ? allProducts.filter(p =>
        normalizeForMatch(p.name).includes(normalizeForMatch(productSearch.query)) ||
        (p.generic_name && normalizeForMatch(p.generic_name).includes(normalizeForMatch(productSearch.query)))
      ).slice(0, 10)
    : [];

  const existingCount = matchedItems.filter(m => m.matchType === 'existing').length;
  const newCount = matchedItems.filter(m => m.matchType === 'new').length;
  const matchTotalPages = Math.max(1, Math.ceil(matchedItems.length / PAGE_SIZE));
  const matchPageItems = matchedItems.slice(matchPage * PAGE_SIZE, (matchPage + 1) * PAGE_SIZE);

  // ─── Step 4: Installment helpers ──────────────────────────────────────────

  const addInstallment = useCallback(() => {
    setInstallments(prev => [
      ...prev,
      { _key: `inst-${Date.now()}`, dueDate: '', amount: 0 },
    ]);
  }, []);

  const removeInstallment = useCallback((key: string) => {
    setInstallments(prev => prev.filter(i => i._key !== key));
  }, []);

  const updateInstallment = useCallback((key: string, field: 'dueDate' | 'amount', value: string | number) => {
    setInstallments(prev => prev.map(i =>
      i._key === key ? { ...i, [field]: value } : i
    ));
  }, []);

  const invoiceTotal = hasItems
    ? matchedItems.reduce((sum, item) => sum + (item.costPerParent * item.quantity), 0)
    : totalAmount;

  const installmentTotal = installments.reduce((sum, i) => sum + (i.amount || 0), 0);
  const installmentDiff = invoiceTotal - installmentTotal - (initialPayment || 0);

  // ─── Submit ─────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!invoiceTotal || invoiceTotal <= 0) {
      toast.error(t('Invoice total is required'));
      return;
    }
    if (!purchaseDate) {
      toast.error(t('Purchase date is required'));
      return;
    }

    if (paymentType === 'installments') {
      if (installments.length === 0 && !initialPayment) {
        toast.error(t('At least one installment is required'));
        return;
      }
      for (let i = 0; i < installments.length; i++) {
        if (!installments[i].dueDate) {
          toast.error(t('Installment {{n}} is missing a due date', { n: i + 1 }));
          return;
        }
        if (!installments[i].amount || installments[i].amount <= 0) {
          toast.error(t('Installment {{n}} amount must be greater than 0', { n: i + 1 }));
          return;
        }
      }
      if (initialPayment > 0 && initialPayMethod === 'bank_transfer' && !initialPayRef.trim()) {
        toast.error(t('Reference number is required for bank transfers'));
        return;
      }
      if (Math.abs(installmentDiff) > 0) {
        toast.error(t('Installment amounts must equal the invoice total'));
        return;
      }
    }

    if (paymentType === 'full' && paymentMethod === 'bank_transfer' && !bankReference.trim()) {
      toast.error(t('Reference number is required for bank transfers'));
      return;
    }

    setSubmitting(true);
    try {
      // Build items array from matched items
      const purchaseItems = hasItems ? matchedItems.map(item => {
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
      }) : undefined;

      // Build installment plan — prepend initial payment if specified
      const allInstallments = paymentType === 'installments'
        ? [
            ...(initialPayment > 0 ? [{ due_date: purchaseDate, amount: initialPayment }] : []),
            ...installments.map(i => ({ due_date: i.dueDate, amount: i.amount })),
          ]
        : undefined;

      const result = throwIfError(await api.purchases.create({
        supplier_id: supplierId ?? undefined,
        invoice_reference: invoiceRef || undefined,
        purchase_date: purchaseDate,
        total_amount: invoiceTotal,
        alert_days_before: alertDays,
        notes: notes || undefined,
        items: purchaseItems,
        payment_plan: paymentType === 'full'
          ? { type: 'full' as const, payment_method: paymentMethod, reference_number: paymentMethod === 'bank_transfer' ? bankReference.trim() : undefined }
          : { type: 'installments', installments: allInstallments! },
      }));

      // Auto-mark initial payment as paid if specified
      if (paymentType === 'installments' && initialPayment > 0 && result?.payments?.length) {
        const firstPayment = result.payments.find(
          (p: { amount: number; is_paid: number }) => p.amount === initialPayment && !p.is_paid
        );
        if (firstPayment) {
          try {
            await api.purchases.markPaymentPaid(
              firstPayment.id,
              initialPayMethod,
              initialPayMethod === 'bank_transfer' ? initialPayRef.trim() : undefined
            );
          } catch {
            // Purchase was created but initial payment marking failed — user can pay later
            toast.warning(t('Purchase created but initial payment could not be recorded'));
          }
        }
      }

      toast.success(t('Purchase created successfully'));
      onComplete();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to create purchase'));
    } finally {
      setSubmitting(false);
    }
  }, [
    supplierId, invoiceRef, purchaseDate, invoiceTotal, alertDays, notes,
    paymentType, paymentMethod, bankReference, installments, installmentDiff,
    initialPayment, initialPayMethod, initialPayRef,
    hasItems, matchedItems, onComplete, t, totalAmount,
  ]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* Stepper — pinned top */}
      <div className="shrink-0 px-4 pt-3">
        <Stepper currentStep={step} hasItems={hasItems} />
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-4 px-4 py-3">

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* Step 1: Import */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 'import' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('Import Invoice')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('Upload PDF invoice or skip to enter manually')}
            </p>

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

            {/* Skip link */}
            <div className="flex justify-center">
              <button
                onClick={handleSkipToManual}
                className="text-sm text-muted-foreground hover:text-primary underline underline-offset-4 transition-colors"
              >
                <SkipForward className="inline h-3.5 w-3.5 me-1 -mt-0.5" />
                {t('Skip — enter total manually')}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* Step 2: Review & Edit */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 'review' && (
        <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t('Review Imported Data')}
              {pdfFileName && (
                <Badge variant="outline" className="font-normal">
                  <FileText className="me-1 h-3 w-3" />
                  {pdfFileName}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
                    <TableHead className="hidden xl:table-cell max-w-[15rem] whitespace-nowrap">{t('Generic Name')}</TableHead>
                    <TableHead className="hidden xl:table-cell whitespace-nowrap">{t('Category')}</TableHead>
                    <TableHead className="hidden xl:table-cell whitespace-nowrap">{t('Usage Instructions')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Expiry Date')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Base Unit')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Small Unit')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Conv')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Qty')}*</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Cost')}*</TableHead>
                    <TableHead className="whitespace-nowrap">{t('Sell/Base')}*</TableHead>
                    <TableHead className="hidden xl:table-cell whitespace-nowrap">{t('Sell/Small')}</TableHead>
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
                          {globalIdx + 1}
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
                        <TableCell className="hidden xl:table-cell max-w-[15rem]">
                          <Input
                            value={item.genericName}
                            onChange={e => updateItem(item._key, 'genericName', e.target.value)}
                            className="h-8 text-xs min-w-[6rem]"
                            placeholder={t('Generic')}
                            maxLength={60}
                          />
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
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
                        <TableCell className="hidden xl:table-cell">
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
                        <TableCell className="hidden xl:table-cell whitespace-nowrap">
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

          </CardContent>
        </Card>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* Step 3: Product Matching */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 'match' && (
        <>
        <Card>
          <CardHeader>
            <CardTitle>{t('Product Matching')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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

                {/* Bulk category for new items */}
                {newCount > 0 && (
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
                    <Label className="text-xs whitespace-nowrap">{t('Set category for all new items')}:</Label>
                    <Select
                      value={bulkCategory}
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
                        disabled={!newCategoryName.trim()}
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

                {/* Match table */}
                <div className="rounded-md border overflow-x-auto">
                  <Table className="sticky-col">
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>{t('Invoice Name')}</TableHead>
                        <TableHead>{t('Status')}</TableHead>
                        <TableHead>{t('Matched Product')}</TableHead>
                        <TableHead className="hidden xl:table-cell">{t('Category')}</TableHead>
                        <TableHead className="w-16">{t('Actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchPageItems.map((item, pageIdx) => {
                        const globalIdx = matchPage * PAGE_SIZE + pageIdx;
                        return (
                          <TableRow key={item._key}>
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
                                <div>
                                  <span className="text-sm">{item.matchedProductName}</span>
                                  {/* Inline search to change match */}
                                  {productSearch?.key === item._key ? (
                                    <div className="mt-1 space-y-1">
                                      <Input
                                        value={productSearch.query}
                                        onChange={e => setProductSearch({ key: item._key, query: e.target.value })}
                                        className="h-7 text-xs"
                                        placeholder={t('Search products...')}
                                        autoFocus
                                        onKeyDown={e => { if (e.key === 'Escape') setProductSearch(null); }}
                                      />
                                      {searchResults.length > 0 && (
                                        <div className="max-h-32 overflow-y-auto rounded border bg-popover text-xs">
                                          {searchResults.map(p => (
                                            <button
                                              key={p.id}
                                              className="w-full text-start px-2 py-1 hover:bg-accent"
                                              onClick={() => {
                                                setMatchType(item._key, 'existing', p.id, p.name, p.category_name || '');
                                                setProductSearch(null);
                                              }}
                                            >
                                              {p.name}
                                              {p.category_name && <span className="text-muted-foreground"> — {p.category_name}</span>}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                      <button
                                        className="text-xs text-primary hover:underline"
                                        onClick={() => {
                                          setMatchType(item._key, 'new');
                                          setProductSearch(null);
                                        }}
                                      >
                                        {t('Switch to new product')}
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden xl:table-cell">
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
                              {item.matchType === 'existing' ? (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-7 w-7"
                                  title={t('Search existing product')}
                                  onClick={() => setProductSearch({ key: item._key, query: '' })}
                                >
                                  <Search className="h-3.5 w-3.5" />
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-7 w-7"
                                  title={t('Search existing product')}
                                  onClick={() => setProductSearch({ key: item._key, query: item.name })}
                                >
                                  <Search className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {/* Show inline search for "new" items */}
                              {item.matchType === 'new' && productSearch?.key === item._key && (
                                <div className="absolute mt-1 z-10 w-64 space-y-1 bg-popover border rounded-md p-2 shadow-md">
                                  <Input
                                    value={productSearch.query}
                                    onChange={e => setProductSearch({ key: item._key, query: e.target.value })}
                                    className="h-7 text-xs"
                                    placeholder={t('Search products...')}
                                    autoFocus
                                    onKeyDown={e => { if (e.key === 'Escape') setProductSearch(null); }}
                                  />
                                  {searchResults.length > 0 && (
                                    <div className="max-h-32 overflow-y-auto text-xs">
                                      {searchResults.map(p => (
                                        <button
                                          key={p.id}
                                          className="w-full text-start px-2 py-1 hover:bg-accent rounded"
                                          onClick={() => {
                                            setMatchType(item._key, 'existing', p.id, p.name, p.category_name || '');
                                            setProductSearch(null);
                                          }}
                                        >
                                          {p.name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {searchResults.length === 0 && productSearch.query && (
                                    <p className="text-xs text-muted-foreground px-2 py-1">
                                      {t('No match found — will create new product')}
                                    </p>
                                  )}
                                </div>
                              )}
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
          </CardContent>
        </Card>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* Step 4: Purchase Details & Payment */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {step === 'details' && (
        <>
          {/* Items summary card (when items exist) */}
          {hasItems && (
            <Card className="bg-muted/30">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{pdfFileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {matchedItems.length} {t('items from PDF')} · {t('Total')}: {formatCurrency(invoiceTotal)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {existingCount} {t('existing products')} + {newCount} {t('new products')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('Purchase Details')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Supplier */}
              <div className="space-y-1.5">
                <Label>{t('Supplier')}</Label>
                <SupplierSelect value={supplierId} onChange={(id) => setSupplierId(id)} />
              </div>

              {/* Invoice Number + Date */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{t('Invoice Number')}</Label>
                  <Input
                    value={invoiceRef}
                    onChange={e => setInvoiceRef(e.target.value)}
                    placeholder={t('Invoice #')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('Purchase Date')}</Label>
                  <Input
                    type="date"
                    value={purchaseDate}
                    onChange={e => setPurchaseDate(e.target.value)}
                  />
                </div>
              </div>

              {/* Total + Alert days */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{t('Invoice Total')} (SDG)</Label>
                  {hasItems ? (
                    <Input
                      type="text"
                      value={formatCurrency(invoiceTotal)}
                      readOnly
                      className="bg-muted"
                    />
                  ) : (
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      value={totalAmount || ''}
                      onChange={e => setTotalAmount(Math.round(Number(e.target.value) || 0))}
                      placeholder="0"
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>{t('Alert Days Before Due')}</Label>
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    max="90"
                    value={alertDays}
                    onChange={e => setAlertDays(Math.round(Number(e.target.value) || 0))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('Show alert this many days before each due date')}
                  </p>
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label>{t('Notes')}</Label>
                <Textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={t('Optional notes')}
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          {/* Payment Section */}
          <Card>
            <CardHeader>
              <CardTitle>{t('Payment')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Payment Type */}
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="paymentType"
                    checked={paymentType === 'full'}
                    onChange={() => setPaymentType('full')}
                    className="accent-primary"
                  />
                  <span className="text-sm font-medium">{t('Pay in Full')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="paymentType"
                    checked={paymentType === 'installments'}
                    onChange={() => setPaymentType('installments')}
                    className="accent-primary"
                  />
                  <span className="text-sm font-medium">{t('Installments')}</span>
                </label>
              </div>

              {/* Pay in Full */}
              {paymentType === 'full' && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{t('Payment Method')}</Label>
                    <Select value={paymentMethod} onValueChange={v => { setPaymentMethod(v as ExpensePaymentMethod); if (v !== 'bank_transfer') setBankReference(''); }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">{t('Cash')}</SelectItem>
                        <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {paymentMethod === 'bank_transfer' && (
                    <div className="space-y-1.5">
                      <Label>{t('Reference Number')}*</Label>
                      <Input
                        value={bankReference}
                        onChange={e => setBankReference(e.target.value)}
                        placeholder={t('Enter reference number')}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Initial Payment + Installments */}
              {paymentType === 'installments' && (
                <div className="space-y-4">
                  {/* Amount Already Paid */}
                  <div className="rounded-md border bg-muted/30 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      <Label className="font-semibold text-sm">{t('Amount Already Paid')}</Label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Amount')} (SDG)</Label>
                        <Input
                          type="number"
                          step="1"
                          min="0"
                          max={invoiceTotal || undefined}
                          value={initialPayment || ''}
                          onChange={e => setInitialPayment(Math.round(Number(e.target.value) || 0))}
                          placeholder="0"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('Payment Method')}</Label>
                        <Select value={initialPayMethod} onValueChange={v => { setInitialPayMethod(v as ExpensePaymentMethod); if (v !== 'bank_transfer') setInitialPayRef(''); }}>
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cash">{t('Cash')}</SelectItem>
                            <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {initialPayMethod === 'bank_transfer' && initialPayment > 0 && (
                      <Input
                        value={initialPayRef}
                        onChange={e => setInitialPayRef(e.target.value)}
                        placeholder={t('Enter reference number')}
                        className="h-8"
                      />
                    )}
                  </div>

                  {/* Remaining installments */}
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm">{t('Remaining Installments')}</Label>
                  </div>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">#</TableHead>
                          <TableHead>{t('Due Date')}</TableHead>
                          <TableHead>{t('Amount')} (SDG)</TableHead>
                          <TableHead className="w-10"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {installments.map((inst, idx) => (
                          <TableRow key={inst._key}>
                            <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                            <TableCell>
                              <Input
                                type="date"
                                value={inst.dueDate}
                                onChange={e => updateInstallment(inst._key, 'dueDate', e.target.value)}
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                step="1"
                                min="0"
                                value={inst.amount || ''}
                                onChange={e => updateInstallment(inst._key, 'amount', Math.round(Number(e.target.value) || 0))}
                                className="h-8"
                                placeholder="0"
                              />
                            </TableCell>
                            <TableCell>
                              {installments.length > 1 && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  onClick={() => removeInstallment(inst._key)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Add row + totals */}
                  <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={addInstallment} className="gap-1">
                      <Plus className="h-3.5 w-3.5" />
                      {t('Add Installment')}
                    </Button>
                    <div className="text-sm text-end space-y-0.5">
                      {initialPayment > 0 && (
                        <div>
                          <span className="text-muted-foreground">{t('Already Paid')}: </span>
                          <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatCurrency(initialPayment)}</span>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">{t('Installments')}: </span>
                        <span className="font-medium">{formatCurrency(installmentTotal)}</span>
                      </div>
                      {invoiceTotal > 0 && installmentDiff !== 0 && (
                        <div className="text-destructive font-medium">
                          ({installmentDiff > 0 ? '-' : '+'}{formatCurrency(Math.abs(installmentDiff))} {t('remaining')})
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
      </div>{/* ← end scrollable content area */}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* Footer — pinned to bottom, always visible regardless of scroll        */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}

      {/* Step 2: Review footer */}
      {step === 'review' && (
        <div className="shrink-0 flex items-center justify-between border-t bg-background/95 backdrop-blur px-4 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
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
        </div>
      )}

      {/* Step 3: Match footer */}
      {step === 'match' && !matchLoading && (
        <div className="shrink-0 flex justify-between border-t bg-background/95 backdrop-blur px-4 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <Button variant="outline" size="sm" onClick={() => setStep('review')}>
            <ChevronLeft className="me-1 h-4 w-4" />
            {t('Back')}
          </Button>
          <Button size="sm" onClick={() => setStep('details')}>
            {t('Next')}
            <ChevronRight className="ms-1 h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Step 4: Details submit footer */}
      {step === 'details' && (
        <div className="shrink-0 flex items-center justify-between border-t bg-background/95 backdrop-blur px-4 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          {hasItems ? (
            <Button variant="outline" onClick={() => setStep('match')}>
              <ChevronLeft className="me-1 h-4 w-4" />
              {t('Back')}
            </Button>
          ) : <div />}
          <Button
            onClick={handleSubmit}
            disabled={submitting || !invoiceTotal}
            className="gap-1.5"
            size="lg"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {hasItems
              ? t('Confirm Purchase')
              : t('Create Purchase')}
          </Button>
        </div>
      )}
    </div>
  );
}
