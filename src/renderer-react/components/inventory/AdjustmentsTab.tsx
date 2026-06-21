import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import type { InventoryAdjustment } from '@/api/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Undo2 } from 'lucide-react';
import { usePermission } from '@/hooks/usePermission';

export function AdjustmentsTab() {
  const { t } = useTranslation();
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [reversing, setReversing] = useState<number | null>(null);

  const canManage = usePermission('inventory.batches.damage');

  const fetchAdjustments = async () => {
    setLoading(true);
    try {
      const data = await api.inventory.getAdjustments() as InventoryAdjustment[];
      setAdjustments(data);
    } catch {
      toast.error(t('Failed to load adjustments'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdjustments();
  }, []);

  const handleReverse = async (id: number) => {
    if (!window.confirm(t('Are you sure you want to reverse this adjustment? This will restore the inventory quantity.'))) return;
    
    setReversing(id);
    try {
      await api.inventory.reverseAdjustment(id);
      toast.success(t('Adjustment reversed successfully'));
      await fetchAdjustments();
    } catch (err: any) {
      toast.error(err.message || t('Failed to reverse adjustment'));
    } finally {
      setReversing(null);
    }
  };

  if (loading) return <Skeleton className="h-[400px] w-full" />;

  return (
    <div className="flex h-full flex-col p-4 bg-background">
      <div className="mb-4">
        <h2 className="text-xl font-bold">{t('Inventory Adjustments')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('History of damages, expiries, and manual corrections.')}
        </p>
      </div>

      <div className="flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Date')}</TableHead>
              <TableHead>{t('Product')}</TableHead>
              <TableHead>{t('Batch')}</TableHead>
              <TableHead>{t('Type')}</TableHead>
              <TableHead className="text-end">{t('Quantity')}</TableHead>
              <TableHead>{t('Reason')}</TableHead>
              <TableHead>{t('User')}</TableHead>
              {canManage && <TableHead className="w-[80px]"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {adjustments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManage ? 8 : 7} className="h-24 text-center">
                  {t('No adjustments found')}
                </TableCell>
              </TableRow>
            ) : (
              adjustments.map((adj) => (
                <TableRow key={adj.id}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(adj.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium">{adj.product_name}</TableCell>
                  <TableCell>{adj.batch_number || '-'}</TableCell>
                  <TableCell>
                    <Badge variant={adj.type === 'damage' ? 'destructive' : adj.type === 'expiry' ? 'warning' : 'secondary'}>
                      {t(adj.type)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end font-mono">
                    {adj.quantity_base > 0 ? `-${adj.quantity_base}` : `+${Math.abs(adj.quantity_base)}`}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate" title={adj.reason || ''}>
                    {adj.reason || '-'}
                  </TableCell>
                  <TableCell>{adj.username}</TableCell>
                  {canManage && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={reversing === adj.id || adj.quantity_base < 0 || adj.reason?.startsWith('Reversal of')}
                        onClick={() => handleReverse(adj.id)}
                        className="h-8 w-8 p-0"
                        title={t('Reverse')}
                      >
                        <Undo2 className="h-4 w-4" />
                        <span className="sr-only">{t('Reverse')}</span>
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
