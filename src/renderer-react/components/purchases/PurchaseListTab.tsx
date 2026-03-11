import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, FileText, ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { api } from '@/api';
import type { Purchase, PurchasePaymentStatus, Supplier } from '@/api/types';
import { formatCurrency, cn } from '@/lib/utils';
import { printHtml } from '@/lib/print';
import { useDebounce } from '@/hooks/useDebounce';
import { useApiCall } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 10;

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default',
  partial: 'secondary',
  unpaid: 'destructive',
};

interface PurchaseListTabProps {
  onSelect: (purchase: Purchase) => void;
  /** Pre-select a supplier filter (used by supplier view) */
  initialSupplierId?: number | null;
}

function createDefaultFilters(supplierId?: number | null) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    status: 'all' as string,
    search: '',
    supplierId: supplierId ?? ('all' as string | number),
  };
}

export function PurchaseListTab({ onSelect, initialSupplierId }: PurchaseListTabProps) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState(() => createDefaultFilters(initialSupplierId));
  const { data: suppliers } = useApiCall(() => api.suppliers.getAll(), []);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const debouncedSearch = useDebounce(filters.search, 300);

  const updateFilter = useCallback(<K extends keyof ReturnType<typeof createDefaultFilters>>(
    key: K,
    value: ReturnType<typeof createDefaultFilters>[K]
  ) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const apiFilters: Record<string, unknown> = {
        start_date: filters.startDate,
        end_date: filters.endDate,
        page,
        limit: PAGE_SIZE,
      };
      if (filters.status !== 'all') apiFilters.payment_status = filters.status;
      if (debouncedSearch) apiFilters.search = debouncedSearch;
      if (filters.supplierId !== 'all') apiFilters.supplier_id = filters.supplierId;

      const result = await api.purchases.getAll(apiFilters);
      setPurchases(Array.isArray(result.data) ? result.data : []);
      setTotalPages(result.totalPages ?? 1);
    } catch {
      setPurchases([]);
    } finally {
      setLoading(false);
    }
  }, [filters.startDate, filters.endDate, filters.status, filters.supplierId, debouncedSearch, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handlePrint = () => {
    if (purchases.length === 0) return;

    const totalAmount = purchases.reduce((s, p) => s + p.total_amount, 0);
    const totalPaid = purchases.reduce((s, p) => s + p.total_paid, 0);

    const rows = purchases
      .map(
        (p) => `<tr>
          <td>${p.purchase_number}</td>
          <td style="white-space:nowrap">${p.purchase_date}</td>
          <td>${p.supplier_name ?? '-'}</td>
          <td>${p.invoice_reference ?? '-'}</td>
          <td class="num">${formatCurrency(p.total_amount)}</td>
          <td class="num">${formatCurrency(p.total_paid)}</td>
          <td class="num">${p.total_amount - p.total_paid > 0 ? formatCurrency(p.total_amount - p.total_paid) : '-'}</td>
          <td>${t(p.payment_status)}</td>
        </tr>`,
      )
      .join('');

    const html = `
      <div class="header">
        <div>
          <h2>${t('Purchases')}</h2>
          <p>${filters.startDate} — ${filters.endDate}</p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>${t('Purchase #')}</th>
            <th>${t('Date')}</th>
            <th>${t('Supplier')}</th>
            <th>${t('Invoice Number')}</th>
            <th>${t('Total')}</th>
            <th>${t('Paid')}</th>
            <th>${t('Remaining')}</th>
            <th>${t('Status')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <th colspan="4" style="text-align:start">${t('Totals')}</th>
            <th class="num">${formatCurrency(totalAmount)}</th>
            <th class="num">${formatCurrency(totalPaid)}</th>
            <th class="num">${formatCurrency(totalAmount - totalPaid)}</th>
            <th></th>
          </tr>
        </tfoot>
      </table>
    `;

    printHtml(html);
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('From')}</span>
            <Input
              type="date"
              value={filters.startDate}
              onChange={e => updateFilter('startDate', e.target.value)}
              className="h-9 w-36"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('To')}</span>
            <Input
              type="date"
              value={filters.endDate}
              onChange={e => updateFilter('endDate', e.target.value)}
              className="h-9 w-36"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('Supplier')}</span>
            <Select
              value={String(filters.supplierId)}
              onValueChange={v => updateFilter('supplierId', v === 'all' ? 'all' : parseInt(v, 10))}
            >
              <SelectTrigger className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All Suppliers')}</SelectItem>
                {suppliers?.map(s => (
                  <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('Status')}</span>
            <Select value={filters.status} onValueChange={v => updateFilter('status', v)}>
              <SelectTrigger className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All')}</SelectItem>
                <SelectItem value="paid">{t('paid')}</SelectItem>
                <SelectItem value="partial">{t('partial')}</SelectItem>
                <SelectItem value="unpaid">{t('unpaid')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative flex-1 min-w-[140px]">
            <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('Search supplier, invoice...')}
              value={filters.search}
              onChange={e => updateFilter('search', e.target.value)}
              className="h-9 ps-9"
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => { setFilters(createDefaultFilters()); setPage(1); }}>
            {t('Reset')}
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrint} disabled={loading || purchases.length === 0} className="gap-1.5">
            <Printer className="h-4 w-4" />
            {t('Print')}
          </Button>
        </CardContent>
      </Card>

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-md border">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : purchases.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <FileText className="mb-2 h-10 w-10" />
            <p>{t('No purchases found')}</p>
          </div>
        ) : (
          <Table className="sticky-col">
            <TableHeader>
              <TableRow>
                <TableHead>{t('Purchase #')}</TableHead>
                <TableHead>{t('Date')}</TableHead>
                <TableHead>{t('Supplier')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('Invoice Number')}</TableHead>
                <TableHead className="text-end">{t('Total')}</TableHead>
                <TableHead className="text-end">{t('Paid')}</TableHead>
                <TableHead className="hidden lg:table-cell text-end">{t('Remaining')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchases.map(p => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => onSelect(p)}
                >
                  <TableCell className="font-medium">{p.purchase_number}</TableCell>
                  <TableCell>{p.purchase_date}</TableCell>
                  <TableCell>{p.supplier_name ?? t('N/A')}</TableCell>
                  <TableCell className="hidden lg:table-cell">{p.invoice_reference ?? '-'}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(p.total_amount)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(p.total_paid)}</TableCell>
                  <TableCell className="hidden lg:table-cell text-end tabular-nums font-medium text-destructive">
                    {p.total_amount - p.total_paid > 0 ? formatCurrency(p.total_amount - p.total_paid) : '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[p.payment_status] ?? 'secondary'}>
                      {t(p.payment_status)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <span className="text-sm text-muted-foreground">
            {t('Page')} {page} / {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
