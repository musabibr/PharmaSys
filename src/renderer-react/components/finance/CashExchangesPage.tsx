import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus,
  Loader2,
  Filter,
  RotateCcw,
  ArrowLeftRight,
  Search,
  Wallet,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import { api } from '@/api';
import type { CashExchange, PaginatedResult, CashExchangeValidationSettings, CashAvailabilityValidation } from '@/api/types';
import { DataPagination } from '@/components/ui/data-pagination';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useShiftStore } from '@/stores/shift.store';
import { usePermission } from '@/hooks/usePermission';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
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

const PAGE_SIZE = 10;

function firstOfMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDate(dateStr: string, locale: string = 'en'): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
}

interface Filters {
  startDate: string;
  endDate: string;
  search: string;
  bankName: string;
  customerName: string;
}

function defaultFilters(): Filters {
  return {
    startDate: firstOfMonth(),
    endDate: todayStr(),
    search: '',
    bankName: '',
    customerName: '',
  };
}

export function CashExchangesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { currentUser } = useAuthStore();
  const { currentShift } = useShiftStore();
  const canManage = usePermission('finance.cash_exchanges.manage');
  const canViewOwn = usePermission('finance.cash_exchanges.view_own');
  const canOverrideAdmin = usePermission('finance.cash_exchanges.manage') && currentUser?.role === 'admin';
  const getBankConfig = useSettingsStore((s) => s.getBankConfig);

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PaginatedResult<CashExchange>>({
    data: [],
    total: 0,
    page: 1,
    limit: PAGE_SIZE,
    totalPages: 1,
  });
  
  const [filters, setFilters] = useState<Filters>(defaultFilters());
  const [page, setPage] = useState(1);
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  
  const [formBankName, setFormBankName] = useState('');
  const [formRefNumber, setFormRefNumber] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formCustomerName, setFormCustomerName] = useState('');
  const [formCustomerPhone, setFormCustomerPhone] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formError, setFormError] = useState('');

  // Cash exchange validation state
  const [validationSettings, setValidationSettings] = useState<CashExchangeValidationSettings | null>(null);
  const [drawerBalance, setDrawerBalance] = useState<number>(0);
  const [cashExchangeWarning, setCashExchangeWarning] = useState<string>('');
  const [showCashExchangeWarning, setShowCashExchangeWarning] = useState(false);
  const [adminOverride, setAdminOverride] = useState(false);

  const activeBanks = getBankConfig().filter((b) => b.enabled);

  // Load validation settings when component mounts
  useEffect(() => {
    loadValidationSettings();
  }, []);

  const loadValidationSettings = async () => {
    try {
      const settings = await api.cashExchanges.getValidationSettings();
      setValidationSettings(settings);
      
      // Load current drawer balance if shift is open
      if (currentShift?.id && settings.use_realtime_calculation) {
        try {
          const validation = await api.cashExchanges.validateCashAvailability({
            amount: 0,
            shiftId: currentShift.id,
            adminOverride: false
          });
          setDrawerBalance(validation.availableCash);
        } catch (err) {
          console.error('Failed to load drawer balance:', err);
        }
      }
    } catch (err) {
      console.error('Failed to load validation settings:', err);
    }
  };

  // Validate cash exchange when amount changes
  useEffect(() => {
    const amountNum = parseFloat(formAmount);
    if (amountNum > 0 && validationSettings?.enabled) {
      validateCashExchange(amountNum);
    } else {
      setCashExchangeWarning('');
      setShowCashExchangeWarning(false);
    }
  }, [formAmount, validationSettings, adminOverride]);

  const validateCashExchange = async (amount: number) => {
    if (!currentShift?.id || !validationSettings?.enabled) return;

    try {
      const validation = await api.cashExchanges.validateCashAvailability({
        amount,
        shiftId: currentShift.id,
        adminOverride: adminOverride
      });

      setDrawerBalance(validation.availableCash);

      if (validation.warning) {
        let warningMessage = validation.warning;
        if (validation.warning === 'insufficient_cash_admin_override') {
          warningMessage = t('Insufficient cash in drawer. Available: {{available}} SDG, Required: {{required}} SDG', {
            available: validation.availableCash,
            required: validation.requiredCash
          });
        } else if (validation.warning === 'insufficient_cash_warning') {
          warningMessage = t('Insufficient cash in drawer. Available: {{available}} SDG, Required: {{required}} SDG', {
            available: validation.availableCash,
            required: validation.requiredCash
          });
        }
        setCashExchangeWarning(warningMessage);
        setShowCashExchangeWarning(true);
      } else {
        setCashExchangeWarning('');
        setShowCashExchangeWarning(false);
      }
    } catch (err: any) {
      // In strict mode, this will throw an error
      if (validationSettings?.mode === 'strict') {
        let errorMessage = err.message || t('Cash exchange validation failed');
        if (err.message === 'insufficient_cash_strict') {
          errorMessage = t('Insufficient cash in drawer. Available: {{available}} SDG, Required: {{required}} SDG', {
            available: drawerBalance,
            required: amount
          });
        }
        setCashExchangeWarning(errorMessage);
        setShowCashExchangeWarning(true);
      }
    }
  };

  const loadData = useCallback(async (p: number, f: Filters) => {
    try {
      setLoading(true);
      const result = await api.cashExchanges.getAll({
        page: p,
        limit: PAGE_SIZE,
        start_date: f.startDate || undefined,
        end_date: f.endDate || undefined,
        search: f.search || undefined,
        bank_name: f.bankName || undefined,
        customer_name: f.customerName || undefined,
        user_id: canViewOwn && !canManage ? currentUser?.id : undefined,
      });
      setData(result);
    } catch (err: any) {
      toast.error(err.message || t('Failed to load cash exchanges'));
    } finally {
      setLoading(false);
    }
  }, [t, canViewOwn, canManage, currentUser?.id]);

  useEffect(() => {
    loadData(page, filters);
  }, [loadData, page, filters]);

  function handleFilterChange(key: keyof Filters, val: string) {
    setFilters((prev) => ({ ...prev, [key]: val }));
    setPage(1);
  }

  function handleResetFilters() {
    setFilters(defaultFilters());
    setPage(1);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    
    if (!formBankName) return setFormError(t('Please select a bank'));
    if (!formRefNumber.trim()) return setFormError(t('Reference number is required'));
    
    const amountNum = parseFloat(formAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return setFormError(t('Please enter a valid positive amount'));
    }

    // Check cash exchange validation in strict mode
    if (validationSettings?.mode === 'strict' && showCashExchangeWarning && !adminOverride) {
      return setFormError(t('Cannot proceed with cash exchange - insufficient drawer balance'));
    }

    try {
      setCreating(true);
      await api.cashExchanges.create({
        bank_name: formBankName,
        reference_number: formRefNumber.trim(),
        bank_amount: amountNum,
        cash_amount: amountNum,
        customer_name: formCustomerName.trim() || null,
        customer_phone: formCustomerPhone.trim() || null,
        notes: formNotes.trim() || null,
        admin_override: adminOverride,
      });
      toast.success(t('Cash exchange recorded successfully'));
      setIsCreateOpen(false);
      setFormBankName('');
      setFormRefNumber('');
      setFormAmount('');
      setFormCustomerName('');
      setFormCustomerPhone('');
      setFormNotes('');
      setCashExchangeWarning('');
      setShowCashExchangeWarning(false);
      setAdminOverride(false);
      loadData(page, filters);
    } catch (err: any) {
      setFormError(err.message || t('Failed to create exchange'));
    } finally {
      setCreating(false);
    }
  }

  if (loading && data.data.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-40" />
        </div>
        <Card>
          <CardContent className="p-0">
            <div className="flex gap-3 border-b p-3">
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

  return (
    <div className="space-y-4 h-full flex flex-col p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('Cash Exchanges')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('View and record standalone bank-to-cash exchanges')}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setIsCreateOpen(true)} className="gap-2 shrink-0">
            <Plus className="h-4 w-4" />
            {t('New Exchange')}
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card className="shrink-0">
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 shadow-sm min-w-[200px]">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              placeholder={t('Search ref, customer...')}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
          </div>
          
          <Separator orientation="vertical" className="h-8 hidden sm:block" />

          <div className="flex items-center gap-2">
            <Label className="text-xs uppercase text-muted-foreground tracking-wider">{t('From')}</Label>
            <Input
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
              className="h-9 w-[140px]"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-xs uppercase text-muted-foreground tracking-wider">{t('To')}</Label>
            <Input
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
              className="h-9 w-[140px]"
            />
          </div>

          <Separator orientation="vertical" className="h-8 hidden sm:block" />

          <div className="flex items-center gap-2">
            <Label className="text-xs uppercase text-muted-foreground tracking-wider">{t('Bank')}</Label>
            <Select value={filters.bankName} onValueChange={(v) => handleFilterChange('bankName', v)}>
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue placeholder={t('All')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('All')}</SelectItem>
                {activeBanks.map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-xs uppercase text-muted-foreground tracking-wider">{t('Customer')}</Label>
            <Input
              placeholder={t('Customer name...')}
              value={filters.customerName}
              onChange={(e) => handleFilterChange('customerName', e.target.value)}
              className="h-9 w-[160px]"
            />
          </div>

          <div className="flex-1" />

          <Button variant="ghost" size="icon" onClick={handleResetFilters} title={t('Reset Filters')}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>

      {/* Data Table */}
      <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 overflow-auto relative">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur shadow-sm">
              <TableRow>
                <TableHead>{t('Date')}</TableHead>
                <TableHead>{t('Bank')}</TableHead>
                <TableHead>{t('Reference')}</TableHead>
                <TableHead className="text-right">{t('Amount')}</TableHead>
                <TableHead>{t('Customer')}</TableHead>
                <TableHead>{t('Linked POS')}</TableHead>
                <TableHead>{t('User')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && data.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin mb-2" />
                    {t('Loading...')}
                  </TableCell>
                </TableRow>
              ) : data.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <ArrowLeftRight className="h-8 w-8 text-muted-foreground/50" />
                      <p>{t('No cash exchanges found')}</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                data.data.map((ex) => (
                  <TableRow key={ex.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(ex.created_at, i18n.language)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {ex.bank_name}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {ex.reference_number}
                    </TableCell>
                    <TableCell className="text-right font-bold text-green-600 dark:text-green-400">
                      {formatCurrency(ex.bank_amount)}
                    </TableCell>
                    <TableCell>
                      {ex.customer_name || ex.transaction_customer_name ? (
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">
                            {ex.customer_name || ex.transaction_customer_name}
                          </span>
                          {(ex.customer_phone || ex.transaction_customer_phone) && (
                            <span className="text-xs text-muted-foreground">
                              {ex.customer_phone || ex.transaction_customer_phone}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic text-xs">{t('None')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {ex.transaction_number ? (
                        <button
                          type="button"
                          onClick={() => navigate('/transactions', { state: { transactionId: ex.linked_transaction_id } })}
                          className="font-mono text-xs px-2 py-1 bg-secondary rounded-md hover:bg-secondary/80 transition-colors flex items-center gap-1"
                          title={t('Open transaction')}
                        >
                          #{ex.transaction_number}
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      ) : (
                        <span className="text-muted-foreground italic text-xs">{t('Standalone')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {ex.username}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="shrink-0 border-t p-3">
          <DataPagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </div>
      </Card>

      {/* Create Modal */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('Record Cash Exchange')}</DialogTitle>
            <DialogDescription>
              {t('Exchange a bank transfer for cash without a sale.')}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate} className="space-y-4 py-2">
            {formError && (
              <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive text-center font-medium">
                {formError}
              </div>
            )}

            <div className="grid gap-2">
              <Label className="text-xs uppercase tracking-wider">{t('Bank')} <span className="text-destructive">*</span></Label>
              <Select value={formBankName} onValueChange={setFormBankName}>
                <SelectTrigger>
                  <SelectValue placeholder={t('Select bank...')} />
                </SelectTrigger>
                <SelectContent>
                  {activeBanks.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      {b.name}
                    </SelectItem>
                  ))}
                  {activeBanks.length === 0 && (
                    <SelectItem value="_empty" disabled>{t('No banks configured')}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label className="text-xs uppercase tracking-wider">{t('Reference Number')} <span className="text-destructive">*</span></Label>
              <Input
                placeholder={t('e.g. TRN-12345')}
                value={formRefNumber}
                onChange={(e) => setFormRefNumber(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-xs uppercase tracking-wider">{t('Amount (Bank -> Cash)')} <span className="text-destructive">*</span></Label>
              <div className="relative">
                <span className="absolute start-3 top-2.5 text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="pl-7"
                  placeholder="0.00"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                />
              </div>
            </div>

            {/* Drawer Balance Display */}
            {validationSettings?.enabled && (
              currentShift?.id ? (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
                  <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400 mb-1">
                    <Wallet className="h-4 w-4 shrink-0" />
                    <span className="font-semibold text-sm">{t('Current Drawer Balance')}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm text-blue-900 dark:text-blue-200">
                    <span>{t('Available Cash:')}</span>
                    <span className="font-bold text-base tabular-nums">
                      {formatCurrency(drawerBalance)}
                    </span>
                  </div>
                  {validationSettings.cash_calculation_mode === 'shift_with_reserve' && validationSettings.cash_reserve_amount > 0 && (
                    <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
                      {t('Includes reserve: {{amount}} SDG', { amount: validationSettings.cash_reserve_amount })}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-950">
                  <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-400 mb-1">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span className="font-semibold text-sm">{t('No Open Shift')}</span>
                  </div>
                  <p className="text-xs text-yellow-900 dark:text-yellow-200">
                    {t('Open a shift before giving cash exchange so the drawer remains reconciled.')}
                  </p>
                </div>
              )
            )}

            {/* Cash Exchange Warning */}
            {showCashExchangeWarning && cashExchangeWarning && (
              <div className="rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950/40">
                <div className="flex items-center gap-2 text-red-800 dark:text-red-300 mb-1">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span className="font-semibold text-sm">
                    {validationSettings?.mode === 'strict' ? t('Cash Exchange Blocked') : t('Cash Exchange Warning')}
                  </span>
                </div>
                <p className="text-sm text-red-900 dark:text-red-200 mt-1">
                  {cashExchangeWarning}
                </p>
                {canOverrideAdmin && validationSettings?.allow_admin_override && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="admin-override"
                      checked={adminOverride}
                      onChange={(e) => setAdminOverride(e.target.checked)}
                      className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <label htmlFor="admin-override" className="text-xs text-red-700 dark:text-red-400">
                      {t('Admin override - proceed anyway')}
                    </label>
                  </div>
                )}
              </div>
            )}

            <Separator className="my-2" />

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-xs text-muted-foreground">{t('Customer Name')} {t('(Optional)')}</Label>
                <Input
                  placeholder={t('Name')}
                  value={formCustomerName}
                  onChange={(e) => setFormCustomerName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-xs text-muted-foreground">{t('Customer Phone')} {t('(Optional)')}</Label>
                <Input
                  placeholder={t('Phone')}
                  value={formCustomerPhone}
                  onChange={(e) => setFormCustomerPhone(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">{t('Notes')} {t('(Optional)')}</Label>
              <Textarea
                placeholder={t('Any additional details...')}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                rows={2}
                className="resize-none"
              />
            </div>

            <DialogFooter className="mt-6">
              <Button type="button" variant="ghost" onClick={() => setIsCreateOpen(false)} disabled={creating}>
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={creating} className="min-w-[100px]">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('Record Exchange')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
