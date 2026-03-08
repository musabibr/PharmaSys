import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';

/** Placeholder for pages not yet implemented. */
export function PlaceholderPage({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t(title)}</h1>
      <Card>
        <CardContent className="flex items-center justify-center p-12">
          <p className="text-muted-foreground">{t('Coming soon — this page will be built in a future phase.')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
