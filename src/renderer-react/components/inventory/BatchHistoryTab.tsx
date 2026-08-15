import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { AuditEntry } from '@/api/types';
import { useDebounce } from '@/hooks/useDebounce';
import { actionLabel, actionBadgeVariant, summarizeDiff, resolveEntryName } from '@/lib/audit';
import { AuditDetailDialog } from '@/components/admin/AuditDetailDialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Search } from 'lucide-react';
import { DataPagination } from '@/components/ui/data-pagination';

const PAGE_SIZE = 25;

// Every action the services emit with table_name='batches' (this view is
// scoped to that table_name). Keep this in sync with the `entity:mutated`
// call sites in batch.service.ts/transaction.service.ts — a dropdown that's
// missing an action means a user filtering for it will never find it, even
// though "All changes" shows it (I6).
//
// NOT included: BULK_UPDATE_BATCH_PRICES / PROPAGATE_SELLING_PRICE /
// CASCADE_CF_CHANGE — these re-price or rescale every batch of a product but
// are logged under table_name='products' (recordId is a product id, not a
// batch id — I2), so they belong in a product history view, not this one.
const BATCH_ACTIONS = [
  'CREATE_BATCH', 'UPDATE_BATCH', 'DELETE_BATCH', 'RESTORE_BATCH',
  'REPORT_DAMAGE', 'REVERSE_ADJUSTMENT', 'VOID_STOCK_SKIP',
  'BULK_MARGIN_PRICE_UPDATE', 'BULK_MANUAL_PRICE_UPDATE',
];

export function BatchHistoryTab() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const filters: Record<string, unknown> = { table_name: 'batches', page, limit: PAGE_SIZE };
      if (actionFilter !== 'all') filters.action = actionFilter;
      // Filtered server-side over the full result set — the previous version
      // filtered only the 25 rows already on screen while the pager kept
      // showing the unfiltered total, so a real match sitting on another
      // page read as "not found" (I5).
      if (debouncedSearch.trim()) filters.search = debouncedSearch.trim();
      const res = await api.audit.getAll(filters);
      setEntries(Array.isArray(res.data) ? res.data : []);
      setTotal(res.total ?? 0);
      setTotalPages(res.totalPages ?? 1);
    } catch (err) { console.error(err); setEntries([]); }
    finally { setLoading(false); }
  }, [page, actionFilter, debouncedSearch]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);
  useEffect(() => { setPage(1); }, [actionFilter, debouncedSearch]);

  function openDetail(entry: AuditEntry) {
    setDetailEntry(entry);
    setDetailOpen(true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="ps-8" placeholder={t('Search product, action or user...')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="w-56"><SelectValue placeholder={t('Action')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All changes')}</SelectItem>
            {BATCH_ACTIONS.map(a => <SelectItem key={a} value={a}>{t(actionLabel(a))}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <Skeleton className="h-[360px] w-full" />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t('Date')}</TableHead>
                <TableHead>{t('Action')}</TableHead>
                <TableHead>{t('Product')}</TableHead>
                <TableHead>{t('Change')}</TableHead>
                <TableHead>{t('User')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">{t('No batch changes found')}</TableCell></TableRow>
              ) : entries.map(e => {
                const name = resolveEntryName(e);
                return (
                  <TableRow key={e.id} className="cursor-pointer" onClick={() => openDetail(e)}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</TableCell>
                    <TableCell><Badge variant={actionBadgeVariant(e.action)}>{t(actionLabel(e.action))}</Badge></TableCell>
                    <TableCell className="max-w-[220px] truncate text-sm font-medium" title={name ?? undefined}>
                      {name ?? <span className="text-muted-foreground">{t('Unknown product')}</span>}
                      {e.batch_number && <span className="ms-1 font-normal text-xs text-muted-foreground">({e.batch_number})</span>}
                    </TableCell>
                    <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground" title={summarizeDiff(e.old_values, e.new_values)}>
                      {summarizeDiff(e.old_values, e.new_values) || '—'}
                    </TableCell>
                    <TableCell className="text-sm">{e.username || '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {totalPages > 1 && <DataPagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />}

      <AuditDetailDialog open={detailOpen} onOpenChange={setDetailOpen} entry={detailEntry} />
    </div>
  );
}
