import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Loader2,
  Filter,
  RotateCcw,
  AlertTriangle,
  Receipt,
  Tag,
  FolderPlus,
  Printer,
  Pencil,
  CalendarClock,
  Search,
} from 'lucide-react';
import { printHtml } from '@/lib/print';
import { api } from '@/api';
import type { Expense, ExpenseCategory } from '@/api/types';
import { RecurringExpensesPanel } from './RecurringExpensesPanel';
import { DataPagination } from '@/components/ui/data-pagination';
import { useAuthStore } from '@/stores/auth.store';
import { usePermission } from '@/hooks/usePermission';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CATEGORY_SENTINEL = '__new_category__';
const ALL_CATEGORIES = '__all__';
const PAGE_SIZE = 10;

/** Return the first day of the current month as YYYY-MM-DD */
function firstOfMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Return today as YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format an ISO date string in a human-friendly form (locale-aware) */
function formatDate(dateStr: string, locale: string = 'en'): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Filter state shape
// ---------------------------------------------------------------------------

interface Filters {
  startDate: string;
  endDate: string;
  categoryId: string; // "all" or a stringified number
  search: string;
  recurringFilter: 'all' | 'recurring' | 'manual';
}

function defaultFilters(): Filters {
  return {
    startDate: firstOfMonth(),
    endDate: todayStr(),
    categoryId: ALL_CATEGORIES,
    search: '',
    recurringFilter: 'manual',
  };
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ExpensesSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="flex gap-3 border-b p-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-16" />
          </div>
          <div className="p-3 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExpensesPage
// ---------------------------------------------------------------------------

export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const currentUser = useAuthStore((s) => s.currentUser);
  const canManageExpenses = usePermission('finance.expenses.manage');
  const canDeleteExpenses = usePermission('finance.expenses.delete');
  const canManageCategories = usePermission('finance.expense_categories');

  // ── Data state ────────────────────────────────────────────────────────────
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [pendingFilters, setPendingFilters] = useState<Filters>(defaultFilters);

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // ── New Expense form state ────────────────────────────────────────────────
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formNewCategoryName, setFormNewCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [formAmount, setFormAmount] = useState('');
  const [formPaymentMethod, setFormPaymentMethod] = useState('cash');
  const [formExpenseDate, setFormExpenseDate] = useState(todayStr());
  const [formDescription, setFormDescription] = useState('');
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Category management state ─────────────────────────────────────────────
  const [catSearch, setCatSearch] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const s = new Date(filters.startDate);
    const e = new Date(filters.endDate);
    const months = Math.max(1, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1);
    const monthlyAvg = totalAmount > 0 ? Math.round(totalAmount / months) : 0;
    return { total: totalAmount, count: total, monthlyAvg };
  }, [totalAmount, total, filters.startDate, filters.endDate]);

  const filteredCats = useMemo(() => {
    if (!catSearch.trim()) return categories;
    const q = catSearch.toLowerCase();
    return categories.filter(c => c.name.toLowerCase().includes(q));
  }, [categories, catSearch]);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.expenses.getCategories();
      setCategories(Array.isArray(data) ? data : []);
    } catch {
      // Non-critical
    }
  }, []);

  const fetchExpenses = useCallback(async (f: Filters, p: number = 1) => {
    setLoading(true);
    setError(null);
    try {
      const apiFilters: Record<string, string | number> = { page: p, limit: PAGE_SIZE };
      if (f.startDate) apiFilters.start_date = f.startDate;
      if (f.endDate) apiFilters.end_date = f.endDate;
      if (f.categoryId !== ALL_CATEGORIES) apiFilters.category_id = Number(f.categoryId);
      if (f.search.trim()) apiFilters.search = f.search.trim();
      if (f.recurringFilter === 'recurring') apiFilters.is_recurring = 1;
      else if (f.recurringFilter === 'manual') apiFilters.is_recurring = 0;

      const result = await api.expenses.getAll(apiFilters);
      setExpenses(Array.isArray(result.data) ? result.data : []);
      setTotal(result.total);
      setTotalAmount(result.totalAmount ?? 0);
      setTotalPages(result.totalPages);
      if (p > result.totalPages && result.totalPages > 0) setPage(result.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to load expenses'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // ── Initial load ──────────────────────────────────────────────────────────
  const initialLoadDone = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchCategories();
      if (!cancelled) {
        await fetchExpenses(filters);
        initialLoadDone.current = true;
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    fetchExpenses(filters, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // ── Filter handlers ───────────────────────────────────────────────────────
  function handleApplyFilters() {
    setFilters({ ...pendingFilters });
    setPage(1);
    fetchExpenses(pendingFilters, 1);
  }

  function handleResetFilters() {
    const defaults = defaultFilters();
    setPendingFilters(defaults);
    setFilters(defaults);
    setPage(1);
    fetchExpenses(defaults, 1);
  }

  // ── Dialog open/close ─────────────────────────────────────────────────────
  function openNewExpenseDialog() {
    setEditingExpense(null);
    setFormCategoryId('');
    setFormNewCategoryName('');
    setCreatingCategory(false);
    setFormAmount('');
    setFormPaymentMethod('cash');
    setFormExpenseDate(todayStr());
    setFormDescription('');
    setFormError(null);
    setDialogOpen(true);
  }

  // ── Create inline category ────────────────────────────────────────────────
  async function handleCreateInlineCategory() {
    const name = formNewCategoryName.trim();
    if (!name) return;
    setCreatingCategory(true);
    try {
      const created = await api.expenses.createCategory(name);
      await fetchCategories();
      setFormCategoryId(String(created.id));
      setFormNewCategoryName('');
      toast.success(t('Category created'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to create category'));
    } finally {
      setCreatingCategory(false);
    }
  }

  // ── Submit expense ────────────────────────────────────────────────────────
  async function handleSubmitExpense(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!formCategoryId || formCategoryId === NEW_CATEGORY_SENTINEL) {
      setFormError(t('Please select a category'));
      return;
    }
    const amount = Math.floor(Number(formAmount));
    if (!amount || amount <= 0) {
      setFormError(t('Amount must be a positive whole number'));
      return;
    }

    setFormSubmitting(true);
    try {
      if (editingExpense) {
        await api.expenses.update(editingExpense.id, {
          category_id: Number(formCategoryId),
          amount,
          description: formDescription.trim() || null,
          payment_method: formPaymentMethod,
          expense_date: formExpenseDate || todayStr(),
        });
        toast.success(t('Expense updated'));
      } else {
        await api.expenses.create({
          category_id: Number(formCategoryId),
          amount,
          description: formDescription.trim() || null,
          payment_method: formPaymentMethod,
          expense_date: formExpenseDate || todayStr(),
        });
        toast.success(t('Expense added'));
      }
      setDialogOpen(false);
      setEditingExpense(null);
      await fetchExpenses(filters, page);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : (editingExpense ? t('Failed to update expense') : t('Failed to create expense')));
    } finally {
      setFormSubmitting(false);
    }
  }

  // ── Edit expense ─────────────────────────────────────────────────────────
  function handleEdit(expense: Expense) {
    setEditingExpense(expense);
    setFormCategoryId(String(expense.category_id));
    setFormAmount(String(expense.amount));
    setFormDescription(expense.description ?? '');
    setFormPaymentMethod(expense.payment_method ?? 'cash');
    setFormExpenseDate(expense.expense_date ? expense.expense_date.split('T')[0] : todayStr());
    setFormError(null);
    setDialogOpen(true);
  }

  // ── Delete / revoke expense ───────────────────────────────────────────────
  async function handleDelete(expense: Expense) {
    const isRecurring = !!(expense as Record<string, unknown>).is_recurring;
    const message = isRecurring
      ? `${t('Revoke this recurring entry?')}\n\n${expense.category_name ?? t('Expense')} — ${formatCurrency(expense.amount)} (${expense.expense_date})\n\n${t('This entry will be removed and will not regenerate.')}`
      : `${t('Are you sure you want to delete this expense?')}\n\n${expense.category_name ?? t('Expense')} — ${formatCurrency(expense.amount)}`;
    if (!window.confirm(message)) return;

    try {
      await api.expenses.delete(expense.id);
      toast.success(isRecurring ? t('Entry revoked') : t('Expense deleted'));
      if (expenses.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await fetchExpenses(filters, page);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete expense'));
    }
  }

  // ── Add category ──────────────────────────────────────────────────────────
  async function handleAddCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    setAddingCategory(true);
    try {
      await api.expenses.createCategory(name);
      toast.success(t('Category created'));
      setNewCategoryName('');
      await fetchCategories();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to create category'));
    } finally {
      setAddingCategory(false);
    }
  }

  // ── Print ─────────────────────────────────────────────────────────────────
  async function handlePrint() {
    if (expenses.length === 0) return;

    let allExpenses = expenses;
    if (total > PAGE_SIZE) {
      try {
        const apiFilters: Record<string, string | number> = { page: 1, limit: total };
        if (filters.startDate) apiFilters.start_date = filters.startDate;
        if (filters.endDate) apiFilters.end_date = filters.endDate;
        if (filters.categoryId !== ALL_CATEGORIES) apiFilters.category_id = Number(filters.categoryId);
        if (filters.search.trim()) apiFilters.search = filters.search.trim();
        if (filters.recurringFilter === 'recurring') apiFilters.is_recurring = 1;
        else if (filters.recurringFilter === 'manual') apiFilters.is_recurring = 0;
        const result = await api.expenses.getAll(apiFilters);
        allExpenses = Array.isArray(result.data) ? result.data : expenses;
      } catch { /* fallback to current page */ }
    }

    const catMap = new Map<string, number>();
    for (const e of allExpenses) {
      const catName = e.category_name ?? `#${e.category_id}`;
      catMap.set(catName, (catMap.get(catName) ?? 0) + e.amount);
    }
    const categoryBreakdownRows = Array.from(catMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, amt]) => `<p><strong>${name}:</strong> ${formatCurrency(amt)}</p>`)
      .join('');

    const rows = allExpenses.map((expense) => {
      let paymentLabel = expense.payment_method ?? '\u2014';
      if (expense.payment_method === 'cash') paymentLabel = t('Cash');
      else if (expense.payment_method === 'bank_transfer') paymentLabel = t('Bank Transfer');
      return `<tr>
        <td>${formatDate(expense.expense_date || expense.created_at, i18n.language)}</td>
        <td>${expense.category_name ?? '#' + expense.category_id}</td>
        <td>${expense.description || '\u2014'}</td>
        <td class="num">${formatCurrency(expense.amount)}</td>
        <td>${paymentLabel}</td>
      </tr>`;
    }).join('');

    printHtml(`
      <div class="header">
        <div>
          <h2>${t('Expenses')}</h2>
          <p>${filters.startDate} &mdash; ${filters.endDate}</p>
        </div>
      </div>
      <div class="summary">
        <p><strong>${t('Total Expenses')}:</strong> ${formatCurrency(stats.total)}</p>
        <p><strong>${t('Expense Count')}:</strong> ${stats.count}</p>
        <p><strong>${t('Monthly Average')}:</strong> ${formatCurrency(stats.monthlyAvg)}</p>
      </div>
      <div class="summary"><h3>${t('By Category')}</h3>${categoryBreakdownRows}</div>
      <table>
        <thead><tr>
          <th>${t('Date')}</th><th>${t('Category')}</th>
          <th>${t('Description')}</th><th>${t('Amount')}</th><th>${t('Payment Method')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const isNewCategorySelected = formCategoryId === NEW_CATEGORY_SENTINEL;
  const canSubmitExpense =
    formCategoryId && formCategoryId !== NEW_CATEGORY_SENTINEL && Number(formAmount) > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t('Expenses')}</h1>
      </div>

      <Tabs defaultValue="expenses">
        <TabsList>
          <TabsTrigger value="expenses" className="gap-1.5">
            <Receipt className="h-4 w-4" />
            {t('Expenses')}
          </TabsTrigger>
          <TabsTrigger value="recurring" className="gap-1.5">
            <CalendarClock className="h-4 w-4" />
            {t('Recurring')}
          </TabsTrigger>
          {canManageCategories && (
            <TabsTrigger value="categories" className="gap-1.5">
              <Tag className="h-4 w-4" />
              {t('Categories')}
            </TabsTrigger>
          )}
        </TabsList>

        {/* ── Expenses Tab ───────────────────────────────────────────────── */}
        <TabsContent value="expenses" className="mt-4 space-y-4">
          {/* Stats */}
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t('Total Expenses')}</span>
              <span className="font-semibold tabular-nums">{formatCurrency(stats.total)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t('Expense Count')}</span>
              <span className="font-semibold tabular-nums">{total}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t('Monthly Average')}</span>
              <span className="font-semibold tabular-nums">{formatCurrency(stats.monthlyAvg)}</span>
            </div>
          </div>

          <Card data-tour="expense-list">
            <CardContent className="p-0">
              {/* Toolbar */}
              <div className="flex flex-wrap items-end gap-2 border-b p-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('From')}</Label>
                  <Input
                    type="date"
                    className="h-8 w-36"
                    value={pendingFilters.startDate}
                    onChange={(e) => setPendingFilters((prev) => ({ ...prev, startDate: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('To')}</Label>
                  <Input
                    type="date"
                    className="h-8 w-36"
                    value={pendingFilters.endDate}
                    onChange={(e) => setPendingFilters((prev) => ({ ...prev, endDate: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('Category')}</Label>
                  <SearchableSelect
                    value={pendingFilters.categoryId}
                    onValueChange={(val) => setPendingFilters((prev) => ({ ...prev, categoryId: val }))}
                    options={categories.map(c => ({ value: String(c.id), label: c.name }))}
                    placeholder={t('All Categories')}
                    searchPlaceholder={t('Search categories...')}
                    emptyMessage={t('No categories found')}
                    allOption={t('All Categories')}
                    allValue={ALL_CATEGORIES}
                    triggerClassName="h-8 w-40"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('Type')}</Label>
                  <Select
                    value={pendingFilters.recurringFilter}
                    onValueChange={(val) => setPendingFilters((prev) => ({ ...prev, recurringFilter: val as Filters['recurringFilter'] }))}
                  >
                    <SelectTrigger className="h-8 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('All')}</SelectItem>
                      <SelectItem value="manual">{t('Manual')}</SelectItem>
                      <SelectItem value="recurring">{t('Recurring')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('Search')}</Label>
                  <div className="relative">
                    <Search className="absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 w-40 ps-7"
                      placeholder={t('Description or amount...')}
                      value={pendingFilters.search}
                      onChange={(e) => setPendingFilters((prev) => ({ ...prev, search: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleApplyFilters(); }}
                    />
                  </div>
                </div>
                <Button onClick={handleApplyFilters} size="sm" className="h-8 gap-1.5">
                  <Filter className="h-3.5 w-3.5" />
                  {t('Apply')}
                </Button>
                <Button onClick={handleResetFilters} variant="ghost" size="sm" className="h-8 gap-1.5">
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('Reset')}
                </Button>
                <div className="ms-auto flex items-center gap-2">
                  {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePrint}
                    disabled={expenses.length === 0}
                    className="gap-1.5"
                  >
                    <Printer className="h-4 w-4" />
                    {t('Print')}
                  </Button>
                  {canManageExpenses && (
                    <Button size="sm" onClick={openNewExpenseDialog} className="gap-1.5" data-tour="expense-add">
                      <Plus className="h-4 w-4" />
                      {t('New Expense')}
                    </Button>
                  )}
                </div>
              </div>

              {/* Error */}
              {error && expenses.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <AlertTriangle className="mb-2 h-8 w-8 text-destructive" />
                  <p className="text-sm font-medium">{error}</p>
                  <button
                    onClick={() => fetchExpenses(filters)}
                    className="mt-3 text-xs text-primary underline hover:no-underline"
                  >
                    {t('Try again')}
                  </button>
                </div>
              )}

              {/* Skeleton */}
              {loading && expenses.length === 0 && (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              )}

              {/* Empty */}
              {!loading && !error && expenses.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Receipt className="mb-2 h-8 w-8" />
                  <p className="text-sm font-medium">{t('No expenses found')}</p>
                  <p className="mt-1 text-xs">{t('Try adjusting your filters or add a new expense')}</p>
                </div>
              )}

              {/* Table */}
              {expenses.length > 0 && (
                <Table className="sticky-col">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Date')}</TableHead>
                      <TableHead>{t('Category')}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t('Description')}</TableHead>
                      <TableHead>{t('Payment')}</TableHead>
                      <TableHead className="text-end">{t('Amount')}</TableHead>
                      <TableHead className="hidden md:table-cell">{t('User')}</TableHead>
                      {(canManageExpenses || canDeleteExpenses) && <TableHead className="w-20">{t('Actions')}</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expenses.map((expense) => (
                      <TableRow
                        key={expense.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => { setDetailExpense(expense); setDetailOpen(true); }}
                      >
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatDate(expense.expense_date || expense.created_at, i18n.language)}
                        </TableCell>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-1.5">
                            {expense.category_name ?? `#${expense.category_id}`}
                            {!!expense.is_recurring && (
                              <Badge variant="outline" className="text-[10px] gap-0.5 px-1 py-0">
                                <CalendarClock className="h-3 w-3" />
                                {t('Recurring')}
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell max-w-[200px] truncate text-muted-foreground">
                          {expense.description || '\u2014'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={expense.payment_method === 'cash' ? 'secondary' : 'outline'}>
                            {expense.payment_method === 'cash'
                              ? t('Cash')
                              : expense.payment_method === 'bank_transfer'
                                ? t('Bank Transfer')
                                : expense.payment_method ?? '\u2014'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-end tabular-nums font-semibold">
                          {formatCurrency(expense.amount)}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-muted-foreground">
                          {expense.username ?? `#${expense.user_id}`}
                        </TableCell>
                        {(canManageExpenses || canDeleteExpenses) && (
                          <TableCell>
                            <div className="flex items-center gap-0.5">
                              {canManageExpenses && (
                                <Button
                                  variant="ghost" size="icon" className="h-7 w-7"
                                  title={t('Edit')}
                                  onClick={(e) => { e.stopPropagation(); handleEdit(expense); }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {canDeleteExpenses && (
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  title={expense.is_recurring ? t('Revoke') : t('Delete')}
                                  onClick={(e) => { e.stopPropagation(); handleDelete(expense); }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
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

              {/* Pagination */}
              {expenses.length > 0 && (
                <div className="border-t p-3">
                  <DataPagination
                    page={page}
                    totalPages={totalPages}
                    total={total}
                    pageSize={PAGE_SIZE}
                    onPageChange={setPage}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Recurring Tab ──────────────────────────────────────────────── */}
        <TabsContent value="recurring" className="mt-4">
          <RecurringExpensesPanel
            categories={categories}
            canManage={canManageExpenses}
            onExpensesGenerated={() => fetchExpenses(filters, page)}
          />
        </TabsContent>

        {/* ── Categories Tab ─────────────────────────────────────────────── */}
        {canManageCategories && (
          <TabsContent value="categories" className="mt-4">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{t('Expense Categories')}</span>
                  <Badge variant="secondary" className="text-xs">{categories.length}</Badge>
                </div>

                {/* Add + search row */}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 max-w-xs">
                    <Search className="absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 ps-7"
                      placeholder={t('Search categories...')}
                      value={catSearch}
                      onChange={(e) => setCatSearch(e.target.value)}
                    />
                  </div>
                  <Input
                    className="h-8 w-44"
                    placeholder={t('New category name')}
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCategory(); } }}
                  />
                  <Button
                    size="sm"
                    className="h-8 gap-1"
                    onClick={handleAddCategory}
                    disabled={!newCategoryName.trim() || addingCategory}
                  >
                    {addingCategory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
                    {t('Add')}
                  </Button>
                </div>

                {/* Category list */}
                {categories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('No categories yet')}</p>
                ) : (
                  <div className="rounded-md border divide-y">
                    {filteredCats.length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground text-center">{t('No categories found')}</p>
                    ) : filteredCats.map((cat) => (
                      <div
                        key={cat.id}
                        className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 group text-sm"
                      >
                        <span>{cat.name}</span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7"
                            title={t('Rename')}
                            onClick={() => {
                              const newName = window.prompt(t('Rename category'), cat.name);
                              if (newName && newName.trim() && newName.trim() !== cat.name) {
                                api.expenses.updateCategory(cat.id, newName.trim())
                                  .then(() => { toast.success(t('Category updated')); fetchCategories(); })
                                  .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('Failed')));
                              }
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title={t('Delete category')}
                            onClick={() => {
                              if (!window.confirm(t('Delete category "{{name}}"?', { name: cat.name }))) return;
                              api.expenses.deleteCategory(cat.id)
                                .then(() => { toast.success(t('Category deleted')); fetchCategories(); })
                                .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('Failed')));
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* ── New / Edit Expense Dialog ───────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={(v) => { setDialogOpen(v); if (!v) setEditingExpense(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingExpense ? t('Edit Expense') : t('New Expense')}</DialogTitle>
            <DialogDescription>
              {editingExpense ? t('Update the expense details.') : t('Record a new business expense.')}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmitExpense}>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>{t('Category')} <span className="text-destructive">*</span></Label>
                <SearchableSelect
                  value={formCategoryId}
                  onValueChange={setFormCategoryId}
                  options={[
                    ...categories.map(c => ({ value: String(c.id), label: c.name })),
                    { value: NEW_CATEGORY_SENTINEL, label: `+ ${t('New Category')}` },
                  ]}
                  placeholder={t('Select category')}
                  searchPlaceholder={t('Search categories...')}
                  emptyMessage={t('No categories found')}
                />
              </div>

              {isNewCategorySelected && (
                <div className="flex items-center gap-2 rounded-md border border-dashed p-3">
                  <Input
                    className="flex-1"
                    placeholder={t('Category name')}
                    value={formNewCategoryName}
                    onChange={(e) => setFormNewCategoryName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateInlineCategory(); } }}
                    autoFocus
                  />
                  <Button
                    type="button" size="sm"
                    onClick={handleCreateInlineCategory}
                    disabled={!formNewCategoryName.trim() || creatingCategory}
                  >
                    {creatingCategory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('Create')}
                  </Button>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="exp-amount">{t('Amount')} (SDG) <span className="text-destructive">*</span></Label>
                <Input
                  id="exp-amount" type="number" min={1} step={1}
                  placeholder={t('e.g. 500')}
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="exp-date">{t('Date')} <span className="text-destructive">*</span></Label>
                <Input
                  id="exp-date" type="date"
                  value={formExpenseDate}
                  onChange={(e) => setFormExpenseDate(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label>{t('Payment Method')}</Label>
                <Select value={formPaymentMethod} onValueChange={setFormPaymentMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">{t('Cash')}</SelectItem>
                    <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="exp-desc">{t('Description')}</Label>
                <Textarea
                  id="exp-desc" rows={2}
                  placeholder={t('Optional description')}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                />
              </div>

              {formError && <p className="text-sm text-destructive">{formError}</p>}
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmitExpense || formSubmitting}>
                {formSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {editingExpense ? t('Update') : t('Add Expense')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Expense Detail Dialog ───────────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Expense Details')}</DialogTitle>
            <DialogDescription>
              {detailExpense
                ? `#${detailExpense.id} — ${formatDate(detailExpense.expense_date || detailExpense.created_at, i18n.language)}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          {detailExpense && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">{t('Category')}</p>
                  <p className="font-medium">{detailExpense.category_name ?? `#${detailExpense.category_id}`}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('Amount')}</p>
                  <p className="font-medium text-lg">{formatCurrency(detailExpense.amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('Payment')}</p>
                  <Badge variant={detailExpense.payment_method === 'cash' ? 'secondary' : 'outline'}>
                    {detailExpense.payment_method === 'cash'
                      ? t('Cash')
                      : detailExpense.payment_method === 'bank_transfer'
                        ? t('Bank Transfer')
                        : detailExpense.payment_method ?? '\u2014'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('Date')}</p>
                  <p className="font-medium">
                    {formatDate(detailExpense.expense_date || detailExpense.created_at, i18n.language)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('User')}</p>
                  <p className="font-medium">{detailExpense.username ?? `#${detailExpense.user_id}`}</p>
                </div>
                {detailExpense.shift_id && (
                  <div>
                    <p className="text-xs text-muted-foreground">{t('Shift')}</p>
                    <p className="font-medium">#{detailExpense.shift_id}</p>
                  </div>
                )}
              </div>

              {detailExpense.description && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t('Description')}</p>
                    <p className="text-sm whitespace-pre-wrap">{detailExpense.description}</p>
                  </div>
                </>
              )}
            </div>
          )}

          <DialogFooter className="flex-row justify-between sm:justify-between">
            <div className="flex gap-1">
              {canManageExpenses && detailExpense && (
                <Button
                  variant="outline" size="sm" className="gap-1"
                  onClick={() => { setDetailOpen(false); handleEdit(detailExpense); }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('Edit')}
                </Button>
              )}
              {canDeleteExpenses && detailExpense && (
                <Button
                  variant="outline" size="sm"
                  className="gap-1 text-destructive hover:text-destructive"
                  onClick={() => { setDetailOpen(false); handleDelete(detailExpense); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {detailExpense.is_recurring ? t('Revoke') : t('Delete')}
                </Button>
              )}
            </div>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              {t('Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
