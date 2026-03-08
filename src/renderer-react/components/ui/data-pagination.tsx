import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

interface DataPaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function DataPagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  className,
}: DataPaginationProps) {
  const { t } = useTranslation();

  if (totalPages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className={`flex items-center justify-between border-t pt-3 ${className ?? ''}`}>
      <p className="text-sm text-muted-foreground">
        {t('Showing')} {from}–{to} {t('of')} {total}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft className="me-1 h-4 w-4" />
          {t('Previous')}
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          {t('Next')}
          <ChevronRight className="ms-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
