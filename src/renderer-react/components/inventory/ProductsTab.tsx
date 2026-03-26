import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Search,
  Plus,
  Upload,
  Download,
  FolderPlus,
  Pencil,
  Trash2,
  PackageSearch,
  Loader2,
  ArrowUpDown,
  X,
} from 'lucide-react';
import type { Product, Category } from '@/api/types';
import { api } from '@/api';
import { formatQuantity } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { BulkImportDialog } from './BulkImportDialog';
import { ProductExportDialog } from './ProductExportDialog';
import { ProductImportDialog } from './ProductImportDialog';
import { useDebounce } from '@/hooks/useDebounce';
import { DataPagination } from '@/components/ui/data-pagination';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ProductForm } from './ProductForm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CATEGORIES = '__all__';
const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Inline category creation dialog
// ---------------------------------------------------------------------------

function AddCategoryDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose(isOpen: boolean) {
    if (!isOpen) {
      setName('');
      setError(null);
    }
    onOpenChange(isOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('Category name is required'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.categories.create(trimmed);
      toast.success(t('Category created'));
      onCreated();
      handleClose(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('Failed to create category'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Add Category')}</DialogTitle>
          <DialogDescription>{t('Create a new product category.')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">{t('Category Name')}</Label>
              <Input
                id="cat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('e.g. Antibiotics')}
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleClose(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <PackageSearch className="mb-3 h-12 w-12" />
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------

function DeleteConfirmDialog({
  open,
  onOpenChange,
  product,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!product) return;
    setDeleting(true);
    try {
      await api.products.delete(product.id);
      toast.success(t('Product deleted'));
      onConfirm();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete product'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Delete Product')}</DialogTitle>
          <DialogDescription>
            {t('Are you sure you want to delete')} <strong>{product?.name}</strong>?{' '}
            {t('This action cannot be undone.')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stock badge helper
// ---------------------------------------------------------------------------

function StockBadge({
  totalStockBase,
  minStockLevel,
  conversionFactor,
  parentUnit,
  childUnit,
}: {
  totalStockBase: number;
  minStockLevel: number;
  conversionFactor: number;
  parentUnit: string;
  childUnit: string;
}) {
  const { t } = useTranslation();
  const stockParent = Math.floor(totalStockBase / (conversionFactor || 1));

  let variant: 'destructive' | 'warning' | 'success';
  let label: string;

  if (totalStockBase === 0) {
    variant = 'destructive';
    label = t('Out of Stock');
  } else if (stockParent <= minStockLevel) {
    variant = 'warning';
    label = t('Low Stock');
  } else {
    variant = 'success';
    label = t('In Stock');
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm">
        {formatQuantity(totalStockBase, parentUnit, childUnit, conversionFactor)}
      </span>
      <Badge variant={variant} className="w-fit text-xs">
        {label}
      </Badge>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk delete dialog
// ---------------------------------------------------------------------------

function BulkDeleteProductsDialog({
  open,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery.trim(), 250);
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [toDelete, setToDelete] = useState<Product[]>([]);
  const [deleteInfoMap, setDeleteInfoMap] = useState<Map<number, { has_stock: boolean; batch_count: number; txn_count: number }>>(new Map());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open || debouncedSearch.length < 2) {
      setSearchResults([]);
      return;
    }
    api.products.search(debouncedSearch)
      .then((results) => setSearchResults(results.slice(0, 10)))
      .catch(() => setSearchResults([]));
  }, [open, debouncedSearch]);

  // Fetch delete info when a product is added to the list
  useEffect(() => {
    for (const p of toDelete) {
      if (!deleteInfoMap.has(p.id)) {
        api.products.getDeleteInfo(p.id).then((info) => {
          if (info) setDeleteInfoMap((prev) => new Map(prev).set(p.id, info));
        }).catch(() => {});
      }
    }
  }, [toDelete]); // eslint-disable-line

  function handleAdd(product: Product) {
    if (!toDelete.some((p) => p.id === product.id)) {
      setToDelete((prev) => [...prev, product]);
    }
    setSearchQuery('');
    setSearchResults([]);
  }

  function handleRemove(id: number) {
    setToDelete((prev) => prev.filter((p) => p.id !== id));
    setDeleteInfoMap((prev) => { const next = new Map(prev); next.delete(id); return next; });
  }

  async function handleConfirm() {
    if (toDelete.length === 0) return;
    setDeleting(true);
    try {
      const result = await api.products.bulkDelete(toDelete.map((p) => p.id));
      if (result.deleted.length > 0) {
        toast.success(t('{{count}} product(s) deleted', { count: result.deleted.length }));
      }
      if (result.errors && result.errors.length > 0) {
        for (const err of result.errors) {
          const product = toDelete.find((p) => p.id === err.id);
          toast.error(`${product?.name ?? `#${err.id}`}: ${err.reason}`);
        }
      }
      setToDelete([]);
      setDeleteInfoMap(new Map());
      onDeleted();
      if (result.deleted.length > 0) onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete products'));
    } finally {
      setDeleting(false);
    }
  }

  function handleClose() {
    if (deleting) return;
    setSearchQuery('');
    setSearchResults([]);
    setToDelete([]);
    setDeleteInfoMap(new Map());
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            {t('Bulk Delete Products')}
          </DialogTitle>
          <DialogDescription>
            {t('Search and add products to the delete list, then confirm.')}
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="space-y-1.5">
          <Label>{t('Search Product')}</Label>
          <div className="relative">
            <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('Type to search...')}
              className="ps-9"
              disabled={deleting}
            />
          </div>
          {searchResults.length > 0 && (
            <div className="rounded-md border bg-popover shadow-md max-h-40 overflow-y-auto">
              {searchResults.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => handleAdd(product)}
                  disabled={toDelete.some((p) => p.id === product.id)}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent transition-colors disabled:opacity-40"
                >
                  <span>{product.name}</span>
                  <span className="text-xs text-muted-foreground">{product.category_name ?? ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* To-delete list */}
        {toDelete.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            <Label>{t('To Delete ({{count}})', { count: toDelete.length })}</Label>
            {toDelete.map((product) => {
              const info = deleteInfoMap.get(product.id);
              const hasWarning = info ? (info.has_stock || info.txn_count > 0) : false;
              return (
                <div
                  key={product.id}
                  className={`flex items-start gap-2 rounded-md border p-2.5 ${hasWarning ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/20' : 'border-muted'}`}
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="text-sm font-medium truncate">{product.name}</p>
                    {info && hasWarning && (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-yellow-700 dark:text-yellow-400">
                        {info.has_stock && <span>⚠ {t('Has active stock')}</span>}
                        {info.txn_count > 0 && <span>⚠ {t('{{n}} transaction(s)', { n: info.txn_count })}</span>}
                      </div>
                    )}
                    {info && !hasWarning && (
                      <p className="text-xs text-muted-foreground">{t('No stock or transactions — safe to delete')}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(product.id)}
                    disabled={deleting}
                    className="shrink-0 rounded p-1 hover:bg-accent"
                    title={t('Remove')}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t('No products selected. Search above to add products.')}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={deleting}>
            {t('Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleting || toDelete.length === 0}
          >
            {deleting
              ? t('Deleting...')
              : t('Delete {{count}} Product(s)', { count: toDelete.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ProductsTab
// ---------------------------------------------------------------------------

export function ProductsTab() {
  const { t } = useTranslation();
  const canManage = usePermission('inventory.products.manage');
  const canDelete = usePermission('inventory.products.delete');

  // ── State ────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), 250);
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState<Product | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [smartImportOpen, setSmartImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Sort
  type SortKey = 'name' | 'created_at';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'created_at' ? 'desc' : 'asc');
    }
    setPage(1);
  };

  // Stale-request counter
  const requestCounterRef = useRef(0);

  // ── Fetch categories ─────────────────────────────────────────────────────
  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.categories.getAll();
      setCategories(Array.isArray(data) ? data : []);
    } catch {
      // Non-critical — category dropdown just stays empty
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  // ── Reset page on filter/search change ─────────────────────────────────
  useEffect(() => { setPage(1); }, [debouncedQuery, categoryId]);

  // ── Fetch products (server-side) ──────────────────────────────────────────
  const fetchProducts = useCallback(async () => {
    const currentRequest = ++requestCounterRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await api.products.getList({
        search: debouncedQuery || undefined,
        category_id: categoryId !== ALL_CATEGORIES ? Number(categoryId) : undefined,
        sort_by: sortKey,
        sort_dir: sortDir,
        page,
        limit: PAGE_SIZE,
      });

      // Discard stale responses
      if (currentRequest !== requestCounterRef.current) return;

      setProducts(Array.isArray(result.data) ? result.data : []);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      // Clamp page if it exceeds totalPages (e.g. after deletion)
      if (page > result.totalPages && result.totalPages > 0) {
        setPage(result.totalPages);
      }
    } catch (err) {
      if (currentRequest !== requestCounterRef.current) return;
      setError(err instanceof Error ? err.message : t('Failed to load products'));
    } finally {
      if (currentRequest === requestCounterRef.current) {
        setLoading(false);
      }
    }
  }, [debouncedQuery, categoryId, sortKey, sortDir, page, t]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleAddProduct() {
    setEditingProduct(null);
    setFormOpen(true);
  }

  function handleEditProduct(product: Product) {
    setEditingProduct(product);
    setFormOpen(true);
  }

  function handleDeleteProduct(product: Product) {
    setDeletingProduct(product);
    setDeleteDialogOpen(true);
  }

  function handleSaved() {
    fetchProducts();
  }

  function handleDeleted() {
    // If this was the last item on the page, go back one page
    if (products.length === 1 && page > 1) {
      setPage(page - 1);
    } else {
      fetchProducts();
    }
  }

  function handleCategoryCreated() {
    fetchCategories();
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-4 pt-2">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t('Products')}</h2>
          {!loading && (
            <Badge variant="secondary" className="text-xs">
              {total}
            </Badge>
          )}
        </div>

        {canManage && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setCategoryDialogOpen(true)}>
              <FolderPlus className="me-1.5 h-4 w-4" />
              {t('Add Category')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setExportOpen(true)}>
              <Download className="me-1.5 h-4 w-4" />
              {t('Export Excel')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSmartImportOpen(true)}>
              <Upload className="me-1.5 h-4 w-4" />
              {t('Smart Import')}
            </Button>
            <Button data-tour="inv-bulk-import" size="sm" variant="outline" onClick={() => setBulkImportOpen(true)}>
              <Upload className="me-1.5 h-4 w-4" />
              {t('Bulk Import')}
            </Button>
            {canDelete && (
              <Button size="sm" variant="destructive" onClick={() => setBulkDeleteOpen(true)}>
                <Trash2 className="me-1.5 h-4 w-4" />
                {t('Bulk Delete')}
              </Button>
            )}
            <Button data-tour="inv-add-product" size="sm" onClick={handleAddProduct}>
              <Plus className="me-1.5 h-4 w-4" />
              {t('Add Product')}
            </Button>
          </div>
        )}
      </div>

      {/* ── Search & Filter ─────────────────────────────────────────────── */}
      <div data-tour="inv-search" className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t('Search by name, generic, or barcode...')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="ps-9"
          />
        </div>

        <Select value={categoryId} onValueChange={(v) => { setCategoryId(v); }}>
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue placeholder={t('All Categories')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>{t('All Categories')}</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={String(cat.id)}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Error state ─────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
          <button onClick={fetchProducts} className="ms-2 underline hover:no-underline">
            {t('Try again')}
          </button>
        </div>
      )}

      {/* ── Product table ───────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : products.length === 0 ? (
          <EmptyState
            message={
              debouncedQuery.length >= 2
                ? t('No products match your search')
                : t('No products found')
            }
          />
        ) : (
          <Table className="sticky-col">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>
                  <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('name')}>
                    {t('Product Name')}
                    <ArrowUpDown className={`h-3.5 w-3.5 ${sortKey === 'name' ? 'text-foreground' : 'text-muted-foreground/40'}`} />
                  </button>
                </TableHead>
                <TableHead className="hidden lg:table-cell">{t('Generic Name')}</TableHead>
                <TableHead>{t('Category')}</TableHead>
                <TableHead>{t('Units')}</TableHead>
                <TableHead>{t('Stock')}</TableHead>
                <TableHead>
                  <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('created_at')}>
                    {t('Created')}
                    <ArrowUpDown className={`h-3.5 w-3.5 ${sortKey === 'created_at' ? 'text-foreground' : 'text-muted-foreground/40'}`} />
                  </button>
                </TableHead>
                {(canManage || canDelete) && <TableHead className="text-end">{t('Actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product, idx) => (
                <TableRow key={product.id}>
                  <TableCell className="text-center text-muted-foreground">{(page - 1) * PAGE_SIZE + idx + 1}</TableCell>
                  <TableCell className="font-medium truncate max-w-[180px]">{product.name}</TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground">
                    {product.generic_name || '\u2014'}
                  </TableCell>
                  <TableCell>{product.category_name || '\u2014'}</TableCell>
                  <TableCell className="text-sm">
                    {product.conversion_factor > 1
                      ? `${product.parent_unit} = ${product.conversion_factor} ${product.child_unit}`
                      : product.parent_unit}
                  </TableCell>
                  <TableCell>
                    <StockBadge
                      totalStockBase={product.total_stock_base ?? 0}
                      minStockLevel={product.min_stock_level}
                      conversionFactor={product.conversion_factor}
                      parentUnit={product.parent_unit}
                      childUnit={product.child_unit}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {product.created_at
                      ? new Date(product.created_at).toLocaleDateString()
                      : '\u2014'}
                  </TableCell>
                  {(canManage || canDelete) && (
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditProduct(product)}
                            title={t('Edit')}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteProduct(product)}
                            title={t('Delete')}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ── Pagination ──────────────────────────────────────────────────── */}
      <DataPagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      <ProductForm
        open={formOpen}
        onOpenChange={setFormOpen}
        product={editingProduct}
        onSaved={handleSaved}
      />

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        product={deletingProduct}
        onConfirm={handleDeleted}
      />

      <AddCategoryDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        onCreated={handleCategoryCreated}
      />

      <BulkImportDialog
        open={bulkImportOpen}
        onOpenChange={setBulkImportOpen}
        onImported={() => fetchProducts()}
      />

      <ProductExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
      />

      <ProductImportDialog
        open={smartImportOpen}
        onOpenChange={setSmartImportOpen}
        onImported={() => fetchProducts()}
      />

      <BulkDeleteProductsDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        onDeleted={fetchProducts}
      />
    </div>
  );
}
