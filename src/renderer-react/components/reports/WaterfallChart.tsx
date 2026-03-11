import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { useUiStore } from '@/stores/ui.store';

const useIsRtl = () => {
  const { i18n } = useTranslation();
  return i18n.dir() === 'rtl';
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaterfallItem {
  name: string;
  value: number;
  type: 'positive' | 'negative' | 'total';
}

interface WaterfallChartProps {
  data: WaterfallItem[];
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const COLORS = {
  positive: '#22c55e',
  negative: '#ef4444',
  total: '#3b82f6',
  base: 'transparent',
} as const;

// ---------------------------------------------------------------------------
// Internal data shape for stacked bars
// ---------------------------------------------------------------------------

interface WaterfallBar {
  name: string;
  base: number;
  value: number;
  displayValue: number;
  type: 'positive' | 'negative' | 'total';
}

// ---------------------------------------------------------------------------
// Transform waterfall items into stacked bar format
// ---------------------------------------------------------------------------

function buildWaterfallBars(items: WaterfallItem[]): WaterfallBar[] {
  const bars: WaterfallBar[] = [];
  let runningTotal = 0;

  for (const item of items) {
    if (item.type === 'total') {
      // Total bars always start from 0
      bars.push({
        name: item.name,
        base: 0,
        value: item.value,
        displayValue: item.value,
        type: 'total',
      });
      runningTotal = item.value;
    } else if (item.type === 'positive') {
      // Positive items stack on top of the running total
      bars.push({
        name: item.name,
        base: runningTotal,
        value: item.value,
        displayValue: item.value,
        type: 'positive',
      });
      runningTotal += item.value;
    } else {
      // Negative items: value is negative, bar shows absolute value
      // Base is the running total after the deduction
      const absValue = Math.abs(item.value);
      runningTotal -= absValue;
      bars.push({
        name: item.name,
        base: runningTotal,
        value: absValue,
        displayValue: item.value,
        type: 'negative',
      });
    }
  }

  return bars;
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: WaterfallBar;
  }>;
}

function WaterfallTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const bar = payload[0]?.payload;
  if (!bar) return null;

  return (
    <div className="rounded-md border bg-popover px-3 py-2 shadow-md">
      <p className="text-sm font-medium text-popover-foreground">{bar.name}</p>
      <p
        className="text-sm tabular-nums"
        style={{ color: COLORS[bar.type] }}
      >
        {bar.type === 'negative' ? '- ' : ''}
        {formatCurrency(Math.abs(bar.displayValue))}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Y-axis tick formatter
// ---------------------------------------------------------------------------

function formatYTick(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(0)}K`;
  }
  return value.toLocaleString();
}

// ---------------------------------------------------------------------------
// WaterfallChart
// ---------------------------------------------------------------------------

export function WaterfallChart({ data }: WaterfallChartProps) {
  const { t } = useTranslation();
  const isCompact = useUiStore((s) => s.resolvedDensity()) === 'compact';

  const bars = useMemo(() => buildWaterfallBars(data), [data]);

  if (bars.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <p className="text-sm">{t('No data to display')}</p>
      </div>
    );
  }

  const isRtl = useIsRtl();

  return (
    <ResponsiveContainer width="100%" height={isCompact ? 260 : 360}>
      <BarChart
        data={bars}
        margin={{ top: 20, right: isRtl ? 70 : 20, bottom: 20, left: isRtl ? 20 : 70 }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          interval={0}
          angle={isRtl ? 20 : -20}
          textAnchor={isRtl ? 'start' : 'end'}
          height={60}
          reversed={isRtl}
        />
        <YAxis
          tickFormatter={formatYTick}
          tick={{ fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={70}
          orientation={isRtl ? 'right' : 'left'}
        />
        <Tooltip
          content={<WaterfallTooltip />}
          cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
        />
        <ReferenceLine y={0} stroke="hsl(var(--border))" />

        {/* Invisible base segment */}
        <Bar dataKey="base" stackId="waterfall" fill="transparent" isAnimationActive={false}>
          {bars.map((entry, index) => (
            <Cell key={`base-${index}`} fill="transparent" />
          ))}
        </Bar>

        {/* Visible value segment */}
        <Bar dataKey="value" stackId="waterfall" radius={[4, 4, 0, 0]}>
          {bars.map((entry, index) => (
            <Cell key={`value-${index}`} fill={COLORS[entry.type]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
