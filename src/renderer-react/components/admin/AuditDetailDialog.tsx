import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '@/api/types';
import { actionLabel, actionBadgeVariant, formatDateTime, safeJsonFormat, resolveEntryName } from '@/lib/audit';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: AuditEntry | null;
}

/**
 * Full detail for one audit_logs row — shared by AuditPage, BatchHistoryTab,
 * and ProductProfilePage's History tab so there is exactly one place
 * that knows how to render before/after JSON. Each list view only needs a
 * short, safely-truncatable preview; the complete values always live here,
 * in a scrollable area (max-h-64) so a large payload never gets clipped by
 * the dialog's own bounds instead of scrolling.
 */
export function AuditDetailDialog({ open, onOpenChange, entry }: Props) {
  const { t } = useTranslation();
  const name = entry ? resolveEntryName(entry) : null;

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

            <Separator />

            {entry.old_values && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold">{t('Previous Values')}</Label>
                <ScrollArea className="max-h-64 rounded-md border bg-muted/50 p-1">
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                    {safeJsonFormat(entry.old_values)}
                  </pre>
                </ScrollArea>
              </div>
            )}

            {entry.new_values && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold">{t('New Values')}</Label>
                <ScrollArea className="max-h-64 rounded-md border bg-muted/50 p-1">
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                    {safeJsonFormat(entry.new_values)}
                  </pre>
                </ScrollArea>
              </div>
            )}

            {!entry.old_values && !entry.new_values && (
              <p className="text-center text-sm text-muted-foreground">{t('No detail data available.')}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
