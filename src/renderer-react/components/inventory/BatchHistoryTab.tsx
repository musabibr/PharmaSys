import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api';
import type { AuditEntry } from '@/api/types';
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

// Every batch CRUD action that the services emit to the audit log.
const BATCH_ACTIONS = [
  'CREATE_BATCH', 'UPDATE_BATCH', 'DELETE_BATCH',
  'REPORT_DAMAGE', 'REVERSE_ADJUSTMENT', 'BULK_UPDATE_BATCH_PRICES',
];

function actionVariant(a: string): 'default' | 'secondary' | 'destructive' | 'warning' | 'success' {
  if (a === 'CREATE_BATCH') return 'success';
  if (a === 'DELETE_BATCH') return 'destructive';
  if (a === 'REPORT_DAMAGE') return 'warning';
  return 'secondary';
}

// Compact "field: value" summary from a JSON values blob.
function summarize(json: string | null): string {
  if (!json) return '';
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return '';
    return Object.entries(obj)
      .filter(([k]) => k !== 'version')
      .map(([k, v]) => `${k}: ${v ?? '—'}`)
      .join(', ');
  } catch { return ''; }
}

export function BatchHistoryTab() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('all');
  const [search, setSearch] = useState('');

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const filters: Record<string, unknown> = { table_name: 'batches', page, limit: PAGE_SIZE };
      if (actionFilter !== 'all') filters.action = actionFilter;
      const res = await api.audit.getAll(filters);
      setEntries(Array.isArray(res.data) ? res.data : []);
      setTotal(res.total ?? 0);
      setTotalPages(res.totalPages ?? 1);
    } catch (err) { console.error(err); setEntries([]); }
    finally { setLoading(false); }
  }, [page, actionFilter]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);
  useEffect(() => { setPage(1); }, [actionFilter]);

  const q = search.trim().toLowerCase();
  const visible = q
    ? entries.filter(e =>
        e.action.toLowerCase().includes(q) ||
        (e.username ?? '').toLowerCase().includes(q) ||
        summarize(e.new_values).toLowerCase().includes(q) ||
        String(e.record_id ?? '').includes(q))
    : entries;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="ps-8" placeholder={t('Search action, batch or user...')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="w-56"><SelectValue placeholder={t('Action')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All changes')}</SelectItem>
            {BATCH_ACTIONS.map(a => <SelectItem key={a} value={a}>{t(a)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <Skeleton className="h-[360px] w-full" />
      ) : (
        <div className="flex-1 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t('Date')}</TableHead>
                <TableHead>{t('Action')}</TableHead>
                <TableHead>{t('Batch')}</TableHead>
                <TableHead>{t('Change')}</TableHead>
                <TableHead>{t('User')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">{t('No batch changes found')}</TableCell></TableRow>
              ) : visible.map(e => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</TableCell>
                  <TableCell><Badge variant={actionVariant(e.action)}>{t(e.action)}</Badge></TableCell>
                  <TableCell className="text-sm">#{e.record_id ?? '—'}</TableCell>
                  <TableCell className="max-w-[360px] truncate text-xs text-muted-foreground" title={summarize(e.new_values) || summarize(e.old_values)}>
                    {summarize(e.new_values) || summarize(e.old_values) || '—'}
                  </TableCell>
                  <TableCell className="text-sm">{e.username || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {totalPages > 1 && <DataPagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />}
    </div>
  );
}
