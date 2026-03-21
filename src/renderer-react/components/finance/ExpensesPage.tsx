import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DollarSign,
  Hash,
  TrendingDown,
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
} from 'lucide-react';
import { printHtml } from '@/lib/print';
import { api } from '@/api';
import type { Expense, ExpenseCategory } from '@/api/types';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

/** Format an ISO date string in a human-friendly form */
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
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
}

function defaultFilters(): Filters {
  return {
    startDate: firstOfMonth(),
    endDate: todayStr(),
    categoryId: ALL_CATEGORIES,
  };
}

// ---------------------------------------------------------------------------
// StatCard (local re-use)
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
}

function StatCard({ label, value, icon }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div className="text-muted-foreground/60">{icon}</div>
        </div>
        <p className="mt-2 text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ExpensesSkeleton() {
  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="mb-3 h-4 w-24" />
              <Skeleton className="h-8 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-3">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-24" />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-4">
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
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
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.currentUser);
  const isAdmin = currentUser?.role === 'admin';
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
  const [formDescription, setFormDescription] = useState('');
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Category management state (admin panel) ───────────────────────────────
  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    const count = expenses.length;
    // Monthly average: total / number of months in the date range
    const s = new Date(filters.startDate);
    const e = new Date(filters.endDate);
    const months = Math.max(1, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1);
    const monthlyAvg = total > 0 ? Math.round(total / months) : 0;
    return { total, count, monthlyAvg, months };
  }, [expenses, filters.startDate, filters.endDate]);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.expenses.getCategories();
      setCategories(Array.isArray(data) ? data : []);
    } catch {
      // Non-critical — category dropdowns will be empty
    }
  }, []);

  const fetchExpenses = useCallback(async (f: Filters, p: number = 1) => {
    setLoading(true);
    setError(null);
    try {
      const apiFilters: Record<string, string | number> = {
        page: p,
        limit: PAGE_SIZE,
      };
      if (f.startDate) apiFilters.start_date = f.startDate;
      if (f.endDate) apiFilters.end_date = f.endDate;
      if (f.categoryId !== ALL_CATEGORIES) apiFilters.category_id = Number(f.categoryId);

      const result = await api.expenses.getAll(apiFilters);
      setExpenses(Array.isArray(result.data) ? result.data : []);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      if (p > result.totalPages && result.totalPages > 0) {
        setPage(result.totalPages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to load expenses'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      await fetchCategories();
      if (!cancelled) {
        await fetchExpenses(filters);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-fetch on page change ───────────────────────────────────────────────
  useEffect(() => {
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
    setFormCategoryId('');
    setFormNewCategoryName('');
    setCreatingCategory(false);
    setFormAmount('');
    setFormPaymentMethod('cash');
    setFormDescription('');
    setFormError(null);
    setDialogOpen(true);
  }

  // ── Create inline category (from dialog) ──────────────────────────────────
  async function handleCreateInlineCategory() {
    const name = formNewCategoryName.trim();
    if (!name) return;
    setCreatingCategory(true);
    try {
      const created = await api.expenses.createCategory(name);
      // Refresh full categories list
      await fetchCategories();
      // Auto-select the newly created category
      setFormCategoryId(String(created.id));
      setFormNewCategoryName('');
      toast.success(t('Category created'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to create category'));
    } finally {
      setCreatingCategory(false);
    }
  }

  // ── Submit new expense ────────────────────────────────────────────────────
  async function handleSubmitExpense(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    // Validate category
    if (!formCategoryId || formCategoryId === NEW_CATEGORY_SENTINEL) {
      setFormError(t('Please select a category'));
      return;
    }

    // Validate amount
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
        });
        toast.success(t('Expense updated'));
      } else {
        await api.expenses.create({
          category_id: Number(formCategoryId),
          amount,
          description: formDescription.trim() || null,
          payment_method: formPaymentMethod,
          expense_date: new Date().toISOString().split('T')[0],
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
    setFormError(null);
    setDialogOpen(true);
  }

  // ── Delete expense ────────────────────────────────────────────────────────
  async function handleDelete(expense: Expense) {
    const confirmed = window.confirm(
      `${t('Are you sure you want to delete this expense?')}\n\n${expense.category_name ?? t('Expense')} — ${formatCurrency(expense.amount)}`
    );
    if (!confirmed) return;

    try {
      await api.expenses.delete(expense.id);
      toast.success(t('Expense deleted'));
      // If last item on page, go back one page
      if (expenses.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await fetchExpenses(filters, page);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete expense'));
    }
  }

  // ── Add category (admin panel) ────────────────────────────────────────────
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

  // ── Print handler ─────────────────────────────────────────────────────────
  function handlePrint() {
    if (expenses.length === 0) return;

    // Category breakdown
    const catMap = new Map<string, number>();
    for (const e of expenses) {
      const catName = e.category_name ?? `#${e.category_id}`;
      catMap.set(catName, (catMap.get(catName) ?? 0) + e.amount);
    }
    const categoryBreakdownRows = Array.from(catMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(
        ([name, total]) =>
          `<p><strong>${name}:</strong> ${formatCurrency(total)}</p>`
      )
      .join('');

    const rows = expenses
      .map((expense) => {
        let paymentLabel = expense.payment_method ?? '\u2014';
        if (expense.payment_method === 'cash') paymentLabel = t('Cash');
        else if (expense.payment_method === 'bank_transfer') paymentLabel = t('Bank Transfer');

        return `<tr>
          <td>${formatDate(expense.expense_date || expense.created_at)}</td>
          <td>${expense.category_name ?? '#' + expense.category_id}</td>
          <td>${expense.description || '\u2014'}</td>
          <td class="num">${formatCurrency(expense.amount)}</td>
          <td>${paymentLabel}</td>
        </tr>`;
      })
      .join('');

    const html = `
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
      <div class="summary">
        <h3>${t('By Category')}</h3>
        ${categoryBreakdownRows}
      </div>
      <table>
        <thead>
          <tr>
            <th>${t('Date')}</th>
            <th>${t('Category')}</th>
            <th>${t('Description')}</th>
            <th>${t('Amount')}</th>
            <th>${t('Payment Method')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    printHtml(html);
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading && expenses.length === 0) {
    return <ExpensesSkeleton />;
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error && expenses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">{error}</p>
        <button
          onClick={() => fetchExpenses(filters)}
          className="mt-4 text-sm text-primary underline hover:no-underline"
        >
          {t('Try again')}
        </button>
      </div>
    );
  }

  // ── Whether the "New Category" sentinel is selected in the dialog ─────────
  const isNewCategorySelected = formCategoryId === NEW_CATEGORY_SENTINEL;
  const canSubmitExpense =
    formCategoryId &&
    formCategoryId !== NEW_CATEGORY_SENTINEL &&
    Number(formAmount) > 0;

  return (
    <div className="space-y-6">
      {/* ── Page Header + New Expense Button ──────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Expenses')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Track and manage business expenses')}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            <Button onClick={openNewExpenseDialog} className="gap-1.5" data-tour="expense-add">
              <Plus className="h-4 w-4" />
              {t('New Expense')}
            </Button>
          )}
        </div>
      </div>

      {/* ── Stats Cards ──────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('Total Expenses')}
          value={formatCurrency(stats.total)}
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard
          label={t('Expense Count')}
          value={String(total)}
          icon={<Hash className="h-5 w-5" />}
        />
        <StatCard
          label={t('Monthly Average')}
          value={formatCurrency(stats.monthlyAvg)}
          icon={<TrendingDown className="h-5 w-5" />}
        />
      </div>

      {/* ── Filter Bar ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            {/* From date */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('From')}</Label>
              <Input
                type="date"
                className="w-40"
                value={pendingFilters.startDate}
                onChange={(e) =>
                  setPendingFilters((prev) => ({ ...prev, startDate: e.target.value }))
                }
              />
            </div>

            {/* To date */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('To')}</Label>
              <Input
                type="date"
                className="w-40"
                value={pendingFilters.endDate}
                onChange={(e) =>
                  setPendingFilters((prev) => ({ ...prev, endDate: e.target.value }))
                }
              />
            </div>

            {/* Category filter */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Category')}</Label>
              <Select
                value={pendingFilters.categoryId}
                onValueChange={(val) =>
                  setPendingFilters((prev) => ({ ...prev, categoryId: val }))
                }
              >
                <SelectTrigger className="w-44">
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

            {/* Apply / Reset */}
            <Button onClick={handleApplyFilters} size="sm" className="gap-1.5">
              <Filter className="h-3.5 w-3.5" />
              {t('Apply')}
            </Button>
            <Button onClick={handleResetFilters} variant="outline" size="sm" className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" />
              {t('Reset')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Expenses Table ───────────────────────────────────────────────── */}
      <Card data-tour="expense-list">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">{t('Expense Records')}</CardTitle>
            {loading && <Loader2 className="ms-auto h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardHeader>
        <CardContent>
          {expenses.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Receipt className="mb-3 h-10 w-10" />
              <p className="text-sm font-medium">{t('No expenses found')}</p>
              <p className="mt-1 text-xs">
                {t('Try adjusting your filters or add a new expense')}
              </p>
            </div>
          ) : (
            <Table className="sticky-col">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Date')}</TableHead>
                  <TableHead>{t('Category')}</TableHead>
                  <TableHead>{t('Description')}</TableHead>
                  <TableHead>{t('Payment')}</TableHead>
                  <TableHead className="text-end">{t('Amount')}</TableHead>
                  <TableHead>{t('User')}</TableHead>
                  {(canManageExpenses || canDeleteExpenses) && <TableHead className="w-24">{t('Actions')}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {expenses.map((expense) => (
                  <TableRow
                    key={expense.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => { setDetailExpense(expense); setDetailOpen(true); }}
                  >
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(expense.expense_date || expense.created_at)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {expense.category_name ?? `#${expense.category_id}`}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-muted-foreground">
                      {expense.description || '\u2014'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={expense.payment_method === 'cash' ? 'secondary' : 'outline'}
                      >
                        {expense.payment_method === 'cash'
                          ? t('Cash')
                          : expense.payment_method === 'bank_transfer'
                            ? t('Bank Transfer')
                            : expense.payment_method ?? '\u2014'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end tabular-nums font-medium">
                      {formatCurrency(expense.amount)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {expense.username ?? `#${expense.user_id}`}
                    </TableCell>
                    {(canManageExpenses || canDeleteExpenses) && (
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {canManageExpenses && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title={t('Edit')}
                              onClick={(e) => { e.stopPropagation(); handleEdit(expense); }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {canDeleteExpenses && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              title={t('Delete')}
                              onClick={(e) => { e.stopPropagation(); handleDelete(expense); }}
                            >
                              <Trash2 className="h-4 w-4" />
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
          <DataPagination
            page={page}
            totalPages={totalPages}
            total={total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            className="mt-4"
          />
        </CardContent>
      </Card>

      {/* ── Category Management ──────────────────────────────────────────── */}
      {canManageCategories && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Tag className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">{t('Expense Categories')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Existing categories — click to edit, X to delete */}
            <div className="flex flex-wrap gap-2">
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('No categories yet')}</p>
              ) : (
                categories.map((cat) => (
                  <Badge key={cat.id} variant="secondary" className="text-sm gap-1.5 group">
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => {
                        const newName = window.prompt(t('Rename category'), cat.name);
                        if (newName && newName.trim() && newName.trim() !== cat.name) {
                          api.expenses.updateCategory(cat.id, newName.trim())
                            .then(() => { toast.success(t('Category updated')); fetchCategories(); })
                            .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('Failed')));
                        }
                      }}
                    >
                      {cat.name}
                    </button>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      title={t('Delete category')}
                      onClick={() => {
                        if (!window.confirm(t('Delete category "{{name}}"?', { name: cat.name }))) return;
                        api.expenses.deleteCategory(cat.id)
                          .then(() => { toast.success(t('Category deleted')); fetchCategories(); })
                          .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('Failed')));
                      }}
                    >
                      &times;
                    </button>
                  </Badge>
                ))
              )}
            </div>

            <Separator />

            {/* Add new category */}
            <div className="flex items-center gap-2">
              <Input
                className="max-w-xs"
                placeholder={t('New category name')}
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCategory();
                  }
                }}
              />
              <Button
                size="sm"
                onClick={handleAddCategory}
                disabled={!newCategoryName.trim() || addingCategory}
                className="gap-1.5"
              >
                {addingCategory ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderPlus className="h-3.5 w-3.5" />
                )}
                {t('Add')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── New Expense Dialog ────────────────────────────────────────────── */}
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
              {/* ── Category select ─────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label>
                  {t('Category')} <span className="text-destructive">*</span>
                </Label>
                <Select value={formCategoryId} onValueChange={setFormCategoryId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('Select category')} />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat.id} value={String(cat.id)}>
                        {cat.name}
                      </SelectItem>
                    ))}
                    {categories.length > 0 && <SelectSeparator />}
                    <SelectItem value={NEW_CATEGORY_SENTINEL}>
                      <span className="flex items-center gap-1.5">
                        <Plus className="h-3.5 w-3.5" />
                        {t('New Category')}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* ── Inline new category creator ─────────────────────────── */}
              {isNewCategorySelected && (
                <div className="flex items-center gap-2 rounded-md border border-dashed p-3">
                  <Input
                    className="flex-1"
                    placeholder={t('Category name')}
                    value={formNewCategoryName}
                    onChange={(e) => setFormNewCategoryName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreateInlineCategory();
                      }
                    }}
                    autoFocus
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCreateInlineCategory}
                    disabled={!formNewCategoryName.trim() || creatingCategory}
                  >
                    {creatingCategory ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      t('Create')
                    )}
                  </Button>
                </div>
              )}

              {/* ── Amount ──────────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label htmlFor="exp-amount">
                  {t('Amount')} (SDG) <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="exp-amount"
                  type="number"
                  min={1}
                  step={1}
                  placeholder={t('e.g. 500')}
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                />
              </div>

              {/* ── Payment Method ──────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label>{t('Payment Method')}</Label>
                <Select value={formPaymentMethod} onValueChange={setFormPaymentMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">{t('Cash')}</SelectItem>
                    <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* ── Description ─────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label htmlFor="exp-desc">{t('Description')}</Label>
                <Textarea
                  id="exp-desc"
                  rows={2}
                  placeholder={t('Optional description')}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                />
              </div>

              {/* ── Inline error ────────────────────────────────────────── */}
              {formError && (
                <p className="text-sm text-destructive">{formError}</p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmitExpense || formSubmitting}>
                {formSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('Add Expense')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Expense Detail Dialog ──────────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Expense Details')}</DialogTitle>
            <DialogDescription>
              {detailExpense
                ? `#${detailExpense.id} — ${formatDate(detailExpense.expense_date || detailExpense.created_at)}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          {detailExpense && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">{t('Category')}</p>
                  <p className="font-medium">
                    {detailExpense.category_name ?? `#${detailExpense.category_id}`}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('Amount')}</p>
                  <p className="font-medium text-lg">{formatCurrency(detailExpense.amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('Payment')}</p>
                  <Badge
                    variant={detailExpense.payment_method === 'cash' ? 'secondary' : 'outline'}
                  >
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
                    {formatDate(detailExpense.expense_date || detailExpense.created_at)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('User')}</p>
                  <p className="font-medium">
                    {detailExpense.username ?? `#${detailExpense.user_id}`}
                  </p>
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              {t('Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
