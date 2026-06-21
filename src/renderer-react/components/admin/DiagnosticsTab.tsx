import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/api';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';

export function DiagnosticsTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchReconciliation = async () => {
    try {
      setLoading(true);
      const res = await api.reports.inventoryReconciliation();
      setData(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReconciliation();
  }, []);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('Inventory Reconciliation')}</h2>
        <Button onClick={fetchReconciliation} disabled={loading}>
          {t('Refresh')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('Compares total purchased quantities against total sales, returns, and adjustments to expected current stock.')}
      </p>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardContent className="flex-1 p-0 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Product')}</TableHead>
                <TableHead className="text-right">{t('Purchased')}</TableHead>
                <TableHead className="text-right">{t('Sold')}</TableHead>
                <TableHead className="text-right">{t('Returned')}</TableHead>
                <TableHead className="text-right">{t('Adjustments')}</TableHead>
                <TableHead className="text-right">{t('Expected')}</TableHead>
                <TableHead className="text-right">{t('Actual')}</TableHead>
                <TableHead className="text-right">{t('Variance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map(row => (
                <TableRow key={row.product_id}>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-right">{row.purchased}</TableCell>
                  <TableCell className="text-right">{row.sold}</TableCell>
                  <TableCell className="text-right">{row.returned}</TableCell>
                  <TableCell className="text-right">{row.adjustments}</TableCell>
                  <TableCell className="text-right font-medium">{row.expected_qty}</TableCell>
                  <TableCell className="text-right font-medium">{row.actual_qty}</TableCell>
                  <TableCell className="text-right font-bold">
                    <span className={row.variance < 0 ? 'text-red-500' : row.variance > 0 ? 'text-green-500' : ''}>
                      {row.variance > 0 ? '+' : ''}{row.variance}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {data.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {t('No reconciliation discrepancies found.')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
