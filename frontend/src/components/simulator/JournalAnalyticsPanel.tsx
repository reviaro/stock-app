import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useSimJournal } from '@/hooks/useSimulator'

interface Props { accountId: number }

function money(value: number | null) {
  return value == null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function pct(value: number | null) {
  return value == null ? '—' : `${value.toFixed(1)}%`
}

function rMultiple(value: number | null) {
  return value == null ? '—' : `${value.toFixed(2)}R`
}

export function JournalAnalyticsPanel({ accountId }: Props) {
  const { data, isLoading, isError } = useSimJournal(accountId)
  const analytics = data?.analytics

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle><h2>Structured Trade Journal</h2></CardTitle></CardHeader>
      <CardContent className="space-y-4 px-3 pb-4">
        <p className="text-xs text-muted-foreground">Measures process by planned risk and setup—not by win rate alone.</p>
        {isLoading && <p className="text-xs text-muted-foreground">Loading structured journal…</p>}
        {isError && <p className="text-xs text-destructive">Structured journal unavailable.</p>}
        {analytics && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
              <Metric label="Closed trades" value={String(analytics.closed_trade_count)} />
              <Metric label="Win rate" value={pct(analytics.win_rate_pct)} />
              <Metric label="Expectancy" value={money(analytics.expectancy)} />
              <Metric label="Average R" value={rMultiple(analytics.average_r)} />
              <Metric label="Profit factor" value={analytics.profit_factor == null ? '—' : analytics.profit_factor.toFixed(2)} />
              <Metric label="Total P&L" value={money(analytics.total_pnl)} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Evidence by setup</p>
              {Object.keys(analytics.by_setup).length === 0 ? (
                <p className="text-xs text-muted-foreground">No closed trades with structured plans yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead className="bg-secondary/60 text-muted-foreground"><tr><th className="px-2 py-1.5 text-left">Setup</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Avg R</th><th>Total P&L</th></tr></thead>
                    <tbody>
                      {Object.entries(analytics.by_setup).map(([setup, stats]) => (
                        <tr key={setup} className="border-t border-border/60">
                          <td className="px-2 py-1.5 font-medium">{setup}</td>
                          <td className="text-center">{stats.trade_count}</td>
                          <td className="text-center">{pct(stats.win_rate_pct)}</td>
                          <td className="text-center font-mono">{money(stats.expectancy)}</td>
                          <td className="text-center font-mono">{rMultiple(stats.average_r)}</td>
                          <td className="text-center font-mono">{money(stats.total_pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">{label}</p><p className="font-mono font-semibold">{value}</p></div>
}
