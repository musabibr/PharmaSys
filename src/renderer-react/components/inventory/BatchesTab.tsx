import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Batch, Product, Category } from '@/api/types';
import { useDebounce } from '@/hooks/useDebounce';
import { usePermission } from '@/hooks/usePermission';
import { formatCurrency, formatQuantity } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Package,
  Plus,
  Search,
  Filter,
  AlertTriangle,
  DollarSign,
  Layers,
  Edit,
  RefreshCw,
  Printer,
  X,
  Info,
} from 'lucide-react';
import { printHtml } from '@/lib/print';
import { BatchForm } from './BatchForm';
import { DamageReportForm } from './DamageReportForm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExpiryDaysRemaining(expiryDate: string): number {
  const expiry = new Date(expiryDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function getExpiryBadge(
  expiryDate: string,
  t: (key: string) => string
): { label: string; variant: 'destructive' | 'warning' | 'success' | 'secondary' } {
  const days = getExpiryDaysRemaining(expiryDate);
  if (days < 0) return { label: `${t('Expired')} (${Math.abs(days)}d)`, variant: 'destructive' };
  if (days === 0) return { label: t('Expires today'), variant: 'destructive' };
  if (days <= 30) return { label: `${days}d`, variant: 'warning' };
  if (days <= 90) return { label: `${days}d`, variant: 'secondary' };
  return { label: `${days}d`, variant: 'success' };
}

function getSellingPriceParent(batch: Batch): number {
  return batch.selling_price_parent_override || batch.selling_price_parent || 0;
}

function getCostPerChild(batch: Batch): number {
  return batch.cost_per_child_override || batch.cost_per_child || 0;
}

function getSellingPriceChild(batch: Batch): number {
  return batch.selling_price_child_override || batch.selling_price_child || 0;
}

/** Margin formula matching old version: (sell - cost) / cost * 100 */
function computeMargin(cost: number, sell: number): number | null {
  if (cost <= 0 || sell <= 0) return null;
  return Math.round(((sell - cost) / cost) * 100);
}

/** Stock status icon for product list */
function getStockIcon(product: Product): string {
  const stockBase = product.total_stock_base || 0;
  const cf = product.conversion_factor || 1;
  const stockParent = Math.floor(stockBase / cf);
  const minLevel = product.min_stock_level || 0;
  if (stockBase <= 0) return '⛔';
  if (stockParent <= minLevel) return '⚠️';
  return '✅';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpiryFilter = 'all' | 'expired' | 'lt30' | 'lt90' | 'gt90';
type StockFilter = 'all' | 'in_stock' | 'out_of_stock';
type SortOption = 'expiry_asc' | 'stock_asc' | 'stock_desc' | 'newest';

// ---------------------------------------------------------------------------
// BatchesTab
// ---------------------------------------------------------------------------

export function BatchesTab() {
  const { t } = useTranslation();
  const canEditInventory = usePermission('inventory.batches.manage');
  const canViewCosts = usePermission('inventory.view_costs');

  // ---- All products + categories (loaded once) ----
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // ---- Product search state ----
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 200);
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);

  // ---- Selected product ----
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  // ---- Batch data ----
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);

  // ---- Filters ----
  const [batchSearch, setBatchSearch] = useState('');
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [sortOption, setSortOption] = useState<SortOption>('expiry_asc');

  // ---- Dialogs ----
  const [batchFormOpen, setBatchFormOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [damageFormOpen, setDamageFormOpen] = useState(false);
  const [damageBatch, setDamageBatch] = useState<Batch | null>(null);

  // ---- Load ALL products + categories on mount ----
  useEffect(() => {
    Promise.all([
      api.products.getAll(),
      api.categories.getAll(),
    ])
      .then(([prods, cats]) => {
        setAllProducts(Array.isArray(prods) ? prods : []);
        setCategories(Array.isArray(cats) ? cats : []);
      })
      .catch(() => toast.error(t('Failed to load data')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Dropdown products filtered by category ----
  const dropdownProducts = useMemo(() => {
    if (categoryFilter === 'all') return allProducts;
    const catId = parseInt(categoryFilter, 10);
    return allProducts.filter((p) => p.category_id === catId);
  }, [allProducts, categoryFilter]);

  // ---- Search products (client-side, like old version) ----
  useEffect(() => {
    if (!debouncedSearch.trim()) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    const q = debouncedSearch.toLowerCase();
    const source = categoryFilter === 'all' ? allProducts : dropdownProducts;
    const matches = source.filter(
      (p) =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.generic_name && p.generic_name.toLowerCase().includes(q)) ||
        (p.barcode && p.barcode.toLowerCase().includes(q))
    ).slice(0, 20);

    setSearchResults(matches);
    setShowSearchResults(true);
  }, [debouncedSearch, allProducts, dropdownProducts, categoryFilter]);

  // ---- Load batches for selected product ----
  const loadBatches = useCallback(() => {
    if (!selectedProduct) {
      setBatches([]);
      return;
    }

    setBatchesLoading(true);
    api.batches.getByProduct(selectedProduct.id)
      .then(setBatches)
      .catch(() => toast.error(t('Failed to load batches')))
      .finally(() => setBatchesLoading(false));
  }, [selectedProduct]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  // ---- Summary calculations ----
  const summary = useMemo(() => {
    if (!selectedProduct || batches.length === 0) {
      return { totalStock: 0, costValue: 0, retailValue: 0 };
    }

    const cf = selectedProduct.conversion_factor || 1;
    let totalStock = 0;
    let costValue = 0;
    let retailValue = 0;

    for (const b of batches) {
      totalStock += b.quantity_base;
      const childCost = getCostPerChild(b) || (cf > 1 ? Math.floor(b.cost_per_parent / cf) : b.cost_per_parent);
      costValue += b.quantity_base * childCost;
      const childSell = getSellingPriceChild(b) || (cf > 1 ? Math.floor(getSellingPriceParent(b) / cf) : getSellingPriceParent(b));
      retailValue += b.quantity_base * childSell;
    }

    return { totalStock, costValue, retailValue };
  }, [batches, selectedProduct]);

  // ---- Filter & sort batches ----
  const filteredBatches = useMemo(() => {
    let result = [...batches];

    if (batchSearch.trim()) {
      const q = batchSearch.toLowerCase();
      result = result.filter(
        (b) => (b.batch_number ?? '').toLowerCase().includes(q)
      );
    }

    if (expiryFilter !== 'all') {
      result = result.filter((b) => {
        const days = getExpiryDaysRemaining(b.expiry_date);
        switch (expiryFilter) {
          case 'expired': return days < 0;
          case 'lt30': return days >= 0 && days <= 30;
          case 'lt90': return days >= 0 && days <= 90;
          case 'gt90': return days > 90;
          default: return true;
        }
      });
    }

    if (stockFilter !== 'all') {
      result = result.filter((b) => {
        if (stockFilter === 'in_stock') return b.quantity_base > 0;
        return b.quantity_base === 0;
      });
    }

    result.sort((a, b) => {
      switch (sortOption) {
        case 'expiry_asc':
          return a.expiry_date.localeCompare(b.expiry_date);
        case 'stock_asc':
          return a.quantity_base - b.quantity_base;
        case 'stock_desc':
          return b.quantity_base - a.quantity_base;
        case 'newest':
          return (b.id || 0) - (a.id || 0);
        default:
          return 0;
      }
    });

    return result;
  }, [batches, batchSearch, expiryFilter, stockFilter, sortOption]);

  // ---- Select product from dropdown ----
  function handleDropdownSelect(productIdStr: string) {
    if (!productIdStr || productIdStr === '_none') return;
    const productId = parseInt(productIdStr, 10);
    const product = allProducts.find((p) => p.id === productId);
    if (product) {
      setSelectedProduct(product);
      setSearchQuery('');
      setShowSearchResults(false);
    }
  }

  // ---- Select product from search ----
  function handleSelectProduct(product: Product) {
    setSelectedProduct(product);
    setSearchQuery('');
    setShowSearchResults(false);
  }

  // ---- Clear selection ----
  function handleClearProduct() {
    setSelectedProduct(null);
    setBatches([]);
    setSearchQuery('');
    setBatchSearch('');
    setExpiryFilter('all');
    setStockFilter('all');
    setSortOption('expiry_asc');
  }

  // ---- Print stock report ----
  function handlePrintStockReport() {
    if (!selectedProduct || filteredBatches.length === 0) return;

    const cf = selectedProduct.conversion_factor || 1;
    const rows = filteredBatches.map((b) => {
      const sellParent = getSellingPriceParent(b);
      const costChild = getCostPerChild(b) || (cf > 1 ? Math.floor(b.cost_per_parent / cf) : b.cost_per_parent);
      const sellChild = getSellingPriceChild(b) || (cf > 1 ? Math.floor(sellParent / cf) : sellParent);
      const margin = computeMargin(b.cost_per_parent, sellParent);
      const isChildOverridden = b.cost_per_child_override > 0;

      const costCols = canViewCosts ? `
        <td class="num">${formatCurrency(b.cost_per_parent)}</td>
        <td class="num">${formatCurrency(costChild)}${isChildOverridden ? ' ✏️' : ' (auto)'}</td>
        <td class="num">${formatCurrency(sellParent)}</td>
        <td class="num">${formatCurrency(sellChild)}</td>
        <td>${margin !== null ? `${margin}%` : '—'}</td>
      ` : '';

      return `<tr>
        <td>${b.batch_number || '—'}</td>
        <td>${b.expiry_date || '—'}</td>
        <td>${formatQuantity(b.quantity_base, selectedProduct.parent_unit, selectedProduct.child_unit, cf)}</td>
        ${costCols}
      </tr>`;
    }).join('');

    const costHeaders = canViewCosts ? `
      <th>${t('Cost/Base')}</th>
      <th>${t('Cost/Small')}</th>
      <th>${t('Sell/Base')}</th>
      <th>${t('Sell/Small')}</th>
      <th>${t('Margin')}</th>
    ` : '';

    const costSummary = canViewCosts ? `
      <p>${t('Cost Value')}: ${formatCurrency(summary.costValue)}</p>
      <p>${t('Retail Value')}: ${formatCurrency(summary.retailValue)}</p>
    ` : '';

    const html = `
      <div class="header">
        <div>
          <h2>${t('Stock Report')}: ${selectedProduct.name}</h2>
          <p>${t('Date')}: ${new Date().toLocaleDateString()}</p>
          ${selectedProduct.conversion_factor > 1 ? `<p>${selectedProduct.parent_unit} = ${selectedProduct.conversion_factor} ${selectedProduct.child_unit}</p>` : ''}
        </div>
        <div>
          <p>${t('Total Stock')}: ${formatQuantity(summary.totalStock, selectedProduct.parent_unit, selectedProduct.child_unit, cf)}</p>
          ${costSummary}
        </div>
      </div>
      <table>
        <thead><tr>
          <th>${t('Batch #')}</th>
          <th>${t('Expiry Date')}</th>
          <th>${t('Stock')}</th>
          ${costHeaders}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    printHtml(html);
  }

  // ---- Render ----
  return (
    <div className="flex h-full flex-col gap-4 p-4 overflow-hidden">
      {/* ---- Product Selector Section ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="h-4 w-4" />
            {t('Select Product')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Row 1: Category + Product dropdown + Refresh + Print + Add Batch */}
          <div className="flex items-end gap-3 flex-wrap">
            {/* Category filter */}
            <div className="w-48 space-y-1.5">
              <Label className="text-xs">{t('Category')}</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger>
                  <SelectValue placeholder={t('All Categories')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All Categories')}</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={String(cat.id)}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Product dropdown list */}
            <div className="flex-1 min-w-[250px] space-y-1.5">
              <Label className="text-xs">{t('Product')}</Label>
              <Select
                value={selectedProduct ? String(selectedProduct.id) : '_none'}
                onValueChange={handleDropdownSelect}
              >
                <SelectTrigger>
                  <SelectValue placeholder={`— ${t('Select a product')} (${dropdownProducts.length}) —`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">
                    — {t('Select a product')} ({dropdownProducts.length}) —
                  </SelectItem>
                  {dropdownProducts.map((p) => {
                    const icon = getStockIcon(p);
                    const stockLabel = formatQuantity(
                      p.total_stock_base || 0,
                      p.parent_unit,
                      p.child_unit,
                      p.conversion_factor
                    );
                    return (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {icon} {p.name} ({stockLabel})
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Refresh */}
            <Button
              variant="outline"
              size="icon"
              onClick={loadBatches}
              disabled={batchesLoading || !selectedProduct}
              title={t('Refresh')}
            >
              <RefreshCw className={`h-4 w-4 ${batchesLoading ? 'animate-spin' : ''}`} />
            </Button>

            {/* Print Stock Report */}
            <Button
              variant="outline"
              size="icon"
              onClick={handlePrintStockReport}
              disabled={filteredBatches.length === 0}
              title={t('Print Stock Report')}
            >
              <Printer className="h-4 w-4" />
            </Button>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Add Batch */}
            {canEditInventory && (
              <Button
                onClick={() => { setEditingBatch(null); setBatchFormOpen(true); }}
                disabled={!selectedProduct}
                className="shrink-0"
              >
                <Plus className="me-1.5 h-4 w-4" />
                {t('Add Batch')}
              </Button>
            )}
          </div>

          {/* Row 2: Text search */}
          <div className="relative">
            <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => {
                if (searchQuery.trim()) setShowSearchResults(true);
              }}
              placeholder={t('Or search by name, barcode, generic name...')}
              className="ps-9"
            />
            {/* Search results dropdown */}
            {showSearchResults && searchQuery.trim() && (
              <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
                {searchResults.length === 0 ? (
                  <div className="p-3 text-center text-sm text-muted-foreground">
                    {t('No products found')}
                  </div>
                ) : (
                  <ScrollArea className="max-h-48">
                    {searchResults.map((product) => {
                      const icon = getStockIcon(product);
                      const stockLabel = formatQuantity(
                        product.total_stock_base || 0,
                        product.parent_unit,
                        product.child_unit,
                        product.conversion_factor
                      );
                      const stockBase = product.total_stock_base || 0;
                      const cf = product.conversion_factor || 1;
                      const stockParent = Math.floor(stockBase / cf);
                      const minLevel = product.min_stock_level || 0;
                      const stockColor = stockBase <= 0 ? 'text-destructive' : stockParent <= minLevel ? 'text-yellow-600' : '';

                      return (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => handleSelectProduct(product)}
                          className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent transition-colors"
                        >
                          <span>
                            {icon} {product.name}
                            {product.generic_name && (
                              <span className="ms-1 text-xs text-muted-foreground">
                                ({product.generic_name})
                              </span>
                            )}
                          </span>
                          <span className={`text-xs tabular-nums ${stockColor}`}>
                            {stockLabel}
                          </span>
                        </button>
                      );
                    })}
                  </ScrollArea>
                )}
              </div>
            )}
          </div>

          {/* Selected product display */}
          {selectedProduct && (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-2.5">
              <Package className="h-5 w-5 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{selectedProduct.name}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedProduct.category_name ?? ''}
                  {selectedProduct.conversion_factor > 1
                    ? ` | ${selectedProduct.parent_unit} = ${selectedProduct.conversion_factor} ${selectedProduct.child_unit}`
                    : ` | ${selectedProduct.parent_unit}`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearProduct}
              >
                <X className="me-1 h-3 w-3" />
                {t('Clear')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Content (only when product selected) ---- */}
      {selectedProduct && (
        <>
          {/* ---- Summary Cards ---- */}
          <div className={`grid gap-3 ${canViewCosts ? 'grid-cols-3' : 'grid-cols-1'}`}>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Layers className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('Total Stock')}</p>
                  <p className="text-lg font-bold">
                    {batchesLoading ? (
                      <Skeleton className="h-6 w-24" />
                    ) : (
                      formatQuantity(
                        summary.totalStock,
                        selectedProduct.parent_unit,
                        selectedProduct.child_unit,
                        selectedProduct.conversion_factor
                      )
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>

            {canViewCosts && (
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
                    <DollarSign className="h-5 w-5 text-yellow-600" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('Cost Value')}</p>
                    <p className="text-lg font-bold">
                      {batchesLoading ? <Skeleton className="h-6 w-24" /> : formatCurrency(summary.costValue)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {canViewCosts && (
              <Card className="border-green-200 dark:border-green-900">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                    <DollarSign className="h-5 w-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('Retail Value')}</p>
                    <p className="text-lg font-bold text-green-600">
                      {batchesLoading ? <Skeleton className="h-6 w-24" /> : formatCurrency(summary.retailValue)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ---- Filter Bar ---- */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Batch #')}</Label>
              <div className="relative">
                <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={batchSearch}
                  onChange={(e) => setBatchSearch(e.target.value)}
                  placeholder={t('Search batch...')}
                  className="w-44 ps-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                <Filter className="me-1 inline h-3 w-3" />
                {t('Expiry Date')}
              </Label>
              <Select value={expiryFilter} onValueChange={(v) => setExpiryFilter(v as ExpiryFilter)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  <SelectItem value="expired">{t('Expired')}</SelectItem>
                  <SelectItem value="lt30">{t('Expiring < 30 days')}</SelectItem>
                  <SelectItem value="lt90">{t('Expiring < 90 days')}</SelectItem>
                  <SelectItem value="gt90">{t('Valid (> 90 days)')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('Stock')}</Label>
              <Select value={stockFilter} onValueChange={(v) => setStockFilter(v as StockFilter)}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  <SelectItem value="in_stock">{t('In Stock')}</SelectItem>
                  <SelectItem value="out_of_stock">{t('Out of Stock')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('Sort')}</Label>
              <Select value={sortOption} onValueChange={(v) => setSortOption(v as SortOption)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="expiry_asc">{t('Expiry (FIFO)')}</SelectItem>
                  <SelectItem value="stock_asc">{t('Stock Low-High')}</SelectItem>
                  <SelectItem value="stock_desc">{t('Stock High-Low')}</SelectItem>
                  <SelectItem value="newest">{t('Newest First')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ---- Batch Table ---- */}
          <ScrollArea className="flex-1 rounded-md border">
            {batchesLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : filteredBatches.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Layers className="h-10 w-10 text-muted-foreground/50" />
                <p className="mt-3 text-sm text-muted-foreground">
                  {batches.length === 0
                    ? t('No batches for this product')
                    : t('No batches match the current filters')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {batches.length === 0
                    ? t('Add a new batch to get started')
                    : t('Try adjusting your filters')}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 text-center">#</TableHead>
                    <TableHead>{t('Batch #')}</TableHead>
                    <TableHead>{t('Expiry Date')}</TableHead>
                    <TableHead>{t('Stock')}</TableHead>
                    {canViewCosts && (
                      <>
                        <TableHead className="text-end">{t('Cost/Base')}</TableHead>
                        <TableHead className="text-end">{t('Cost/Small')}</TableHead>
                        <TableHead className="text-end">{t('Sell/Base')}</TableHead>
                        <TableHead className="text-end">{t('Sell/Small')}</TableHead>
                        <TableHead className="text-end">{t('Margin')}</TableHead>
                      </>
                    )}
                    {canEditInventory && (
                      <TableHead className="text-end">{t('Actions')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBatches.map((batch, idx) => {
                    const cf = selectedProduct.conversion_factor || 1;
                    const sellParent = getSellingPriceParent(batch);
                    const costChild = getCostPerChild(batch);
                    const sellChild = getSellingPriceChild(batch);
                    const margin = computeMargin(batch.cost_per_parent, sellParent);

                    const isExpired = getExpiryDaysRemaining(batch.expiry_date) < 0;
                    const expiry = getExpiryBadge(batch.expiry_date, t);

                    // Child cost display: show "(auto)" if not overridden
                    const isChildCostOverridden = batch.cost_per_child_override > 0;
                    const displayCostChild = costChild || (cf > 1 ? Math.floor(batch.cost_per_parent / cf) : batch.cost_per_parent);

                    return (
                      <TableRow
                        key={batch.id}
                        className={isExpired ? 'opacity-50' : ''}
                      >
                        <TableCell className="text-center text-muted-foreground">{idx + 1}</TableCell>
                        <TableCell className="font-medium">
                          {batch.batch_number || '—'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={expiry.variant} className="text-xs">
                            {batch.expiry_date} {expiry.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-semibold">
                          {formatQuantity(
                            batch.quantity_base,
                            selectedProduct.parent_unit,
                            selectedProduct.child_unit,
                            cf
                          )}
                        </TableCell>
                        {canViewCosts && (
                          <>
                            <TableCell className="text-end tabular-nums">
                              {formatCurrency(batch.cost_per_parent)}
                            </TableCell>
                            <TableCell className="text-end tabular-nums">
                              {formatCurrency(displayCostChild)}
                              {isChildCostOverridden ? (
                                <span className="ms-1 text-xs" title={t('Override')}>✏️</span>
                              ) : cf > 1 ? (
                                <span className="ms-1 text-xs text-muted-foreground">({t('Auto')})</span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-end tabular-nums">
                              {formatCurrency(sellParent)}
                            </TableCell>
                            <TableCell className="text-end tabular-nums">
                              {formatCurrency(sellChild || (cf > 1 ? Math.floor(sellParent / cf) : sellParent))}
                              {batch.selling_price_child_override > 0 && (
                                <span className="ms-1 text-xs" title={t('Override')}>✏️</span>
                              )}
                            </TableCell>
                            <TableCell className="text-end">
                              {margin !== null ? (
                                <Badge
                                  variant={margin >= 20 ? 'success' : margin >= 0 ? 'warning' : 'destructive'}
                                  className="text-xs"
                                >
                                  {margin}%
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </>
                        )}
                        {canEditInventory && (
                          <TableCell className="text-end">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => { setEditingBatch(batch); setBatchFormOpen(true); }}
                                title={t('Edit prices')}
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-yellow-600 hover:text-yellow-700"
                                onClick={() => { setDamageBatch(batch); setDamageFormOpen(true); }}
                                title={t('Report damage / write-off')}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </ScrollArea>

          {/* ---- FIFO note ---- */}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground px-1">
            <Info className="h-3.5 w-3.5 shrink-0" />
            {t('Batches are sold using FIFO (First-In-First-Out) — earliest expiry is sold first.')}
            {selectedProduct.conversion_factor > 1 && (
              <span className="ms-1">
                | 1 {selectedProduct.parent_unit} = {selectedProduct.conversion_factor} {selectedProduct.child_unit}
              </span>
            )}
          </p>
        </>
      )}

      {/* ---- Empty state (no product selected) ---- */}
      {!selectedProduct && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <Package className="h-16 w-16 text-muted-foreground/30" />
          <p className="mt-4 text-lg font-medium text-muted-foreground">
            {t('Select a Product')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Choose a product from the dropdown or search by name to view its batches')}
          </p>
        </div>
      )}

      {/* ---- BatchForm dialog ---- */}
      {selectedProduct && (
        <BatchForm
          open={batchFormOpen}
          onOpenChange={setBatchFormOpen}
          productId={selectedProduct.id}
          productName={selectedProduct.name}
          parentUnit={selectedProduct.parent_unit}
          childUnit={selectedProduct.child_unit}
          conversionFactor={selectedProduct.conversion_factor}
          batch={editingBatch}
          onSaved={() => {
            loadBatches();
            // Also refresh product list to update stock counts
            api.products.getAll().then((prods) => {
              setAllProducts(Array.isArray(prods) ? prods : []);
            }).catch(() => {});
          }}
        />
      )}

      {/* ---- DamageReportForm dialog ---- */}
      {selectedProduct && (
        <DamageReportForm
          open={damageFormOpen}
          onOpenChange={setDamageFormOpen}
          batch={damageBatch}
          productName={selectedProduct.name}
          parentUnit={selectedProduct.parent_unit}
          childUnit={selectedProduct.child_unit}
          conversionFactor={selectedProduct.conversion_factor}
          onSaved={() => {
            loadBatches();
            api.products.getAll().then((prods) => {
              setAllProducts(Array.isArray(prods) ? prods : []);
            }).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
