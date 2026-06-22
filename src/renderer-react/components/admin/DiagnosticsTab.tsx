import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/api';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Search, RefreshCw } from 'lucide-react';

interface ReconRow {
  product_id: number;
  product_name: string;
  purchased: number;
  sold: number;
  returned: number;
  adjustments: number;
  expected_qty: number;
  actual_qty: number;
  variance: number;
}

type VarianceFilter = 'all' | 'shortage' | 'overage' | 'balanced';

export function DiagnosticsTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<ReconRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [variance, setVariance] = useState<VarianceFilter>('all');

  const fetchReconciliation = async () => {
    try {
      setLoading(true);
      const res = await api.reports.inventoryReconciliation() as ReconRow[];
      setData(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchReconciliation(); }, []);

  const q = search.trim().toLowerCase();
  const visible = data.filter(row => {
    if (q && !row.product_name?.toLowerCase().includes(q)) return false;
    if (variance === 'shortage' && !(row.variance < 0)) return false;
    if (variance === 'overage' && !(row.variance > 0)) return false;
    if (variance === 'balanced' && row.variance !== 0) return false;
    return true;
  });

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t('Inventory Reconciliation')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('Compares total purchased quantities against total sales, returns, and adjustments to expected current stock.')}
          </p>
        </div>
        <Button onClick={fetchReconciliation} disabled={loading} className="gap-2">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('Refresh')}
        </Button>
      </div>

      {/* Filters — wrap on small screens */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="ps-8"
            placeholder={t('Search product...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={variance} onValueChange={(v) => setVariance(v as VarianceFilter)}>
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder={t('Variance')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All')}</SelectItem>
            <SelectItem value="shortage">{t('Shortage')}</SelectItem>
            <SelectItem value="overage">{t('Overage')}</SelectItem>
            <SelectItem value="balanced">{t('Balanced')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardContent className="flex-1 p-0 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Product')}</TableHead>
                <TableHead className="text-end">{t('Purchased')}</TableHead>
                <TableHead className="text-end">{t('Sold')}</TableHead>
                <TableHead className="text-end">{t('Returned')}</TableHead>
                <TableHead className="text-end">{t('Adjustments')}</TableHead>
                <TableHead className="text-end">{t('Expected')}</TableHead>
                <TableHead className="text-end">{t('Actual')}</TableHead>
                <TableHead className="text-end">{t('Variance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(row => (
                <TableRow key={row.product_id}>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-end">{row.purchased}</TableCell>
                  <TableCell className="text-end">{row.sold}</TableCell>
                  <TableCell className="text-end">{row.returned}</TableCell>
                  <TableCell className="text-end">{row.adjustments}</TableCell>
                  <TableCell className="text-end font-medium">{row.expected_qty}</TableCell>
                  <TableCell className="text-end font-medium">{row.actual_qty}</TableCell>
                  <TableCell className="text-end font-bold">
                    <span className={row.variance < 0 ? 'text-red-500' : row.variance > 0 ? 'text-green-500' : ''}>
                      {row.variance > 0 ? '+' : ''}{row.variance}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {visible.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    {data.length ? t('No products match your filters') : t('No reconciliation discrepancies found.')}
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
