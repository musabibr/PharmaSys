import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  CalendarClock,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { api } from '@/api';
import type {
  RecurringExpense,
  ExpenseCategory,
  CreateRecurringExpenseInput,
  GenerationPreviewItem,
} from '@/api/types';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Determine per-item generation status */
function getItemStatus(item: RecurringExpense): {
  color: 'green' | 'orange' | 'gray';
  label: string;
} {
  if (!item.is_active) return { color: 'gray', label: 'Inactive' };

  const today = getToday();
  const lastGen = item.last_generated_date;

  if (!lastGen) return { color: 'orange', label: 'Pending' };

  if (item.amount_type === 'daily') {
    if (lastGen === today) return { color: 'green', label: 'Today' };
    return { color: 'orange', label: 'Pending' };
  }

  // Monthly: check if generated for current month
  const [lastY, lastM] = lastGen.split('-').map(Number);
  const [todayY, todayM] = today.split('-').map(Number);
  if (lastY === todayY && lastM === todayM) {
    return { color: 'green', label: lastGen };
  }
  // Find next month-end
  const eom = new Date(todayY, todayM, 0);
  const eomStr = eom.toISOString().slice(0, 10);
  return { color: 'orange', label: eomStr };
}

const STATUS_DOT: Record<string, string> = {
  green: 'bg-emerald-500',
  orange: 'bg-amber-500',
  gray: 'bg-muted-foreground/50',
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
  onExpensesGenerated,
}: RecurringExpensesPanelProps) {
  const { t } = useTranslation();

  // ── Data state ──────────────────────────────────────────────────────────
  const [items, setItems] = useState<RecurringExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // ── Dialog state ────────────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringExpense | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────
  const [formName, setFormName] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formAmountType, setFormAmountType] = useState<'monthly' | 'daily'>('monthly');
  const [formAmount, setFormAmount] = useState('');
  const [formPaymentMethod, setFormPaymentMethod] = useState<'cash' | 'bank_transfer'>('cash');
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Generate preview state ────────────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItems, setPreviewItems] = useState<GenerationPreviewItem[]>([]);
  const [previewCapped, setPreviewCapped] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());

  // ── Computed preview ────────────────────────────────────────────────────
  const amountNum = Math.floor(Number(formAmount)) || 0;
  const previewMonthly = amountNum > 0 ? computeMonthly(amountNum, formAmountType) : 0;

  // ── Category options for searchable select ─────────────────────────────
  const categoryOptions = categories.map(c => ({ value: String(c.id), label: c.name }));

  // ── Fetch ─────────────────────────────────────────────────────────────
  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.recurringExpenses.getAll();
      setItems(Array.isArray(data) ? data : []);
    } catch {
      // silent — panel is supplementary
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // ── Open dialog ───────────────────────────────────────────────────────
  function openAdd() {
    setEditing(null);
    setFormName('');
    setFormCategoryId('');
    setFormAmountType('monthly');
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
    if (!name) {
      setFormError(t('Name is required'));
      return;
    }
    if (!formCategoryId) {
      setFormError(t('Please select a category'));
      return;
    }
    const amount = Math.floor(Number(formAmount));
    if (!amount || amount <= 0) {
      setFormError(t('Amount must be a positive whole number'));
      return;
    }

    const payload: CreateRecurringExpenseInput = {
      name,
      category_id: Number(formCategoryId),
      amount_type: formAmountType,
      amount,
      payment_method: formPaymentMethod,
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

  // ── Generate preview ──────────────────────────────────────────────────
  async function handleOpenPreview() {
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const result = await api.recurringExpenses.preview();
      setPreviewItems(result.items);
      setPreviewCapped(result.capped);
      // Auto-select items that have pending dates
      const pendingIds = new Set(
        result.items.filter(i => i.dates.length > 0).map(i => i.itemId)
      );
      setSelectedItemIds(pendingIds);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load preview'));
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleGenerateSelected() {
    const ids = Array.from(selectedItemIds);
    if (ids.length === 0) return;
    setGenerating(true);
    try {
      const result = await api.recurringExpenses.generate(ids);
      const count = result?.count ?? 0;
      if (count > 0) {
        toast.success(t('Generated {{count}} expense(s)', { count }));
        onExpensesGenerated?.();
        await fetchItems();
      } else {
        toast.info(t('No expenses to generate'));
      }
      setPreviewOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to generate'));
    } finally {
      setGenerating(false);
    }
  }

  function togglePreviewItem(itemId: number) {
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // Preview computed totals
  const previewPendingItems = previewItems.filter(i => i.dates.length > 0);
  const previewDoneItems = previewItems.filter(i => i.dates.length === 0 && i.alreadyGenerated.length > 0);
  const selectedTotal = previewItems
    .filter(i => selectedItemIds.has(i.itemId))
    .reduce((sum, i) => sum + i.amount * i.dates.length, 0);
  const selectedEntryCount = previewItems
    .filter(i => selectedItemIds.has(i.itemId))
    .reduce((sum, i) => sum + i.dates.length, 0);

  // ── Active count for collapsed view ───────────────────────────────────
  const activeCount = items.filter((i) => i.is_active).length;

  return (
    <>
      <Card>
        <CardHeader
          className="cursor-pointer pb-3"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">{t('Recurring Expenses')}</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {activeCount} {t('active')}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {!expanded && canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={(e) => { e.stopPropagation(); openAdd(); }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('Add')}
                </Button>
              )}
              {expanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </div>
        </CardHeader>

        {expanded && (
          <CardContent className="pt-0">
            {/* Actions row */}
            {canManage && (
              <div className="mb-2 flex items-center gap-2">
                <Button size="sm" className="gap-1.5" onClick={openAdd}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('Add Recurring Expense')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={handleOpenPreview}
                  disabled={generating || previewLoading}
                >
                  {(generating || previewLoading) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {t('Generate Now')}
                </Button>
              </div>
            )}

            {/* Table */}
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-4 text-muted-foreground">
                <CalendarClock className="mb-2 h-8 w-8" />
                <p className="text-sm">{t('No recurring expenses configured')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Name')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('Category')}</TableHead>
                    <TableHead className="text-end">{t('Amount')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('Payment')}</TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Active')}</TableHead>
                    {canManage && <TableHead className="w-20">{t('Actions')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const status = getItemStatus(item);
                    return (
                      <TableRow key={item.id} className={!item.is_active ? 'opacity-50' : ''}>
                        <TableCell className="font-medium">
                          <div>
                            {item.name}
                            <span className="ms-1.5 text-xs text-muted-foreground">
                              {item.amount_type === 'daily' ? t('/day') : t('/mo')}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {item.category_name ?? `#${item.category_id}`}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatCurrency(item.amount)}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-muted-foreground text-xs">
                          {item.payment_method === 'bank_transfer' ? t('Bank Transfer') : t('Cash')}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status.color]}`} />
                            <span className="text-xs text-muted-foreground">
                              {status.color === 'gray' ? t('Inactive') :
                               status.label === 'Today' ? t('Today') :
                               status.label === 'Pending' ? t('Pending') :
                               status.label}
                            </span>
                          </div>
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
            )}
          </CardContent>
        )}
      </Card>

      {/* ── Add / Edit Dialog ─────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('Edit Recurring Expense') : t('Add Recurring Expense')}
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
                <Label>
                  {t('Name')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  placeholder={t('e.g. Shop Rent, Staff Salary')}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  autoFocus
                />
              </div>

              {/* Category */}
              <div className="space-y-1.5">
                <Label>
                  {t('Category')} <span className="text-destructive">*</span>
                </Label>
                <SearchableSelect
                  value={formCategoryId}
                  onValueChange={setFormCategoryId}
                  options={categoryOptions}
                  placeholder={t('Select category')}
                  searchPlaceholder={t('Search categories...')}
                  emptyMessage={t('No categories found')}
                />
              </div>

              {/* Amount Type + Payment Method row */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t('Amount Type')}</Label>
                  <div className="flex gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
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
                    <label className="flex items-center gap-2 cursor-pointer">
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
                  <Select value={formPaymentMethod} onValueChange={(v) => setFormPaymentMethod(v as 'cash' | 'bank_transfer')}>
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
                      <span>{t('Deducted once at end of month')}:</span>
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

      {/* ── Generation Preview Dialog ─────────────────────────────────────── */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              {t('Generate Recurring Expenses')}
            </DialogTitle>
            <DialogDescription>
              {t('Review and select which expenses to generate.')}
            </DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3">
              {/* Safety cap warning */}
              {previewCapped && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    {t('Daily backfill capped at 90 days. Older dates were skipped.')}
                  </p>
                </div>
              )}

              {/* Pending items */}
              {previewPendingItems.length > 0 && (
                <div className="space-y-1">
                  {previewPendingItems.map(item => (
                    <label
                      key={item.itemId}
                      className="flex items-center gap-3 rounded-md border p-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedItemIds.has(item.itemId)}
                        onChange={() => togglePreviewItem(item.itemId)}
                        className="accent-primary h-4 w-4"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-sm truncate">{item.itemName}</span>
                          <span className="text-sm font-medium tabular-nums ms-2">
                            {formatCurrency(item.amount * item.dates.length)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          <span>{item.categoryName}</span>
                          <span>·</span>
                          <span>
                            {item.dates.length} {item.dates.length === 1 ? t('entry') : t('entries')}
                          </span>
                          <span>·</span>
                          <span>{item.paymentMethod === 'bank_transfer' ? t('Bank Transfer') : t('Cash')}</span>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {/* Already generated items */}
              {previewDoneItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground px-1">
                    {t('Already generated')}
                  </p>
                  {previewDoneItems.map(item => (
                    <div
                      key={item.itemId}
                      className="flex items-center gap-3 rounded-md border border-dashed p-2.5 opacity-50"
                    >
                      <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm line-through truncate">{item.itemName}</span>
                          <span className="text-sm tabular-nums ms-2">
                            {formatCurrency(item.amount)}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">{item.categoryName}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Nothing to generate */}
              {previewPendingItems.length === 0 && previewDoneItems.length === 0 && (
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <Check className="mb-2 h-8 w-8 text-emerald-500" />
                  <p className="text-sm">{t('All expenses are up to date')}</p>
                </div>
              )}

              {/* Totals */}
              {previewPendingItems.length > 0 && (
                <div className="flex items-center justify-between border-t pt-3">
                  <span className="text-sm text-muted-foreground">
                    {t('Total')}: {selectedEntryCount} {selectedEntryCount === 1 ? t('entry') : t('entries')}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(selectedTotal)}
                  </span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleGenerateSelected}
              disabled={generating || selectedItemIds.size === 0 || previewLoading}
            >
              {generating && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('Generate Selected')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
