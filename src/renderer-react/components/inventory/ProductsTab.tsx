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
    </div>
  );
}
