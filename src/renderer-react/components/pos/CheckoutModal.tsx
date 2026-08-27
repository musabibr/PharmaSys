import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { useCartStore } from '@/stores/cart.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useShiftStore } from '@/stores/shift.store';
import { useAuthStore } from '@/stores/auth.store';
import { formatCurrency } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ShoppingCart, CreditCard, Banknote, ArrowLeftRight, AlertTriangle, Wallet } from 'lucide-react';
import type { PaymentMethod, Transaction, CashExchangeValidationSettings, CashAvailabilityValidation } from '@/api/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CheckoutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (transaction: Transaction) => void;
}

// ---------------------------------------------------------------------------
// Payment method option
// ---------------------------------------------------------------------------

const PAYMENT_METHODS: Array<{ value: PaymentMethod; labelKey: string; icon: typeof Banknote }> = [
  { value: 'cash', labelKey: 'Cash', icon: Banknote },
  { value: 'bank_transfer', labelKey: 'Bank Transfer', icon: CreditCard },
  { value: 'mixed', labelKey: 'Mixed', icon: ArrowLeftRight },
];

// ---------------------------------------------------------------------------
// CheckoutModal
// ---------------------------------------------------------------------------

export function CheckoutModal({ open, onOpenChange, onComplete }: CheckoutModalProps) {
  const { t } = useTranslation();
  const cart = useCartStore();
  const getBankConfig = useSettingsStore((s) => s.getBankConfig);
  const { currentShift } = useShiftStore();
  const { currentUser } = useAuthStore();

  // ---- Form state ----
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [bankName, setBankName] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [bankAmount, setBankAmount] = useState('');
  const [bankReceivedAmount, setBankReceivedAmount] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [extraDiscount, setExtraDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const canDiscount = usePermission('pos.discounts');
  const canBankTransfer = usePermission('pos.bank_transfer');
  const isAdmin = currentUser?.role === 'admin';
  const canOverrideAdmin = usePermission('finance.cash_exchanges.manage') && isAdmin;

  // ---- Cash exchange validation state ----
  const [validationSettings, setValidationSettings] = useState<CashExchangeValidationSettings | null>(null);
  const [drawerBalance, setDrawerBalance] = useState<number>(0);
  const [cashExchangeWarning, setCashExchangeWarning] = useState<string>('');
  const [showCashExchangeWarning, setShowCashExchangeWarning] = useState(false);
  const [adminOverride, setAdminOverride] = useState(false);
  const isAdmin = currentUser?.role === 'admin';

  // ---- Load validation settings when modal opens ----
  useEffect(() => {
    if (open) {
      loadValidationSettings();
    }
  }, [open]);

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

  // ---- Derived values ----
  const banks = useMemo(() => {
    const all = getBankConfig();
    return all.filter((b) => b.enabled);
  }, [getBankConfig]);

  const subtotal = cart.getSubtotal();
  const lineDiscountTotal = cart.getDiscountTotal();
  const parsedExtraDiscount = Math.max(0, parseInt(extraDiscount, 10) || 0);
  const totalBeforeExtra = cart.getTotal();
  const totalAmount = Math.max(0, totalBeforeExtra - parsedExtraDiscount);

  const needsBankInfo = paymentMethod === 'bank_transfer' || paymentMethod === 'mixed';
  const isMixed = paymentMethod === 'mixed';

  const parsedBankAmount = parseInt(bankAmount, 10) || 0;
  const parsedBankReceivedAmount = parseInt(bankReceivedAmount, 10) || 0;
  const cashAmount = isMixed ? totalAmount - parsedBankAmount : 0;
  /** Mixed-payment bank leg already covers the whole sale — offer the switch
   *  (H3), never perform it mid-keystroke. */
  const bankCoversTotal = isMixed && totalAmount > 0 && parsedBankAmount >= totalAmount;
  const parsedCashTendered = parseInt(cashTendered, 10) || 0;
  const changeAmount = paymentMethod === 'cash' ? Math.max(0, parsedCashTendered - totalAmount) : 0;

  // ---- Validate cash exchange when bank received amount changes ----
  useEffect(() => {
    const exchangeAmount = parseInt(bankReceivedAmount, 10) || 0;
    if (paymentMethod === 'bank_transfer' && exchangeAmount > totalAmount && validationSettings?.enabled) {
      validateCashExchange();
    } else {
      setCashExchangeWarning('');
      setShowCashExchangeWarning(false);
    }
  }, [bankReceivedAmount, totalAmount, paymentMethod, validationSettings, adminOverride]);

  const validateCashExchange = async () => {
    if (!currentShift?.id || !validationSettings?.enabled) return;

    const exchangeAmount = (parseInt(bankReceivedAmount, 10) || 0) - totalAmount;
    console.log('Validating cash exchange:', { exchangeAmount, drawerBalance, currentShift });
    
    try {
      const validation = await api.cashExchanges.validateCashAvailability({
        amount: exchangeAmount,
        shiftId: currentShift.id,
        adminOverride: adminOverride
      });

      console.log('Validation result:', validation);
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
        console.log('Warning message:', warningMessage);
        setCashExchangeWarning(warningMessage);
        setShowCashExchangeWarning(true);
      } else {
        setCashExchangeWarning('');
        setShowCashExchangeWarning(false);
      }
    } catch (err: any) {
      console.error('Validation error:', err);
      // In strict mode, this will throw an error
      if (validationSettings?.mode === 'strict') {
        let errorMessage = err.message || t('Cash exchange validation failed');
        if (err.message === 'insufficient_cash_strict') {
          errorMessage = t('Insufficient cash in drawer. Available: {{available}} SDG, Required: {{required}} SDG', {
            available: drawerBalance,
            required: exchangeAmount
          });
        }
        setCashExchangeWarning(errorMessage);
        setShowCashExchangeWarning(true);
      }
    }
  };

  // ---- Validation ----
  function validate(): string | null {
    if (cart.items.length === 0) {
      return t('Cart is empty');
    }
    if (totalAmount <= 0) {
      return t('Total amount must be greater than zero');
    }
    if (parsedExtraDiscount > totalBeforeExtra) {
      return t('Additional discount cannot exceed total amount');
    }
    if (needsBankInfo) {
      if (!bankName) return t('Please select a bank');
      if (!referenceNumber.trim()) return t('Reference number is required');
      if (paymentMethod === 'bank_transfer' && parsedBankReceivedAmount > 0 && parsedBankReceivedAmount < totalAmount) {
        return t('Bank amount received must be at least the total amount');
      }
    }
    if (paymentMethod === 'cash' && parsedCashTendered > 0 && parsedCashTendered < totalAmount) {
      return t('Cash tendered must be at least the total amount');
    }
    if (isMixed) {
      if (parsedBankAmount <= 0) return t('Bank amount must be greater than zero');
      if (parsedBankAmount >= totalAmount) return t('Bank amount must be less than total');
    }
    
    // Check cash exchange validation in strict mode
    if (paymentMethod === 'bank_transfer' && parsedBankReceivedAmount > totalAmount && validationSettings?.mode === 'strict' && showCashExchangeWarning && !adminOverride) {
      return t('Insufficient cash in drawer. Available: {{available}} SDG, Required: {{required}} SDG', {
        available: drawerBalance,
        required: (parsedBankReceivedAmount - totalAmount)
      });
    }
    
    return null;
  }

  // ---- Reset form ----
  function resetForm() {
    setPaymentMethod('cash');
    setBankName('');
    setReferenceNumber('');
    setBankAmount('');
    setBankReceivedAmount('');
    setCashTendered('');
    setCustomerName('');
    setCustomerPhone('');
    setExtraDiscount('');
    setNotes('');
    setError('');
    setLoading(false);
    setCashExchangeWarning('');
    setShowCashExchangeWarning(false);
    setAdminOverride(false);
  }

  // ---- Submit ----
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setLoading(true);

    try {
      const transactionData: Record<string, unknown> = {
        transaction_type: 'sale',
        subtotal,
        discount_amount: lineDiscountTotal + parsedExtraDiscount,
        total_amount: totalAmount,
        payment_method: paymentMethod,
        cash_tendered: paymentMethod === 'cash' ? (parsedCashTendered > 0 ? parsedCashTendered : totalAmount) : cashAmount,
        customer_name: customerName.trim() || null,
        customer_phone: customerPhone.trim() || null,
        notes: notes.trim() || null,
        items: cart.items.map((item) => ({
          product_id: item.product_id,
          quantity: item.quantity,
          unit_type: item.unit_type,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent,
        })),
      };

      if (needsBankInfo) {
        transactionData.bank_name = bankName;
        transactionData.reference_number = referenceNumber.trim();
        if (paymentMethod === 'bank_transfer' && parsedBankReceivedAmount > totalAmount) {
          transactionData.bank_received_amount = parsedBankReceivedAmount;
          const exchangeAmount = parsedBankReceivedAmount - totalAmount;
          transactionData.cash_exchange = {
            bank_name: bankName,
            reference_number: referenceNumber.trim(),
            bank_amount: exchangeAmount,
            cash_amount: exchangeAmount,
            admin_override: adminOverride,
          };
        }
      }

      if (isMixed) {
        transactionData.payment = {
          cash: cashAmount,
          bank: parsedBankAmount,
        };
      }

      // H7: both preload bridges throw on failure, so the old inline
      // `if (result?.error)` branch here was unreachable — a third
      // error-unwrapping layer that only looked like it was doing something.
      // Its CONFLICT-specific copy is preserved in the catch below, keyed off
      // the `code` the preload attaches to the Error.
      const result = await api.transactions.create(transactionData) as Transaction;

      toast.success(t('Sale completed successfully'));
      cart.clear();
      resetForm();
      onComplete(result);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') {
        toast.error(t('Another cashier just sold this item. Please review your cart and try again.'));
        setError(t('Stock conflict — quantities may have changed. Review cart and retry.'));
      } else {
        setError(err.message || t('Failed to complete sale'));
      }
    } finally {
      setLoading(false);
    }
  }

  // ---- Handle open change (reset on close) ----
  function handleOpenChange(open: boolean) {
    if (!open) resetForm();
    onOpenChange(open);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            {t('Checkout')}
          </DialogTitle>
          <DialogDescription>
            {t('Complete the sale by selecting a payment method.')}
          </DialogDescription>
        </DialogHeader>

        {/* ---- Cart summary ---- */}
        <div className="rounded-lg border bg-muted/50 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('Items')}</span>
            <span className="font-medium">{cart.getItemCount()}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('Subtotal')}</span>
            <span className="font-medium">{formatCurrency(subtotal)}</span>
          </div>
          {lineDiscountTotal > 0 && (
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('Line Discounts')}</span>
              <span className="font-medium text-destructive">-{formatCurrency(lineDiscountTotal)}</span>
            </div>
          )}
          {parsedExtraDiscount > 0 && (
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('Additional Discount')}</span>
              <span className="font-medium text-destructive">-{formatCurrency(parsedExtraDiscount)}</span>
            </div>
          )}
          <Separator className="my-2" />
          <div className="flex items-center justify-between">
            <span className="font-semibold">{t('Total')}</span>
            <span className="text-lg font-bold">{formatCurrency(totalAmount)}</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* ---- Payment method ---- */}
          <div className="space-y-2">
            <Label>{t('Payment Method')}</Label>
            <div className="flex gap-2">
              {PAYMENT_METHODS.filter((pm) => canBankTransfer || pm.value === 'cash').map((pm) => {
                const Icon = pm.icon;
                const isActive = paymentMethod === pm.value;
                return (
                  <button
                    key={pm.value}
                    type="button"
                    onClick={() => {
                      setPaymentMethod(pm.value);
                      // Leaving "mixed" drops the split — keeping a stale
                      // bank leg around meant coming back re-triggered the
                      // old auto-switch immediately (H3).
                      if (pm.value !== 'mixed') setBankAmount('');
                    }}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-input bg-background text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {t(pm.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ---- Cash tendered (for cash payments) ---- */}
          {paymentMethod === 'cash' && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="space-y-2">
                <Label htmlFor="cash-tendered">{t('Amount Received')} (SDG)</Label>
                <Input
                  id="cash-tendered"
                  type="number"
                  step="1"
                  min={0}
                  value={cashTendered}
                  onChange={(e) => setCashTendered(e.target.value)}
                  placeholder={String(totalAmount)}
                  disabled={loading}
                />
              </div>
              {parsedCashTendered > 0 && parsedCashTendered >= totalAmount && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('Change')}</span>
                  <span className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(changeAmount)}
                  </span>
                </div>
              )}
              {parsedCashTendered > 0 && parsedCashTendered < totalAmount && (
                <p className="text-xs text-destructive">
                  {t('Amount received is less than total')}
                </p>
              )}
            </div>
          )}

          {/* ---- Bank info (for bank_transfer / mixed) ---- */}
          {needsBankInfo && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="space-y-2">
                <Label htmlFor="bank-name">{t('Bank Name')}</Label>
                {banks.length > 0 ? (
                  <Select value={bankName} onValueChange={setBankName}>
                    <SelectTrigger id="bank-name">
                      <SelectValue placeholder={t('Select bank')} />
                    </SelectTrigger>
                    <SelectContent>
                      {banks.map((bank) => (
                        <SelectItem key={bank.id || bank.name} value={bank.name}>
                          {bank.name}
                          {bank.account_number ? ` (${bank.account_number})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="bank-name"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder={t('Enter bank name')}
                    disabled={loading}
                  />
                )}
              </div>

              {/* Show account number prominently when a bank is selected */}
              {bankName && (() => {
                const selected = banks.find((b) => b.name === bankName);
                if (selected?.account_number) {
                  return (
                    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
                      <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
                        {t('Account Number')} — {selected.name}
                      </p>
                      <p className="mt-1 text-lg font-bold tracking-wider text-blue-800 dark:text-blue-200" dir="ltr">
                        {selected.account_number}
                      </p>
                      <p className="mt-1 text-xs text-blue-500 dark:text-blue-400">
                        {t('Tell the customer to send money to this account')}
                      </p>
                    </div>
                  );
                }
                return null;
              })()}

              <div className="space-y-2">
                <Label htmlFor="reference-number">{t('Reference Number')}</Label>
                <Input
                  id="reference-number"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder={t('Enter reference number')}
                  disabled={loading}
                />
              </div>

              {paymentMethod === 'bank_transfer' && (
                <div className="space-y-2 mt-4 pt-4 border-t">
                  <Label htmlFor="bank-received-amount">{t('Amount Received in Bank')} {t('(Optional)')}</Label>
                  <div className="relative">
                    <Input
                      id="bank-received-amount"
                      type="number"
                      step="1"
                      min={totalAmount}
                      value={bankReceivedAmount}
                      onChange={(e) => setBankReceivedAmount(e.target.value)}
                      placeholder={String(totalAmount)}
                      disabled={loading}
                    />
                  </div>
                  
                  {/* Drawer Balance Display */}
                  {validationSettings?.enabled && (
                    currentShift?.id ? (
                      <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
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
                      <div className="mt-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-950">
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

                  {parsedBankReceivedAmount > totalAmount && (
                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
                      <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 mb-1">
                        <ArrowLeftRight className="h-4 w-4 shrink-0" />
                        <span className="font-semibold text-sm">{t('Cash Exchange Required')}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm text-amber-900 dark:text-amber-200">
                        <span>{t('Cash to give customer:')}</span>
                        <span className="font-bold text-base tabular-nums">
                          {formatCurrency(parsedBankReceivedAmount - totalAmount)}
                        </span>
                      </div>
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        {t('This will automatically create a linked Cash Exchange record.')}
                      </p>
                    </div>
                  )}

                  {/* Cash Exchange Warning */}
                  {showCashExchangeWarning && cashExchangeWarning && (
                    <div className="mt-2 rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950/40">
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
                </div>
              )}
            </div>
          )}

          {/* ---- Mixed payment split ---- */}
          {isMixed && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="space-y-2">
                <Label htmlFor="bank-amount">{t('Bank Amount')}</Label>
                <Input
                  id="bank-amount"
                  type="number"
                  step="1"
                  min="1"
                  max={totalAmount}
                  value={bankAmount}
                  onChange={(e) => setBankAmount(e.target.value)}
                  placeholder="0"
                  disabled={loading}
                />
              </div>
              {/*
                H3: this used to switch paymentMethod to bank_transfer on
                every keystroke where the parsed amount covered the total —
                so typing "500" for a 400 total flipped the method at the
                third character and made this whole Mixed section vanish
                mid-edit (and bankAmount was left set, so switching back
                re-triggered it immediately). Offer the switch instead of
                performing it, so the cashier stays in control of the form
                they are still filling in.
              */}
              {bankCoversTotal && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/40">
                  <span className="text-xs text-amber-800 dark:text-amber-300">
                    {t('This covers the full total.')}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => { setPaymentMethod('bank_transfer'); setBankAmount(''); }}
                  >
                    {t('Switch to Bank Transfer')}
                  </Button>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('Cash Amount')}</span>
                <span className="font-semibold tabular-nums">
                  {formatCurrency(Math.max(0, cashAmount))}
                </span>
              </div>
            </div>
          )}

          {/* ---- Customer info ---- */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="customer-name">{t('Customer Name')}</Label>
              <Input
                id="customer-name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder={t('Optional')}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-phone">{t('Customer Phone')}</Label>
              <Input
                id="customer-phone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder={t('Optional')}
                disabled={loading}
              />
            </div>
          </div>

          {/* ---- Additional discount (only if user has pos.discounts permission) ---- */}
          {canDiscount && (
            <div className="space-y-2">
              <Label htmlFor="extra-discount">{t('Additional Discount')} (SDG)</Label>
              <Input
                id="extra-discount"
                type="number"
                step="1"
                min="0"
                value={extraDiscount}
                onChange={(e) => setExtraDiscount(e.target.value)}
                placeholder="0"
                disabled={loading}
              />
            </div>
          )}

          {/* ---- Notes ---- */}
          <div className="space-y-2">
            <Label htmlFor="checkout-notes">{t('Notes')}</Label>
            <textarea
              id="checkout-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('Optional notes')}
              disabled={loading}
              rows={2}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* ---- Error ---- */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {/* ---- Footer ---- */}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={loading || cart.items.length === 0}>
              {loading
                ? t('Processing...')
                : `${t('Complete Sale')} - ${formatCurrency(totalAmount)}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
