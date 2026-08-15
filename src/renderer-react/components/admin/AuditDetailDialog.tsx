import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '@/api/types';
import { actionLabel, actionBadgeVariant, formatDateTime, diffFields, resolveEntryName } from '@/lib/audit';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: AuditEntry | null;
}

/**
 * Full detail for one audit_logs row — shared by AuditPage, BatchHistoryTab,
 * and ProductProfilePage's History tab so there is exactly one place that
 * knows how to render before/after values. Each list view only needs a
 * short, safely-truncatable preview; the complete change always renders
 * here as a real "Field | Previous | New" table, not a wall of raw JSON —
 * an event touching several fields at once was unreadable as one blob.
 * The table sits in a bounded, scrollable region (max-h-[85vh] on the
 * dialog itself) so a long change list scrolls instead of overflowing the
 * viewport.
 */
export function AuditDetailDialog({ open, onOpenChange, entry }: Props) {
  const { t } = useTranslation();
  const name = entry ? resolveEntryName(entry) : null;
  const fields = entry ? diffFields(entry.old_values, entry.new_values) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{name ?? t('Audit Entry Details')}</DialogTitle>
          <DialogDescription>
            {entry ? `${t(actionLabel(entry.action))} — ${formatDateTime(entry.created_at)}` : ''}
          </DialogDescription>
        </DialogHeader>

        {entry && (
          <div className="flex-1 min-h-0 space-y-4 overflow-y-auto pe-1">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div>
                <span className="font-medium text-muted-foreground">{t('Action')}:</span>{' '}
                <Badge variant={actionBadgeVariant(entry.action)} className="ms-1">
                  {t(actionLabel(entry.action))}
                </Badge>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">{t('User')}:</span>{' '}
                {entry.username || `#${entry.user_id}`}
              </div>
              {name && (
                <div className="col-span-2">
                  <span className="font-medium text-muted-foreground">{t('Product')}:</span>{' '}
                  {name}
                  {entry.batch_number && (
                    <span className="text-muted-foreground"> · {t('Batch')} {entry.batch_number}</span>
                  )}
                </div>
              )}
              <div className="col-span-2">
                <span className="font-medium text-muted-foreground">{t('Time')}:</span>{' '}
                {formatDateTime(entry.created_at)}
              </div>
            </div>

            {fields.length > 0 ? (
              <div className="rounded-md border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Field')}</TableHead>
                      <TableHead>{t('Previous Value')}</TableHead>
                      <TableHead>{t('New Value')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f) => (
                      <TableRow key={f.key}>
                        <TableCell className="font-medium text-sm">{f.label}</TableCell>
                        <TableCell className={`text-sm break-words ${f.changed ? 'text-muted-foreground line-through decoration-muted-foreground/50' : 'text-muted-foreground'}`}>
                          {f.oldValue}
                        </TableCell>
                        <TableCell className={`text-sm break-words ${f.changed ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                          {f.newValue}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-center text-sm text-muted-foreground py-6">{t('No detail data available.')}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
