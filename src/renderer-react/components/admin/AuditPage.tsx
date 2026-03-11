import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { AuditEntry, User } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { DataPagination } from '@/components/ui/data-pagination';
import {
  Filter,
  RotateCcw,
  Eye,
  ShieldAlert,
  AlertTriangle,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 10;

const ACTION_OPTIONS = [
  'LOGIN',
  'LOGOUT',
  'CREATE_PRODUCT',
  'UPDATE_PRODUCT',
  'CREATE_BATCH',
  'UPDATE_BATCH',
  'CREATE_SALE',
  'VOID_TRANSACTION',
  'CREATE_RETURN',
  'CREATE_EXPENSE',
  'OPEN_SHIFT',
  'CLOSE_SHIFT',
  'CHANGE_PASSWORD',
  'UPDATE_SETTING',
] as const;

const TABLE_OPTIONS = [
  'users',
  'products',
  'batches',
  'transactions',
  'expenses',
  'shifts',
  'settings',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return (
      d.toLocaleDateString() +
      ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    );
  } catch {
    return dateStr;
  }
}

function getDefaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().split('T')[0];
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  return { from, to };
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

function getActionBadgeVariant(action: string): BadgeVariant {
  if (action.startsWith('CREATE_')) return 'success';
  if (action.startsWith('UPDATE_')) return 'secondary';
  if (action.startsWith('DELETE_') || action.startsWith('VOID_')) return 'destructive';
  if (action === 'LOGIN' || action === 'LOGOUT') return 'outline';
  return 'default';
}

function safeJsonFormat(value: string | null): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

interface AuditFilters {
  startDate: string;
  endDate: string;
  userId: string; // 'all' or numeric string
  action: string; // 'all' or action name
  tableName: string; // 'all' or table name
}

function createDefaultFilters(): AuditFilters {
  const range = getDefaultDateRange();
  return {
    startDate: range.from,
    endDate: range.to,
    userId: 'all',
    action: 'all',
    tableName: 'all',
  };
}

// ---------------------------------------------------------------------------
// AuditPage
// ---------------------------------------------------------------------------

export function AuditPage() {
  const { t } = useTranslation();

  // ---- Filter state ----
  const [filters, setFilters] = useState<AuditFilters>(createDefaultFilters);

  // ---- Data state ----
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // ---- Detail dialog state ----
  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // ---- Load users on mount ----
  useEffect(() => {
    async function loadUsers() {
      try {
        const data = await api.users.getAll();
        if (Array.isArray(data)) {
          setUsers(data);
        }
      } catch {
        // Users list is non-critical; filter will still work without it
      }
    }
    loadUsers();
  }, []);

  // ---- Fetch audit entries ----
  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiFilters: Record<string, unknown> = {
        start_date: filters.startDate,
        end_date: filters.endDate,
        limit: PAGE_SIZE,
        page: page,
      };
      if (filters.userId !== 'all') {
        apiFilters.user_id = Number(filters.userId);
      }
      if (filters.action !== 'all') {
        apiFilters.action = filters.action;
      }
      if (filters.tableName !== 'all') {
        apiFilters.table_name = filters.tableName;
      }

      const result = await api.audit.getAll(apiFilters);
      setEntries(Array.isArray(result.data) ? result.data : []);
      setTotalPages(result.totalPages ?? 1);
      setTotal(result.total ?? 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(t('Failed to load audit log'));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [filters.startDate, filters.endDate, filters.userId, filters.action, filters.tableName, page, t]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // ---- Filter handlers ----
  function updateFilter<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  function handleApply() {
    setPage(1);
    fetchEntries();
  }

  function handleReset() {
    setFilters(createDefaultFilters());
    setPage(1);
  }

  // ---- Detail handlers ----
  function handleViewDetail(entry: AuditEntry) {
    setDetailEntry(entry);
    setDetailOpen(true);
  }

  // ---- Pagination ----

  // ---- Render ----
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* ---- Header ---- */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('Audit Log')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('Track all system changes and user actions')}
        </p>
      </div>

      {/* ---- Filter Bar ---- */}
      <Card data-tour="audit-filter">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            {/* Date range: From */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('From')}</Label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => updateFilter('startDate', e.target.value)}
                className="w-40"
              />
            </div>

            {/* Date range: To */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('To')}</Label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => updateFilter('endDate', e.target.value)}
                className="w-40"
              />
            </div>

            {/* User filter */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('User')}</Label>
              <Select
                value={filters.userId}
                onValueChange={(v) => updateFilter('userId', v)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={String(user.id)}>
                      {user.full_name || user.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Action filter */}
            <div className="space-y-1.5">
              <Label className="text-xs">
                <Filter className="me-1 inline h-3 w-3" />
                {t('Action')}
              </Label>
              <Select
                value={filters.action}
                onValueChange={(v) => updateFilter('action', v)}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  {ACTION_OPTIONS.map((action) => (
                    <SelectItem key={action} value={action}>
                      {action}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Table filter */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('Table')}</Label>
              <Select
                value={filters.tableName}
                onValueChange={(v) => updateFilter('tableName', v)}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All')}</SelectItem>
                  {TABLE_OPTIONS.map((table) => (
                    <SelectItem key={table} value={table}>
                      {table}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Spacer to push buttons to the right when there's room */}
            <div className="flex-1" />

            {/* Apply */}
            <Button onClick={handleApply} className="shrink-0">
              <Filter className="me-1.5 h-4 w-4" />
              {t('Apply')}
            </Button>

            {/* Reset */}
            <Button variant="outline" onClick={handleReset} className="shrink-0">
              <RotateCcw className="me-1.5 h-4 w-4" />
              {t('Reset')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ---- Audit Table ---- */}
      <div className="flex-1 overflow-auto rounded-md border" data-tour="audit-list">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive/40" />
            <p className="mt-3 text-sm font-medium text-destructive">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={fetchEntries}
            >
              <RotateCcw className="me-1.5 h-4 w-4" />
              {t('Try again')}
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShieldAlert className="h-12 w-12 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              {t('No audit entries found')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              {t('Try adjusting your filters or date range.')}
            </p>
          </div>
        ) : (
          <Table className="sticky-col">
            <TableHeader>
              <TableRow>
                <TableHead>{t('Time')}</TableHead>
                <TableHead>{t('User')}</TableHead>
                <TableHead>{t('Action')}</TableHead>
                <TableHead>{t('Table')}</TableHead>
                <TableHead>{t('Record ID')}</TableHead>
                <TableHead className="text-end">{t('Details')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  {/* Time */}
                  <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                    {formatDateTime(entry.created_at)}
                  </TableCell>

                  {/* User */}
                  <TableCell className="font-medium">
                    {entry.username || `#${entry.user_id}`}
                  </TableCell>

                  {/* Action badge */}
                  <TableCell>
                    <Badge variant={getActionBadgeVariant(entry.action)}>
                      {entry.action}
                    </Badge>
                  </TableCell>

                  {/* Table name */}
                  <TableCell className="text-sm">
                    {entry.table_name || '\u2014'}
                  </TableCell>

                  {/* Record ID */}
                  <TableCell className="tabular-nums text-sm">
                    {entry.record_id != null ? entry.record_id : '\u2014'}
                  </TableCell>

                  {/* Details button */}
                  <TableCell className="text-end">
                    {(entry.old_values || entry.new_values) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewDetail(entry)}
                      >
                        <Eye className="me-1.5 h-4 w-4" />
                        {t('View')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">{'\u2014'}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ---- Pagination ---- */}
      <DataPagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />

      {/* ---- Detail Dialog ---- */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Audit Entry Details')}</DialogTitle>
            <DialogDescription>
              {detailEntry
                ? `${detailEntry.action} — ${formatDateTime(detailEntry.created_at)}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          {detailEntry && (
            <div className="space-y-4">
              {/* Summary row */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <span className="font-medium text-muted-foreground">{t('Action')}:</span>{' '}
                  <Badge variant={getActionBadgeVariant(detailEntry.action)} className="ms-1">
                    {detailEntry.action}
                  </Badge>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">{t('User')}:</span>{' '}
                  {detailEntry.username || `#${detailEntry.user_id}`}
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">{t('Table')}:</span>{' '}
                  {detailEntry.table_name || '\u2014'}
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">{t('Record ID')}:</span>{' '}
                  {detailEntry.record_id != null ? detailEntry.record_id : '\u2014'}
                </div>
                <div className="col-span-2">
                  <span className="font-medium text-muted-foreground">{t('Time')}:</span>{' '}
                  {formatDateTime(detailEntry.created_at)}
                </div>
              </div>

              <Separator />

              {/* Previous Values */}
              {detailEntry.old_values && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">{t('Previous Values')}</Label>
                  <ScrollArea className="max-h-64 rounded-md border bg-muted/50 p-1">
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                      {safeJsonFormat(detailEntry.old_values)}
                    </pre>
                  </ScrollArea>
                </div>
              )}

              {/* New Values */}
              {detailEntry.new_values && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">{t('New Values')}</Label>
                  <ScrollArea className="max-h-64 rounded-md border bg-muted/50 p-1">
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                      {safeJsonFormat(detailEntry.new_values)}
                    </pre>
                  </ScrollArea>
                </div>
              )}

              {/* Edge case: dialog opened but both null (shouldn't happen given button guard) */}
              {!detailEntry.old_values && !detailEntry.new_values && (
                <p className="text-center text-sm text-muted-foreground">
                  {t('No detail data available.')}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
