import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores/settings.store';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Printer, Receipt } from 'lucide-react';
import type { Transaction, TransactionItem } from '@/api/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReceiptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: Transaction | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}

function formatPaymentMethod(method: string | null): string {
  if (!method) return '-';
  switch (method) {
    case 'cash': return 'Cash';
    case 'bank_transfer': return 'Bank Transfer';
    case 'mixed': return 'Mixed';
    default: return method;
  }
}

/** Convert quantity_base back to the display unit quantity. */
function displayQty(item: TransactionItem): number {
  const cf = item.conversion_factor ?? item.conversion_factor_snapshot ?? 1;
  if (item.unit_type === 'parent' && cf > 1) {
    return Math.round(item.quantity_base / cf);
  }
  return item.quantity_base;
}

/** The unit label for the item's unit_type. */
function displayUnit(item: TransactionItem, t: (key: string) => string): string {
  return item.unit_type === 'child'
    ? (item.child_unit || t('Child'))
    : (item.parent_unit || t('Parent'));
}

// ---------------------------------------------------------------------------
// Receipt HTML for print
// ---------------------------------------------------------------------------

function buildPrintHtml(
  transaction: Transaction,
  businessName: string,
  t: (key: string) => string,
  isRtl: boolean
): string {
  const items = transaction.items ?? [];
  const startAlign = isRtl ? 'right' : 'left';
  const endAlign = isRtl ? 'left' : 'right';
  const dir = isRtl ? 'rtl' : 'ltr';

  const itemRows = items
    .map(
      (item: TransactionItem) => `
      <tr>
        <td style="text-align:${startAlign};padding:2px 4px;">${item.product_name ?? `#${item.product_id}`}</td>
        <td style="text-align:center;padding:2px 4px;">${displayQty(item)} ${displayUnit(item, t)}</td>
        <td style="text-align:${endAlign};padding:2px 4px;">${item.unit_price.toLocaleString()}</td>
        <td style="text-align:center;padding:2px 4px;">${item.discount_percent > 0 ? `${item.discount_percent}%` : '-'}</td>
        <td style="text-align:${endAlign};padding:2px 4px;">${item.line_total.toLocaleString()}</td>
      </tr>`
    )
    .join('');

  const bankLine =
    transaction.payment_method !== 'cash' && transaction.bank_name
      ? `<p>${t('Bank')}: ${transaction.bank_name}</p>`
      : '';

  const customerLine =
    transaction.customer_name
      ? `<p>${t('Customer')}: ${transaction.customer_name}${transaction.customer_phone ? ` (${transaction.customer_phone})` : ''}</p>`
      : '';

  const notesLine =
    transaction.notes
      ? `<p>${t('Notes')}: ${transaction.notes}</p>`
      : '';

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${isRtl ? 'ar' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>${t('Receipt')} - ${transaction.transaction_number}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${isRtl ? "'Noto Kufi Arabic', 'Segoe UI', 'Arial', sans-serif" : "'Courier New', Courier, monospace"};
      font-size: ${isRtl ? '13px' : '12px'};
      ${isRtl ? 'line-height: 1.7;' : ''}
      width: 80mm;
      padding: 4mm;
      color: #000;
      direction: ${dir};
    }
    h1 { font-size: 16px; text-align: center; margin-bottom: 4px; }
    .center { text-align: center; }
    .divider { border-top: 1px dashed #000; margin: 6px 0; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: ${startAlign}; font-size: 11px; border-bottom: 1px solid #000; padding: 2px 4px; }
    td { font-size: 11px; font-weight: 600; }
    .totals td { padding: 2px 4px; }
    .total-row { font-weight: 800; font-size: 14px; }
    .footer { text-align: center; margin-top: 10px; font-size: 13px; }
    p { margin: 2px 0; }
    @media print {
      body { width: auto; padding: 0; }
    }
  </style>
</head>
<body>
  <h1>${businessName}</h1>
  <div class="divider"></div>
  <p class="center">${formatDateTime(transaction.created_at)}</p>
  <p class="center">${t('Receipt')} #${transaction.transaction_number}</p>
  ${customerLine}
  <div class="divider"></div>
  <table>
    <thead>
      <tr>
        <th style="text-align:${startAlign};">${t('Item')}</th>
        <th style="text-align:center;">${t('Qty')}</th>
        <th style="text-align:${endAlign};">${t('Price')}</th>
        <th style="text-align:center;">${t('Disc')}</th>
        <th style="text-align:${endAlign};">${t('Net')}</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>
  <div class="divider"></div>
  <table class="totals">
    <tr>
      <td>${t('Subtotal')}</td>
      <td style="text-align:${endAlign};">${transaction.subtotal.toLocaleString()} SDG</td>
    </tr>
    ${transaction.discount_amount > 0 ? `
    <tr>
      <td>${t('Discount')}</td>
      <td style="text-align:${endAlign};">-${transaction.discount_amount.toLocaleString()} SDG</td>
    </tr>` : ''}
    <tr class="total-row">
      <td>${t('Total')}</td>
      <td style="text-align:${endAlign};">${transaction.total_amount.toLocaleString()} SDG</td>
    </tr>
  </table>
  <div class="divider"></div>
  <p>${t('Payment')}: ${t(formatPaymentMethod(transaction.payment_method))}</p>
  ${bankLine}
  ${notesLine}
  <div class="divider"></div>
  <p class="footer">${t('Thank you!')}</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// ReceiptModal
// ---------------------------------------------------------------------------

export function ReceiptModal({ open, onOpenChange, transaction }: ReceiptModalProps) {
  const { t } = useTranslation();
  const getSetting = useSettingsStore((s) => s.getSetting);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const businessName = getSetting('business_name', 'PharmaSys');
  const items = transaction?.items ?? [];

  // ---- Print handler ----
  const handlePrint = useCallback(() => {
    if (!transaction) return;

    const isRtl = document.documentElement.dir === 'rtl';
    const html = buildPrintHtml(transaction, businessName, t, isRtl);

    // Create a hidden iframe for printing
    let iframe = iframeRef.current;
    if (iframe) {
      document.body.removeChild(iframe);
    }

    iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);
    iframeRef.current = iframe;

    const iframeDoc = iframe.contentWindow?.document;
    if (iframeDoc) {
      iframeDoc.open();
      iframeDoc.write(html);
      iframeDoc.close();

      // Wait for content to render before printing
      setTimeout(() => {
        // Close the receipt modal after the print dialog is dismissed
        const iframeWin = iframe!.contentWindow;
        if (iframeWin) {
          iframeWin.addEventListener('afterprint', () => {
            onOpenChange(false);
          }, { once: true });
          iframeWin.print();
        }
      }, 250);
    }
  }, [transaction, businessName, t, onOpenChange]);

  if (!transaction) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            {t('Receipt')}
          </DialogTitle>
          <DialogDescription>
            {t('Transaction')} #{transaction.transaction_number}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-4 px-1 font-mono text-sm">
            {/* ---- Header ---- */}
            <div className="text-center">
              <p className="text-base font-bold">{businessName}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(transaction.created_at)}
              </p>
            </div>

            {/* ---- Customer ---- */}
            {(transaction.customer_name || transaction.customer_phone) && (
              <>
                <Separator />
                <div className="space-y-0.5 text-xs">
                  {transaction.customer_name && (
                    <p>
                      <span className="text-muted-foreground">{t('Customer')}:</span>{' '}
                      {transaction.customer_name}
                    </p>
                  )}
                  {transaction.customer_phone && (
                    <p>
                      <span className="text-muted-foreground">{t('Phone')}:</span>{' '}
                      {transaction.customer_phone}
                    </p>
                  )}
                </div>
              </>
            )}

            <Separator />

            {/* ---- Items table ---- */}
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-1 text-start font-medium">{t('Item')}</th>
                  <th className="py-1 text-center font-medium">{t('Qty')}</th>
                  <th className="py-1 text-end font-medium">{t('Price')}</th>
                  <th className="py-1 text-center font-medium">{t('Disc')}</th>
                  <th className="py-1 text-end font-medium">{t('Net')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item: TransactionItem, idx: number) => (
                  <tr key={item.id ?? idx} className="border-b border-dashed last:border-0">
                    <td className="max-w-[120px] truncate py-1 text-start">
                      {item.product_name ?? `#${item.product_id}`}
                    </td>
                    <td className="py-1 text-center tabular-nums">
                      {displayQty(item)}
                      <span className="text-muted-foreground">
                        {' '}{displayUnit(item, t)}
                      </span>
                    </td>
                    <td className="py-1 text-end tabular-nums">
                      {item.unit_price.toLocaleString()}
                    </td>
                    <td className="py-1 text-center tabular-nums">
                      {item.discount_percent > 0 ? `${item.discount_percent}%` : '-'}
                    </td>
                    <td className="py-1 text-end tabular-nums">
                      {item.line_total.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <Separator />

            {/* ---- Totals ---- */}
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('Subtotal')}</span>
                <span className="tabular-nums">{formatCurrency(transaction.subtotal)}</span>
              </div>
              {transaction.discount_amount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Discount')}</span>
                  <span className="tabular-nums text-destructive">
                    -{formatCurrency(transaction.discount_amount)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm font-bold">
                <span>{t('Total')}</span>
                <span className="tabular-nums">{formatCurrency(transaction.total_amount)}</span>
              </div>
            </div>

            <Separator />

            {/* ---- Payment details ---- */}
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('Payment')}</span>
                <span>{t(formatPaymentMethod(transaction.payment_method))}</span>
              </div>
              {transaction.bank_name && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Bank')}</span>
                  <span>{transaction.bank_name}</span>
                </div>
              )}
              {transaction.payment_method === 'cash' && transaction.cash_tendered > transaction.total_amount && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('Change')}</span>
                  <span className="tabular-nums">{formatCurrency(transaction.cash_tendered - transaction.total_amount)}</span>
                </div>
              )}
            </div>

            {/* ---- Notes ---- */}
            {transaction.notes && (
              <>
                <Separator />
                <div className="text-xs">
                  <span className="text-muted-foreground">{t('Notes')}:</span>{' '}
                  {transaction.notes}
                </div>
              </>
            )}

            {/* ---- Footer ---- */}
            <Separator />
            <p className="text-center text-sm font-semibold">{t('Thank you!')}</p>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('Close')}
          </Button>
          <Button type="button" onClick={handlePrint}>
            <Printer className="me-2 h-4 w-4" />
            {t('Print')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
