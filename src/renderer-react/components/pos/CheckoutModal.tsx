import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { useCartStore } from '@/stores/cart.store';
import { useSettingsStore } from '@/stores/settings.store';
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
import { ShoppingCart, CreditCard, Banknote, ArrowLeftRight } from 'lucide-react';
import type { PaymentMethod, Transaction } from '@/api/types';

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

  // ---- Form state ----
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [bankName, setBankName] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [bankAmount, setBankAmount] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [extraDiscount, setExtraDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const canDiscount = usePermission('pos.discounts');
  const canBankTransfer = usePermission('pos.bank_transfer');

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
  const cashAmount = isMixed ? totalAmount - parsedBankAmount : 0;
  const parsedCashTendered = parseInt(cashTendered, 10) || 0;
  const changeAmount = paymentMethod === 'cash' ? Math.max(0, parsedCashTendered - totalAmount) : 0;

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
    }
    if (isMixed) {
      if (parsedBankAmount <= 0) return t('Bank amount must be greater than zero');
      if (parsedBankAmount >= totalAmount) return t('Bank amount must be less than total');
    }
    return null;
  }

  // ---- Reset form ----
  function resetForm() {
    setPaymentMethod('cash');
    setBankName('');
    setReferenceNumber('');
    setBankAmount('');
    setCashTendered('');
    setCustomerName('');
    setCustomerPhone('');
    setExtraDiscount('');
    setNotes('');
    setError('');
    setLoading(false);
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
      }

      if (isMixed) {
        transactionData.payment = {
          cash: cashAmount,
          bank: parsedBankAmount,
        };
      }

      const result = await api.transactions.create(transactionData) as Transaction & { error?: string; code?: string };

      // Check for error response (IPC/REST return {error, code} on failure)
      if (result?.error) {
        if (result.code === 'CONFLICT') {
          toast.error(t('Another cashier just sold this item. Please review your cart and try again.'));
          setError(t('Stock conflict — quantities may have changed. Review cart and retry.'));
        } else {
          setError(result.error);
        }
        return;
      }

      toast.success(t('Sale completed successfully'));
      cart.clear();
      resetForm();
      onComplete(result);
    } catch (err: any) {
      setError(err.message || t('Failed to complete sale'));
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
                    onClick={() => setPaymentMethod(pm.value)}
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
                  onChange={(e) => {
                    const val = e.target.value;
                    setBankAmount(val);
                    // Auto-switch to bank_transfer when bank covers full total
                    const parsed = parseInt(val, 10) || 0;
                    if (parsed >= totalAmount && totalAmount > 0) {
                      setPaymentMethod('bank_transfer');
                    }
                  }}
                  placeholder="0"
                  disabled={loading}
                />
              </div>
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
