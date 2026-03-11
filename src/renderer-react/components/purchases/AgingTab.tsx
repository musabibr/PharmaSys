import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, CreditCard } from 'lucide-react';
import { api } from '@/api';
import type { AgingPayment, UpcomingPayment } from '@/api/types';
import { useApiCall } from '@/api/hooks';
import { usePermission } from '@/hooks/usePermission';
import { formatCurrency, cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface AgingTabProps {
  onPayAction?: (purchaseId: number) => void;
}

export function AgingTab({ onPayAction }: AgingTabProps) {
  const { t } = useTranslation();
  const canPay = usePermission('purchases.pay');
  const { data: aging, loading: agingLoading } = useApiCall(() => api.purchases.getAgingPayments(), []);
  const { data: overdueSummary } = useApiCall(() => api.purchases.getOverdueSummary(), []);
  const { data: upcoming, loading: upcomingLoading } = useApiCall(() => api.purchases.getUpcomingPayments(), []);
  const { data: upcomingSummary } = useApiCall(() => api.purchases.getUpcomingSummary(), []);

  const loading = agingLoading || upcomingLoading;

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const overdueItems = aging ?? [];
  const upcomingItems = upcoming ?? [];
  const showPayCol = canPay && !!onPayAction;

  return (
    <div className="space-y-4 p-4 overflow-auto h-full">
      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-s-[3px] border-s-destructive">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('Overdue Items')}</CardTitle>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overdueSummary?.count ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="border-s-[3px] border-s-destructive">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('Total Overdue')}</CardTitle>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {formatCurrency(overdueSummary?.total ?? 0)}
            </div>
          </CardContent>
        </Card>
        <Card className="border-s-[3px] border-s-amber-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('Upcoming Payments')}</CardTitle>
            <Clock className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {upcomingSummary?.count ?? 0}
              {(upcomingSummary?.total ?? 0) > 0 && (
                <span className="ms-2 text-sm font-normal text-muted-foreground">
                  ({formatCurrency(upcomingSummary!.total)})
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Overdue Payments Table */}
      {overdueItems.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('Overdue Payments')}
            <Badge variant="destructive" className="ms-1">{overdueItems.length}</Badge>
          </h3>
          <div className="rounded-md border border-destructive/30">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Supplier')}</TableHead>
                  <TableHead>{t('Invoice #')}</TableHead>
                  <TableHead>{t('Due Date')}</TableHead>
                  <TableHead className="text-end">{t('Amount')}</TableHead>
                  <TableHead className="text-end">{t('Days Overdue')}</TableHead>
                  {showPayCol && <TableHead className="w-20"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {overdueItems.map((item: AgingPayment) => (
                  <TableRow key={item.payment_id}>
                    <TableCell className="font-medium">
                      {item.supplier_name ?? t('Unknown')}
                    </TableCell>
                    <TableCell>{item.invoice_reference ?? item.purchase_number}</TableCell>
                    <TableCell>{item.due_date}</TableCell>
                    <TableCell className="text-end tabular-nums font-medium">{formatCurrency(item.amount)}</TableCell>
                    <TableCell className="text-end">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                        item.days_overdue > 30
                          ? 'bg-destructive/10 text-destructive'
                          : item.days_overdue > 15
                            ? 'bg-amber-500/10 text-amber-600'
                            : 'bg-muted text-muted-foreground'
                      )}>
                        {item.days_overdue} {t('days')}
                      </span>
                    </TableCell>
                    {showPayCol && (
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 h-7 text-xs"
                          onClick={() => onPayAction(item.purchase_id)}
                        >
                          <CreditCard className="h-3 w-3" />
                          {t('Pay')}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Upcoming Payments Table */}
      {upcomingItems.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {t('Upcoming Payments')}
            <Badge variant="warning" className="ms-1">{upcomingItems.length}</Badge>
          </h3>
          <div className="rounded-md border border-amber-500/30">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Supplier')}</TableHead>
                  <TableHead>{t('Invoice #')}</TableHead>
                  <TableHead>{t('Due Date')}</TableHead>
                  <TableHead className="text-end">{t('Amount')}</TableHead>
                  <TableHead className="text-end">{t('Days Until Due')}</TableHead>
                  {showPayCol && <TableHead className="w-20"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcomingItems.map((item: UpcomingPayment) => (
                  <TableRow key={item.payment_id}>
                    <TableCell className="font-medium">
                      {item.supplier_name ?? t('Unknown')}
                    </TableCell>
                    <TableCell>{item.invoice_reference ?? item.purchase_number}</TableCell>
                    <TableCell>{item.due_date}</TableCell>
                    <TableCell className="text-end tabular-nums font-medium">{formatCurrency(item.amount)}</TableCell>
                    <TableCell className="text-end">
                      <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {item.days_until_due} {t('days')}
                      </span>
                    </TableCell>
                    {showPayCol && (
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 h-7 text-xs"
                          onClick={() => onPayAction(item.purchase_id)}
                        >
                          <CreditCard className="h-3 w-3" />
                          {t('Pay')}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Empty state — no overdue and no upcoming */}
      {overdueItems.length === 0 && upcomingItems.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p>{t('No overdue or upcoming payments')}</p>
        </div>
      )}
    </div>
  );
}
