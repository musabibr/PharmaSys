import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, CheckCircle, Clock, CreditCard } from 'lucide-react';
import { api } from '@/api';
import type { Purchase, PurchasePayment, ExpensePaymentMethod } from '@/api/types';
import { Input } from '@/components/ui/input';
import { formatCurrency, cn } from '@/lib/utils';
import { usePermission } from '@/hooks/usePermission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PurchaseDetailDialogProps {
  purchase: Purchase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaymentMade: () => void;
}

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default',
  partial: 'secondary',
  unpaid: 'destructive',
};

export function PurchaseDetailDialog({ purchase: initialPurchase, open, onOpenChange, onPaymentMade }: PurchaseDetailDialogProps) {
  const { t } = useTranslation();
  const canPay = usePermission('purchases.pay');
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payMethod, setPayMethod] = useState<ExpensePaymentMethod>('cash');
  const [payRef, setPayRef] = useState('');
  const [purchase, setPurchase] = useState<Purchase | null>(initialPurchase);

  // Sync with parent when a new purchase is selected
  useEffect(() => {
    setPurchase(initialPurchase);
  }, [initialPurchase]);

  const refreshPurchase = useCallback(async (id: number) => {
    try {
      const updated = await api.purchases.getById(id);
      setPurchase(updated);
    } catch {
      // Silently fail — data stays as-is
    }
  }, []);

  if (!purchase) return null;

  const handleMarkPaid = async (payment: PurchasePayment) => {
    if (payMethod === 'bank_transfer' && !payRef.trim()) {
      toast.error(t('Reference number is required for bank transfers'));
      return;
    }
    setPayingId(payment.id);
    try {
      await api.purchases.markPaymentPaid(
        payment.id, payMethod,
        payMethod === 'bank_transfer' ? payRef.trim() : undefined
      );
      toast.success(t('Payment marked as paid'));
      setPayRef('');
      await refreshPurchase(purchase.id);
      onPaymentMade();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('Failed to mark payment'));
    } finally {
      setPayingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {purchase.purchase_number}
            <Badge variant={STATUS_BADGE[purchase.payment_status] ?? 'secondary'}>
              {t(purchase.payment_status)}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {/* Header Info */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">{t('Supplier')}:</span>{' '}
            <span className="font-medium">{purchase.supplier_name ?? t('N/A')}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Date')}:</span>{' '}
            <span className="font-medium">{purchase.purchase_date}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Invoice Number')}:</span>{' '}
            <span className="font-medium">{purchase.invoice_reference ?? t('N/A')}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('Created By')}:</span>{' '}
            <span className="font-medium">{purchase.username}</span>
          </div>
        </div>

        {/* Financial Summary */}
        <div className="grid grid-cols-3 gap-4 rounded-md border p-4">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">{t('Total')}</p>
            <p className="text-lg font-bold">{formatCurrency(purchase.total_amount)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">{t('Paid')}</p>
            <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(purchase.total_paid)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">{t('Remaining')}</p>
            <p className={cn(
              'text-lg font-bold',
              purchase.total_amount - purchase.total_paid > 0
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}>
              {formatCurrency(purchase.total_amount - purchase.total_paid)}
            </p>
          </div>
        </div>

        {/* Items Table — only shown if there are items */}
        {purchase.items && purchase.items.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('Items')}</h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Product')}</TableHead>
                    <TableHead className="text-end">{t('Qty')}</TableHead>
                    <TableHead className="text-end">{t('Cost')}</TableHead>
                    <TableHead className="text-end">{t('Sell Price')}</TableHead>
                    <TableHead className="text-end">{t('Total')}</TableHead>
                    <TableHead>{t('Expiry Date')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchase.items.map(item => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.product_name}</TableCell>
                      <TableCell className="text-end">{item.quantity_received}</TableCell>
                      <TableCell className="text-end">{formatCurrency(item.cost_per_parent)}</TableCell>
                      <TableCell className="text-end">{formatCurrency(item.selling_price_parent)}</TableCell>
                      <TableCell className="text-end">{formatCurrency(item.line_total)}</TableCell>
                      <TableCell>{item.expiry_date ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Payments Table */}
        {purchase.payments && purchase.payments.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('Payment Schedule')}</h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Due Date')}</TableHead>
                    <TableHead className="text-end">{t('Amount')}</TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Paid Date')}</TableHead>
                    <TableHead>{t('Reference Number')}</TableHead>
                    {canPay && <TableHead className="text-end">{t('Action')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchase.payments.map(payment => (
                    <TableRow key={payment.id}>
                      <TableCell>{payment.due_date}</TableCell>
                      <TableCell className="text-end">{formatCurrency(payment.amount)}</TableCell>
                      <TableCell>
                        {payment.is_paid ? (
                          <span className="flex items-center gap-1 text-green-600">
                            <CheckCircle className="h-3 w-3" /> {t('Paid')}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-amber-600">
                            <Clock className="h-3 w-3" /> {t('Pending')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{payment.paid_date ?? '-'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{payment.reference_number ?? '-'}</TableCell>
                      {canPay && (
                        <TableCell className="text-end">
                          {!payment.is_paid && (
                            <div className="flex flex-col items-end gap-2">
                              <div className="flex items-center gap-2">
                                <Select
                                  value={payMethod}
                                  onValueChange={v => { setPayMethod(v as ExpensePaymentMethod); if (v !== 'bank_transfer') setPayRef(''); }}
                                >
                                  <SelectTrigger className="h-8 w-32">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="cash">{t('Cash')}</SelectItem>
                                    <SelectItem value="bank_transfer">{t('Bank Transfer')}</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Button
                                  size="sm"
                                  onClick={() => handleMarkPaid(payment)}
                                  disabled={payingId === payment.id}
                                >
                                  {payingId === payment.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <CreditCard className="me-1 h-4 w-4" />
                                  )}
                                  {t('Pay')}
                                </Button>
                              </div>
                              {payMethod === 'bank_transfer' && (
                                <Input
                                  className="h-8 w-48"
                                  value={payRef}
                                  onChange={e => setPayRef(e.target.value)}
                                  placeholder={t('Enter reference number')}
                                />
                              )}
                            </div>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {purchase.notes && (
          <div>
            <span className="text-sm text-muted-foreground">{t('Notes')}:</span>
            <p className="text-sm">{purchase.notes}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
