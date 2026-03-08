import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';

const useIsRtl = () => {
  const { i18n } = useTranslation();
  return i18n.dir() === 'rtl';
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DailyDataPoint {
  date: string;
  sales: number;
  returns: number;
  profit: number;
}

export interface DailyTrendChartProps {
  data: DailyDataPoint[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a date string as "Jan 1" or "1 يناير" depending on locale */
function formatShortDate(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(locale === 'ar' ? 'ar-SD' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Abbreviate large SDG values for Y-axis readability: 1000 -> "1k", 1500000 -> "1.5M" */
function abbreviateValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    const k = value / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Custom Tooltip
// ---------------------------------------------------------------------------

interface TooltipPayloadEntry {
  name: string;
  value: number;
  color: string;
  dataKey: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  t: (key: string) => string;
  locale: string;
}

function ChartTooltip({ active, payload, label, t, locale }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border bg-background p-3 shadow-md">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {label ? formatShortDate(label, locale) : ''}
      </p>
      {payload.map((entry) => (
        <div
          key={entry.dataKey}
          className="flex items-center justify-between gap-4 text-sm"
        >
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: entry.color }}
            />
            {entry.name}
          </span>
          <span className="tabular-nums font-medium">
            {formatCurrency(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DailyTrendChart
// ---------------------------------------------------------------------------

export function DailyTrendChart({ data }: DailyTrendChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const isRtl = i18n.dir() === 'rtl';

  // Prepare chart data with formatted dates for X-axis labels
  const chartData = useMemo(() => {
    if (!Array.isArray(data)) return [];
    return data.map((d) => ({
      ...d,
      dateLabel: formatShortDate(d.date, locale),
    }));
  }, [data, locale]);

  // Empty state
  if (chartData.length === 0) {
    return (
      <div className="flex min-h-[300px] items-center justify-center text-muted-foreground">
        <p className="text-sm">{t('No data available for the selected period')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-[300px] w-full">
      <ResponsiveContainer width="100%" height={350}>
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: isRtl ? 50 : 16, left: isRtl ? 8 : 50, bottom: 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            className="stroke-border"
            vertical={false}
          />

          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 12 }}
            className="text-muted-foreground"
            tickLine={false}
            axisLine={false}
            interval={chartData.length > 15 ? Math.floor(chartData.length / 10) : 0}
            reversed={isRtl}
          />

          <YAxis
            tickFormatter={abbreviateValue}
            tick={{ fontSize: 12 }}
            className="text-muted-foreground"
            tickLine={false}
            axisLine={false}
            width={50}
            orientation={isRtl ? 'right' : 'left'}
          />

          <RechartsTooltip
            content={
              <ChartTooltip t={t} locale={locale} />
            }
          />

          <Legend
            formatter={(value: string) => (
              <span className="text-sm text-foreground">{value}</span>
            )}
          />

          {/* Sales: blue bars */}
          <Bar
            dataKey="sales"
            name={t('Sales')}
            fill="#3b82f6"
            radius={[4, 4, 0, 0]}
            barSize={chartData.length > 20 ? 12 : 24}
          />

          {/* Returns: red bars, semi-transparent */}
          <Bar
            dataKey="returns"
            name={t('Returns')}
            fill="#ef4444"
            fillOpacity={0.6}
            radius={[4, 4, 0, 0]}
            barSize={chartData.length > 20 ? 12 : 24}
          />

          {/* Profit: green line overlaid */}
          <Line
            type="monotone"
            dataKey="profit"
            name={t('Profit')}
            stroke="#22c55e"
            strokeWidth={2}
            dot={{ r: 3, fill: '#22c55e', strokeWidth: 0 }}
            activeDot={{ r: 5, fill: '#22c55e', strokeWidth: 2, stroke: '#fff' }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
