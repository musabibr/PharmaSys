import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Loader2, Plus, Trash2, Save, Upload, ChevronLeft, ChevronRight,
  CheckCircle2, XCircle, Search, FileText, SkipForward, Clock, Pencil, PenLine,
} from 'lucide-react';
import { api, throwIfError } from '@/api';
import type { ExpensePaymentMethod, Product, Category } from '@/api/types';
import { useSettingsStore } from '@/stores/settings.store';
import { formatCurrency, cn } from '@/lib/utils';
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
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { SupplierSelect } from './SupplierSelect';
import { ProductForm } from '@/components/inventory/ProductForm';

// ─── Constants ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

/** Generate a default batch number: BN-YYYYMMDD-XXX */
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

type Step = 'import' | 'review' | 'match' | 'details';
const STEPS: Step[] = ['import', 'review', 'match', 'details'];

interface Installment {
  _key: string;
  dueDate: string;
  amount: number;
}

/** Manual item entry (separate from PDF-imported items) */
interface ManualItem {
  _key: string;
  productId: number | null;
  productName: string;
  quantity: number;
  costPerParent: number;
  sellPrice: number;
  sellPriceChild: number;
  expiryDate: string;
  batchNumber: string;
  parentUnit: string;
  childUnit: string;
  convFactor: number;
  categoryName: string;
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
  barcode: string;
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
  /** When true, skip the import step and go straight to manual entry */
  startManual?: boolean;
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

export function CreatePurchaseFlow({ onComplete, startManual }: CreatePurchaseFlowProps) {
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
  const [showProductForm, setShowProductForm] = useState(false);
  const [editingItem, setEditingItem] = useState<ImportItem | null>(null);
  const [editedKeys, setEditedKeys] = useState<Set<string>>(new Set());

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

  // Manual items mode (separate from PDF import)
  const [manualItems, setManualItems] = useState<ManualItem[]>([]);
  const [showManualProductForm, setShowManualProductForm] = useState(false);
  const [manualProductQuery, setManualProductQuery] = useState('');
  const [manualSearchOpen, setManualSearchOpen] = useState(false);
  const [manualMode, setManualMode] = useState<'items' | 'total'>('total');
  // Edit dialog state for manual items — uses ImportItem to reuse EditItemDialog
  const [manualEditItem, setManualEditItem] = useState<ImportItem | null>(null);
  const [manualEditKey, setManualEditKey] = useState<string | null>(null); // null = adding new, string = editing existing

  // Whether we have items from PDF (vs manual mode)
  const hasItems = importItems.length > 0;
  const hasManualItems = manualItems.length > 0;

  // Load categories on mount so they're available in Step 2 (Review)
  useEffect(() => {
    api.categories.getAll().then(cats => setAllCategories(cats)).catch(() => {});
  }, []);

  // Auto-skip to manual entry when startManual prop is set
  // Also reset all form state to prevent stale data from previous tab usage
  useEffect(() => {
    if (startManual) {
      setImportItems([]);
      setMatchedItems([]);
      setManualMode('items');
      setManualItems([]);
      setSupplierId(null);
      setInvoiceRef('');
      setPurchaseDate(new Date().toISOString().slice(0, 10));
      setTotalAmount(0);
      setAlertDays(7);
      setNotes('');
      setPaymentType('installments');
      setPaymentMethod('cash');
      setBankReference('');
      setInstallments([{ _key: crypto.randomUUID(), dueDate: '', amount: 0 }]);
      setInitialPayment(0);
      setInitialPayMethod('cash');
      setInitialPayRef('');
      setStep('details');
      api.products.getAll().then(p => setAllProducts(p)).catch(() => {});
      api.categories.getAll().then(c => setAllCategories(Array.isArray(c) ? c : [])).catch(() => {});
    }
  }, [startManual]);

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
    setManualMode('items');
    setStep('details');
    // Load products for manual item search
    api.products.getAll().then(p => setAllProducts(p)).catch(() => {});
  }

  // ─── Manual Items handlers ──────────────────────────────────────────────────

  /** Open the EditItemDialog pre-populated from a product (or blank) to add a manual item */
  function openManualItemDialog(product?: Product) {
    const importItem: ImportItem = {
      _key: `manual-${Date.now()}`,
      name: product?.name ?? '',
      genericName: product?.generic_name ?? '',
      expiryDate: '',
      parentUnit: product?.parent_unit ?? 'Box',
      childUnit: product?.child_unit ?? '',
      convFactor: product?.conversion_factor ?? 1,
      quantity: 1,
      costPerParent: 0,
      sellPrice: product?.selling_price ?? 0,
      sellPriceChild: product?.selling_price_child ?? 0,
      batchNumber: generateBatchNumber(),
      barcode: product?.barcode ?? '',
      categoryName: product?.category_name ?? '',
      usageInstructions: product?.usage_instructions ?? '',
    };
    setManualEditKey(null); // null = adding new
    setManualEditItem(importItem);
    setManualProductQuery('');
    setManualSearchOpen(false);
  }

  /** Open the EditItemDialog to edit an existing manual item */
  function editManualItem(item: ManualItem) {
    const importItem: ImportItem = {
      _key: item._key,
      name: item.productName,
      genericName: '',
      expiryDate: item.expiryDate,
      parentUnit: item.parentUnit,
      childUnit: item.childUnit,
      convFactor: item.convFactor,
      quantity: item.quantity,
      costPerParent: item.costPerParent,
      sellPrice: item.sellPrice,
      sellPriceChild: item.sellPriceChild,
      batchNumber: item.batchNumber,
      barcode: '',
      categoryName: item.categoryName,
      usageInstructions: '',
    };
    setManualEditKey(item._key); // editing existing
    setManualEditItem(importItem);
  }

  /** Save from the EditItemDialog back into manual items list */
  function saveManualEditItem(updated: ImportItem) {
    const manual: ManualItem = {
      _key: updated._key,
      productId: null, // will be resolved on submit if product exists
      productName: updated.name,
      quantity: updated.quantity,
      costPerParent: updated.costPerParent,
      sellPrice: updated.sellPrice,
      sellPriceChild: updated.sellPriceChild,
      expiryDate: updated.expiryDate,
      batchNumber: updated.batchNumber,
      parentUnit: updated.parentUnit,
      childUnit: updated.childUnit,
      convFactor: updated.convFactor,
      categoryName: updated.categoryName,
    };
    // Try to match to an existing product by name
    const matched = allProducts.find(p => p.name.toLowerCase() === updated.name.toLowerCase());
    if (matched) manual.productId = matched.id;

    if (manualEditKey) {
      // Editing existing item — replace
      setManualItems(prev => prev.map(m => m._key === manualEditKey ? manual : m));
    } else {
      // Adding new
      setManualItems(prev => [...prev, manual]);
    }
    setManualEditItem(null);
    setManualEditKey(null);
  }

  /** Called after ProductForm creates a new product — refresh list and open edit dialog */
  async function handleManualProductCreated() {
    try {
      const products = await api.products.getAll();
      setAllProducts(products);
      // Find the newest product (highest id) and open edit dialog for it
      if (products.length > 0) {
        const newest = products.reduce((a, b) => (a.id > b.id ? a : b));
        openManualItemDialog(newest);
      }
    } catch {
      // fallback: just refresh
    }
  }


  function removeManualItem(key: string) {
    setManualItems(prev => prev.filter(i => i._key !== key));
  }


  const manualSearchResults = manualProductQuery.trim().length >= 2
    ? allProducts.filter(p => {
        const q = normalizeForMatch(manualProductQuery);
        return normalizeForMatch(p.name).includes(q) ||
          (p.generic_name && normalizeForMatch(p.generic_name).includes(q)) ||
          (p.barcode && p.barcode.includes(manualProductQuery.trim()));
      }).slice(0, 8)
    : [];

  const manualItemsTotal = manualItems.reduce((sum, item) => sum + (item.costPerParent * item.quantity), 0);

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
    : hasManualItems ? manualItemsTotal : totalAmount;

  const installmentTotal = installments.reduce((sum, i) => sum + (i.amount || 0), 0);
  const installmentDiff = invoiceTotal - installmentTotal - (initialPayment || 0);

  // ─── Submit ─────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!hasItems && !hasManualItems && manualMode === 'items') {
      toast.error(t('Add at least one item or switch to Total Only'));
      return;
    }
    if (!invoiceTotal || invoiceTotal <= 0) {
      toast.error(t('Invoice total is required'));
      return;
    }
    if (!purchaseDate) {
      toast.error(t('Purchase date is required'));
      return;
    }

    // Validate manual items
    if (hasManualItems) {
      for (let i = 0; i < manualItems.length; i++) {
        if (!manualItems[i].productName.trim()) {
          toast.error(t('Item {{n}} is missing a product name', { n: i + 1 }));
          return;
        }
        if (manualItems[i].quantity <= 0) {
          toast.error(t('Item {{n}} quantity must be greater than 0', { n: i + 1 }));
          return;
        }
        if (manualItems[i].costPerParent <= 0) {
          toast.error(t('Item {{n}} cost must be greater than 0', { n: i + 1 }));
          return;
        }
      }
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
      // Build items array from matched items (PDF) or manual items
      let purchaseItems;
      if (hasItems) {
        purchaseItems = matchedItems.map(item => {
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
      } else if (hasManualItems) {
        purchaseItems = manualItems.map(item => {
          if (item.productId) {
            return {
              product_id: item.productId,
              quantity: item.quantity,
              cost_per_parent: item.costPerParent,
              selling_price_parent: item.sellPrice,
              selling_price_child: item.sellPriceChild || undefined,
              expiry_date: item.expiryDate || '',
              batch_number: item.batchNumber || undefined,
            };
          } else {
            return {
              new_product: {
                name: item.productName,
                category_name: item.categoryName || undefined,
                parent_unit: item.parentUnit || 'Unit',
                child_unit: item.childUnit || undefined,
                conversion_factor: item.convFactor || 1,
              },
              quantity: item.quantity,
              cost_per_parent: item.costPerParent,
              selling_price_parent: item.sellPrice,
              selling_price_child: item.sellPriceChild || undefined,
              expiry_date: item.expiryDate || '',
              batch_number: item.batchNumber || undefined,
            };
          }
        });
      }

      // Build installment plan — prepend initial payment if specified
      const allInstallments = paymentType === 'installments'
        ? [
            ...(initialPayment > 0 ? [{ due_date: purchaseDate, amount: initialPayment }] : []),
            ...installments.map(i => ({ due_date: i.dueDate, amount: i.amount })),
          ]
        : undefined;

      throwIfError(await api.purchases.create({
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
        // Pass initial payment to backend for atomic handling (creates expense + marks paid)
        initial_payment: paymentType === 'installments' && initialPayment > 0
          ? {
              amount: initialPayment,
              payment_method: initialPayMethod,
              reference_number: initialPayMethod === 'bank_transfer' ? initialPayRef.trim() : undefined,
            }
          : undefined,
      }));

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
    hasItems, hasManualItems, matchedItems, manualItems, manualMode, onComplete, t, totalAmount,
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

            {/* Skip to manual entry */}
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="lg"
                onClick={handleSkipToManual}
                className="gap-2"
              >
                <PenLine className="h-4 w-4" />
                <div className="flex flex-col items-start">
                  <span className="text-sm font-medium">{t('Enter Invoice Manually')}</span>
                  <span className="text-xs text-muted-foreground">{t('Skip PDF import and enter items or total directly')}</span>
                </div>
              </Button>
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
          {/* ── 1. Purchase Identification ──────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>{t('Purchase Details')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Purchase Date + Invoice Number (identification first) */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{t('Purchase Date')}</Label>
                  <Input
                    type="date"
                    value={purchaseDate}
                    onChange={e => setPurchaseDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('Invoice Number')}</Label>
                  <Input
                    value={invoiceRef}
                    onChange={e => setInvoiceRef(e.target.value)}
                    placeholder={t('Invoice #')}
                  />
                </div>
              </div>

              {/* Supplier */}
              <div className="space-y-1.5">
                <Label>{t('Supplier')}</Label>
                <SupplierSelect value={supplierId} onChange={(id) => setSupplierId(id)} />
              </div>
            </CardContent>
          </Card>

          {/* ── 2. Items ───────────────────────────────────────────────────────── */}
          {/* PDF mode: summary of imported items */}
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

          {/* Manual mode: item entry or total-only */}
          {!hasItems && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{t('Items')}</CardTitle>
                  <div className="flex items-center gap-1 rounded-md border p-0.5">
                    <button
                      className={cn(
                        'px-3 py-1 text-xs rounded-sm transition-colors',
                        manualMode === 'items'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setManualMode('items')}
                    >
                      {t('Add Items')}
                    </button>
                    <button
                      className={cn(
                        'px-3 py-1 text-xs rounded-sm transition-colors',
                        manualMode === 'total'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setManualMode('total')}
                    >
                      {t('Total Only')}
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {manualMode === 'items' ? (
                  <>
                    {/* Product search bar */}
                    <div className="relative">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                          <Input
                            value={manualProductQuery}
                            onChange={e => {
                              setManualProductQuery(e.target.value);
                              setManualSearchOpen(true);
                            }}
                            onFocus={() => setManualSearchOpen(true)}
                            placeholder={t('Search products or type new name...')}
                            className="ps-9"
                          />
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 shrink-0"
                          onClick={() => setShowManualProductForm(true)}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t('New Product')}
                        </Button>
                      </div>
                      {/* Search results dropdown */}
                      {manualSearchOpen && manualProductQuery.trim().length >= 2 && (
                        <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                          {manualSearchResults.length > 0 ? (
                            <div className="max-h-48 overflow-y-auto p-1">
                              {manualSearchResults.map(p => (
                                <button
                                  key={p.id}
                                  className="w-full flex items-center justify-between text-start px-3 py-2 text-sm hover:bg-accent rounded-sm"
                                  onClick={() => openManualItemDialog(p)}
                                >
                                  <div>
                                    <span className="font-medium">{p.name}</span>
                                    {p.generic_name && (
                                      <span className="text-xs text-muted-foreground ms-2">({p.generic_name})</span>
                                    )}
                                  </div>
                                  {(p.selling_price ?? 0) > 0 && (
                                    <span className="text-xs text-muted-foreground">{formatCurrency(p.selling_price!)}</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="p-3 text-center">
                              <p className="text-sm text-muted-foreground">{t('No products found')}</p>
                              <Button
                                variant="link"
                                size="sm"
                                className="mt-1 gap-1"
                                onClick={() => { setManualSearchOpen(false); setShowManualProductForm(true); }}
                              >
                                <Plus className="h-3 w-3" />
                                {t('Create new product')}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Manual items list — click to edit via full dialog */}
                    {manualItems.length > 0 && (
                      <div className="space-y-2">
                        {manualItems.map((item, idx) => {
                          const hasError = !item.productName || item.quantity <= 0 || item.costPerParent <= 0;
                          return (
                            <div
                              key={item._key}
                              className={cn(
                                'flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors',
                                hasError && 'border-destructive/50 bg-destructive/5',
                              )}
                              onClick={() => editManualItem(item)}
                            >
                              <span className="text-xs text-muted-foreground w-5 shrink-0">{idx + 1}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium truncate">{item.productName || t('Unnamed')}</span>
                                  {item.productId ? (
                                    <Badge variant="outline" className="text-[10px] shrink-0">{t('Existing')}</Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-[10px] shrink-0">{t('New')}</Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                                  <span>{t('Qty')}: {item.quantity}</span>
                                  <span>{t('Cost')}: {formatCurrency(item.costPerParent)}</span>
                                  <span>{t('Sell')}: {formatCurrency(item.sellPrice)}</span>
                                  {item.childUnit && <span>{item.parentUnit} → {item.childUnit} (×{item.convFactor})</span>}
                                  {item.expiryDate && <span>{t('Exp')}: {item.expiryDate}</span>}
                                  {item.batchNumber && <span>{t('Batch')}: {item.batchNumber}</span>}
                                </div>
                              </div>
                              <span className="text-sm font-semibold tabular-nums shrink-0">
                                {formatCurrency(item.costPerParent * item.quantity)}
                              </span>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground"
                                  onClick={(e) => { e.stopPropagation(); editManualItem(item); }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  onClick={(e) => { e.stopPropagation(); removeManualItem(item._key); }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Items total */}
                    {manualItems.length > 0 && (
                      <div className="flex justify-end">
                        <div className="text-sm">
                          <span className="text-muted-foreground">{t('Items Total')}: </span>
                          <span className="font-semibold text-base">{formatCurrency(manualItemsTotal)}</span>
                          <span className="text-xs text-muted-foreground ms-1">
                            ({manualItems.length} {manualItems.length === 1 ? t('item') : t('items')})
                          </span>
                        </div>
                      </div>
                    )}

                    {manualItems.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <Search className="h-8 w-8 text-muted-foreground/40 mb-2" />
                        <p className="text-sm text-muted-foreground">{t('Search for products above to add items')}</p>
                        <p className="text-xs text-muted-foreground mt-1">{t('or switch to "Total Only" for a quick entry')}</p>
                      </div>
                    )}
                  </>
                ) : (
                  /* Total Only mode */
                  <div className="space-y-1.5">
                    <Label>{t('Invoice Total')} (SDG)</Label>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      value={totalAmount || ''}
                      onChange={e => setTotalAmount(Math.round(Number(e.target.value) || 0))}
                      placeholder="0"
                      autoFocus
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── 3. Additional Details ──────────────────────────────────────────── */}
          <Card>
            <CardContent className="pt-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {/* Invoice total (read-only when computed from items, or editable in total-only mode) */}
                {(hasItems || manualMode === 'items') && (
                  <div className="space-y-1.5">
                    <Label>{t('Invoice Total')} (SDG)</Label>
                    <Input
                      type="text"
                      value={formatCurrency(invoiceTotal)}
                      readOnly
                      className="bg-muted"
                    />
                  </div>
                )}
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

          {/* ── 4. Payment ─────────────────────────────────────────────────────── */}
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
                    <div>
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                        <Label className="font-semibold text-sm">{t('Amount Already Paid')}</Label>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 ms-6">
                        {t('Enter the amount already paid to the supplier before recording this invoice')}
                      </p>
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
                    {invoiceTotal > 0 && initialPayment > 0 && (
                      <div className="flex items-center gap-3 text-xs pt-1 border-t">
                        <span>{t('Total')}: <strong>{formatCurrency(invoiceTotal)}</strong></span>
                        <span>{t('Already Paid')}: <strong className="text-emerald-600 dark:text-emerald-400">{formatCurrency(initialPayment)}</strong></span>
                        <span>{t('Remaining for installments')}: <strong>{formatCurrency(Math.max(0, invoiceTotal - initialPayment))}</strong></span>
                      </div>
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
                        {installments.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-4">
                              {initialPayment >= invoiceTotal
                                ? t('Full amount covered by initial payment')
                                : t('Add at least one installment')}
                            </TableCell>
                          </TableRow>
                        )}
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
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => removeInstallment(inst._key)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
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
        <div className="shrink-0 flex items-center justify-between border-t bg-background/95 backdrop-blur px-4 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep('review')}>
              <ChevronLeft className="me-1 h-4 w-4" />
              {t('Back')}
            </Button>
            <Button size="sm" onClick={() => setStep('details')}>
              {t('Next')}
              <ChevronRight className="ms-1 h-4 w-4" />
            </Button>
          </div>
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
          ) : (
            <Button variant="outline" onClick={() => { setManualItems([]); setManualProductQuery(''); setStep('import'); }}>
              <ChevronLeft className="me-1 h-4 w-4" />
              {t('Back')}
            </Button>
          )}
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

      <ProductForm
        open={showProductForm}
        onOpenChange={setShowProductForm}
        product={null}
        onSaved={handleProductCreated}
      />

      {/* ── Product Form for Manual Invoice mode ─────────────────────────── */}
      <ProductForm
        open={showManualProductForm}
        onOpenChange={setShowManualProductForm}
        product={null}
        onSaved={handleManualProductCreated}
      />

      {/* ── Edit Item Dialog for Manual Invoice mode ─────────────────────── */}
      <EditItemDialog
        item={manualEditItem}
        onClose={() => { setManualEditItem(null); setManualEditKey(null); }}
        onSave={saveManualEditItem}
        categories={allCategories}
        onCreateCategory={(name) => {
          if (!allCategories.find(c => c.name === name)) {
            setAllCategories(prev => [...prev, { id: -Date.now(), name }]);
          }
        }}
        defaultMarkup={defaultMarkup}
      />

      {/* ── Edit Item Dialog ─────────────────────────────────────────────── */}
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
    </div>
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

  // Sync draft when item changes
  useEffect(() => {
    if (item) {
      setDraft({ ...item });
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
