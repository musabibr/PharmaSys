import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  CalendarClock,
  Info,
} from 'lucide-react';
import { api } from '@/api';
import type {
  RecurringExpense,
  ExpenseCategory,
  CreateRecurringExpenseInput,
} from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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
// Helpers
// ---------------------------------------------------------------------------

function computeMonthly(amount: number, type: string): number {
  return type === 'daily' ? amount * 30 : amount;
}

/** Determine per-item generation status */
function getItemStatus(item: RecurringExpense): {
  color: 'green' | 'orange' | 'gray';
  label: string;
} {
  if (!item.is_active) return { color: 'gray', label: 'Inactive' };

  const today = new Date().toISOString().slice(0, 10);
  const lastGen = item.last_generated_date ?? '';

  if (item.amount_type === 'daily') {
    return lastGen === today
      ? { color: 'green', label: 'Up to date' }
      : { color: 'orange', label: 'Pending' };
  }

  // Monthly: check if generated for current period on the configured day
  const day = item.day_of_month ?? 1;
  const now = new Date(today + 'T00:00:00');
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-based
  const lastDayThis = new Date(y, m, 0).getDate();
  const dThis = Math.min(day, lastDayThis);
  const thisMonthDate = `${y}-${String(m).padStart(2, '0')}-${String(dThis).padStart(2, '0')}`;

  if (lastGen >= thisMonthDate) return { color: 'green', label: 'Up to date' };
  if (today < thisMonthDate) return { color: 'orange', label: 'Upcoming' };
  return { color: 'orange', label: 'Pending' };
}

/** Compute the next due date for display */
function computeNextDue(item: RecurringExpense): string {
  if (!item.is_active) return '—';

  const today = new Date().toISOString().slice(0, 10);

  if (item.amount_type === 'daily') {
    const lastGen = item.last_generated_date ?? '';
    if (!lastGen || lastGen < today) return today;
    const next = new Date(today + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    return next.toISOString().slice(0, 10);
  }

  // Monthly
  const day = item.day_of_month ?? 1;
  const now = new Date(today + 'T00:00:00');
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-based

  const lastDayThis = new Date(y, m, 0).getDate();
  const dThis = Math.min(day, lastDayThis);
  const thisMonthDate = `${y}-${String(m).padStart(2, '0')}-${String(dThis).padStart(2, '0')}`;
  const lastGen = item.last_generated_date ?? '';
  if (thisMonthDate >= today && lastGen < thisMonthDate) return thisMonthDate;

  // Next month
  let nm = m + 1;
  let ny = y;
  if (nm > 12) { nm = 1; ny++; }
  const lastDayNext = new Date(ny, nm, 0).getDate();
  const dNext = Math.min(day, lastDayNext);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(dNext).padStart(2, '0')}`;
}

const STATUS_CLASSES: Record<string, string> = {
  green:  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  orange: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  gray:   'bg-muted text-muted-foreground',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RecurringExpensesPanelProps {
  categories: ExpenseCategory[];
  canManage: boolean;
  onExpensesGenerated?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecurringExpensesPanel({
  categories,
  canManage,
}: RecurringExpensesPanelProps) {
  const { t } = useTranslation();

  // ── Data state ──────────────────────────────────────────────────────────
  const [items, setItems] = useState<RecurringExpense[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Dialog state ────────────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringExpense | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────
  const [formName, setFormName] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formAmountType, setFormAmountType] = useState<'monthly' | 'daily'>('monthly');
  const [formDayOfMonth, setFormDayOfMonth] = useState(1);
  const [formAmount, setFormAmount] = useState('');
  const [formPaymentMethod, setFormPaymentMethod] = useState<'cash' | 'bank_transfer'>('cash');
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Computed form preview ─────────────────────────────────────────────
  const amountNum = Math.floor(Number(formAmount)) || 0;
  const previewMonthly = amountNum > 0 ? computeMonthly(amountNum, formAmountType) : 0;

  // ── Category options ──────────────────────────────────────────────────
  const categoryOptions = categories.map(c => ({ value: String(c.id), label: c.name }));

  // ── Fetch ─────────────────────────────────────────────────────────────
  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.recurringExpenses.getAll();
      setItems(Array.isArray(data) ? data : []);
    } catch {
      toast.error(t('Failed to load recurring expenses'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // ── Open dialog ───────────────────────────────────────────────────────
  function openAdd() {
    setEditing(null);
    setFormName('');
    setFormCategoryId('');
    setFormAmountType('monthly');
    setFormDayOfMonth(1);
    setFormAmount('');
    setFormPaymentMethod('cash');
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(item: RecurringExpense) {
    setEditing(item);
    setFormName(item.name);
    setFormCategoryId(String(item.category_id));
    setFormAmountType(item.amount_type);
    setFormDayOfMonth(item.day_of_month ?? 1);
    setFormAmount(String(item.amount));
    setFormPaymentMethod(item.payment_method ?? 'cash');
    setFormError(null);
    setDialogOpen(true);
  }

  // ── Submit ────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const name = formName.trim();
    if (!name) { setFormError(t('Name is required')); return; }
    if (!formCategoryId) { setFormError(t('Please select a category')); return; }
    const amount = Math.floor(Number(formAmount));
    if (!amount || amount <= 0) { setFormError(t('Amount must be a positive whole number')); return; }
    if (formAmountType === 'monthly') {
      if (!Number.isInteger(formDayOfMonth) || formDayOfMonth < 1 || formDayOfMonth > 28) {
        setFormError(t('Day of month must be between 1 and 28'));
        return;
      }
    }

    const payload: CreateRecurringExpenseInput = {
      name,
      category_id: Number(formCategoryId),
      amount_type: formAmountType,
      amount,
      payment_method: formPaymentMethod,
      ...(formAmountType === 'monthly' ? { day_of_month: formDayOfMonth } : {}),
    };

    setFormSubmitting(true);
    try {
      if (editing) {
        await api.recurringExpenses.update(editing.id, payload);
        toast.success(t('Recurring expense updated'));
      } else {
        await api.recurringExpenses.create(payload);
        toast.success(t('Recurring expense created'));
      }
      setDialogOpen(false);
      await fetchItems();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('Failed to save'));
    } finally {
      setFormSubmitting(false);
    }
  }

  // ── Toggle active ─────────────────────────────────────────────────────
  async function handleToggle(item: RecurringExpense) {
    try {
      await api.recurringExpenses.toggleActive(item.id);
      await fetchItems();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to toggle'));
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────
  async function handleDelete(item: RecurringExpense) {
    if (!window.confirm(t('Delete recurring expense "{{name}}"?', { name: item.name }))) return;
    try {
      await api.recurringExpenses.delete(item.id);
      toast.success(t('Recurring expense deleted'));
      await fetchItems();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete'));
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <div className="space-y-4">
        {/* ── Header row ─────────────────────────────────────────────────── */}
        {canManage && (
          <div className="flex justify-end">
            <Button size="sm" className="gap-1.5" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" />
              {t('New Rule')}
            </Button>
          </div>
        )}

        {/* ── Auto-generation info note ─────────────────────────────────── */}
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t('Recurring entries are generated automatically on startup.')}
          </p>
        </div>

        {/* ── Table ────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <CalendarClock className="mb-2 h-10 w-10 opacity-30" />
            <p className="text-sm">{t('No recurring rules defined')}</p>
            {canManage && (
              <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" />
                {t('Add first rule')}
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Name')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('Category')}</TableHead>
                  <TableHead>{t('Frequency')}</TableHead>
                  <TableHead className="text-end">{t('Amount')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('Payment')}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t('Last Generated')}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t('Next Due')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead>{t('Active')}</TableHead>
                  {canManage && <TableHead className="w-20">{t('Actions')}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const status = getItemStatus(item);
                  const nextDue = computeNextDue(item);
                  return (
                    <TableRow key={item.id} className={!item.is_active ? 'opacity-50' : ''}>
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                        {item.category_name ?? `#${item.category_id}`}
                      </TableCell>
                      <TableCell className="text-sm">
                        {item.amount_type === 'daily'
                          ? t('Daily')
                          : `${t('Monthly')} · ${t('Day')} ${item.day_of_month ?? 1}`}
                      </TableCell>
                      <TableCell className="text-end tabular-nums font-medium">
                        {formatCurrency(item.amount)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {item.payment_method === 'bank_transfer' ? t('Bank Transfer') : t('Cash')}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                        {item.last_generated_date ?? t('Never')}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm tabular-nums">
                        {nextDue}
                      </TableCell>
                      <TableCell>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[status.color]}`}>
                          {status.label === 'Up to date' ? t('Up to date') :
                           status.label === 'Pending'    ? t('Pending')    :
                           status.label === 'Upcoming'   ? t('Upcoming')   :
                           t('Inactive')}
                        </span>
                      </TableCell>
                      <TableCell>
                        {canManage ? (
                          <Switch
                            checked={!!item.is_active}
                            onCheckedChange={() => handleToggle(item)}
                          />
                        ) : (
                          <Badge variant={item.is_active ? 'default' : 'secondary'}>
                            {item.is_active ? t('Yes') : t('No')}
                          </Badge>
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title={t('Edit')}
                              onClick={() => openEdit(item)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              title={t('Delete')}
                              onClick={() => handleDelete(item)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ── Add / Edit Dialog ─────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('Edit Recurring Expense') : t('New Recurring Rule')}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? t('Update the recurring expense configuration.')
                : t('Configure a new recurring expense. The system will auto-generate expense entries.')}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-2">
              {/* Name */}
              <div className="space-y-1.5">
                <Label>{t('Name')} <span className="text-destructive">*</span></Label>
                <Input
                  placeholder={t('e.g. Shop Rent, Staff Salary')}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  autoFocus
                />
              </div>

              {/* Category */}
              <div className="space-y-1.5">
                <Label>{t('Category')} <span className="text-destructive">*</span></Label>
                <SearchableSelect
                  value={formCategoryId}
                  onValueChange={setFormCategoryId}
                  options={categoryOptions}
                  placeholder={t('Select category')}
                  searchPlaceholder={t('Search categories...')}
                  emptyMessage={t('No categories found')}
                />
              </div>

              {/* Amount Type + Payment Method */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t('Amount Type')}</Label>
                  <div className="flex gap-3 pt-1">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="amountType"
                        value="monthly"
                        checked={formAmountType === 'monthly'}
                        onChange={() => setFormAmountType('monthly')}
                        className="accent-primary"
                      />
                      <span className="text-sm">{t('Monthly')}</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="amountType"
                        value="daily"
                        checked={formAmountType === 'daily'}
                        onChange={() => setFormAmountType('daily')}
                        className="accent-primary"
                      />
                      <span className="text-sm">{t('Daily')}</span>
                    </label>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>{t('Payment Method')}</Label>
                  <Select
                    value={formPaymentMethod}
                    onValueChange={(v) => setFormPaymentMethod(v as 'cash' | 'bank_transfer')}
                  >
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

              {/* Day of month — only for monthly */}
              {formAmountType === 'monthly' && (
                <div className="space-y-1.5">
                  <Label>{t('Day of month')} <span className="text-destructive">*</span></Label>
                  <Input
                    type="number"
                    min={1}
                    max={28}
                    step={1}
                    value={formDayOfMonth}
                    onChange={(e) => setFormDayOfMonth(Math.floor(Number(e.target.value)))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('1–28. If the month has fewer days, the last day is used.')}
                  </p>
                </div>
              )}

              {/* Amount */}
              <div className="space-y-1.5">
                <Label>
                  {formAmountType === 'monthly' ? t('Monthly Amount') : t('Daily Amount')} (SDG){' '}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  placeholder={formAmountType === 'monthly' ? t('e.g. 15000') : t('e.g. 500')}
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                />
              </div>

              {/* Live preview */}
              {amountNum > 0 && (
                <div className="rounded-md border bg-muted/50 p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t('Preview')}</p>
                  {formAmountType === 'daily' ? (
                    <>
                      <div className="flex justify-between text-sm">
                        <span>{t('Daily deduction')}:</span>
                        <span className="font-medium tabular-nums">{formatCurrency(amountNum)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>{t('Monthly total')}:</span>
                        <span className="font-medium tabular-nums">{formatCurrency(previewMonthly)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between text-sm">
                      <span>{t('Deducted once on day {{day}} of each month', { day: formDayOfMonth })}:</span>
                      <span className="font-medium tabular-nums">{formatCurrency(amountNum)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {formError && (
                <p className="text-sm text-destructive">{formError}</p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                disabled={formSubmitting || !formName.trim() || !formCategoryId || amountNum <= 0}
              >
                {formSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {editing ? t('Update') : t('Add')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
