import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTickerStore } from '@/lib/store'
import { useQuality } from '@/hooks/useQuality'

const METRIC_LABELS: Record<string, string> = {
  roic: 'ROIC',
  fcf_margin: 'FCF Margin',
  debt_equity: 'Debt / Equity',
  interest_coverage: 'Interest Coverage',
  earnings_consistency: 'Earnings Consistency',
  gm_stability: 'Gross Margin Stability',
  revenue_cagr: 'Revenue CAGR',
}

function scoreColor(score: number | null) {
  if (score == null) return 'text-muted-foreground'
  if (score >= 80) return 'text-green-400'
  if (score >= 65) return 'text-amber-400'
  return 'text-red-400'
}

function formatMetricValue(value: number | null, unit: string) {
  if (value == null) return '—'
  if (unit === '%') return `${value.toFixed(1)}%`
  if (unit === '/10') return `${value.toFixed(1)}/10`
  if (unit === 'cv') return value.toFixed(2)
  return `${value.toFixed(2)}${unit === 'x' ? 'x' : ''}`
}

export function QualityScorecard({ symbol }: { symbol?: string }) {
  const selected = useTickerStore((s) => s.selectedTicker)
  const activeSymbol = symbol || selected
  const { data, isLoading, error } = useQuality(activeSymbol)

  return (
    <Card className="h-full min-h-[220px]">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Quality Scorecard
            {activeSymbol && <span className="ml-2 text-primary font-bold">{activeSymbol}</span>}
          </CardTitle>
          {data && (
            <div className="flex items-center gap-2">
              <span className={`text-2xl font-bold ${scoreColor(data.composite)}`}>{data.composite ?? '—'}</span>
              <Badge variant="outline">0-100</Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!activeSymbol && <p className="text-muted-foreground text-sm">Select a stock to view business-quality metrics.</p>}
        {activeSymbol && isLoading && <p className="text-muted-foreground text-sm animate-pulse">Loading quality metrics...</p>}
        {activeSymbol && error && <p className="text-destructive text-sm">{error instanceof Error ? error.message : 'Failed to load quality metrics'}</p>}
        {data && (
          <div className="space-y-2">
            {Object.entries(data.metrics).map(([key, metric]) => (
              <div key={key} className="data-hover flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                <div>
                  <p className="text-xs text-muted-foreground">{METRIC_LABELS[key] ?? key}</p>
                  <p className="text-sm font-medium text-foreground">{formatMetricValue(metric.value, metric.unit)}</p>
                </div>
                <Badge variant={metric.grade === 'A' ? 'default' : metric.grade === 'B' ? 'secondary' : metric.grade === 'C' ? 'outline' : 'destructive'}>
                  {metric.grade ?? '—'}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default QualityScorecard
