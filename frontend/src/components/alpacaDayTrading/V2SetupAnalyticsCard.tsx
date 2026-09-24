import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useV2Journal } from '@/hooks/useAlpacaDayTradingV2'
import type { AlpacaV2GroupStats } from '@/types/alpacaDayTrading'
import { pct, rMultiple, usd } from './v2Format'

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="font-mono text-sm">{value}</dd></div>
}

function Breakdown({ title, groups }: { title: string; groups: Record<string, AlpacaV2GroupStats> }) {
  const rows = Object.entries(groups)
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {rows.length === 0 ? <p className="text-muted-foreground">No closed trades yet.</p> : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[420px]">
            <thead className="bg-secondary/60 text-muted-foreground"><tr><th className="px-2 py-1 text-left">Group</th><th>Trades</th><th>Win rate</th><th>P&amp;L</th><th>Exp. $</th><th>Exp. R</th></tr></thead>
            <tbody>
              {rows.map(([key, stats]) => (
                <tr key={key} className="border-t border-border/60 text-center">
                  <td className="px-2 py-1 text-left">{key}</td><td>{stats.count}</td><td>{pct(stats.winRate)}</td>
                  <td>{usd(stats.realizedPnl)}</td><td>{usd(stats.expectancyDollars)}</td><td>{rMultiple(stats.expectancyR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function V2SetupAnalyticsCard() {
  const { data, isLoading, isError } = useV2Journal()
  const a = data?.analytics
  return (
    <section aria-label="Setup analytics">
      <Card>
        <CardHeader className="pb-2"><CardTitle><h2>Setup analytics (v2 only)</h2></CardTitle></CardHeader>
        <CardContent className="space-y-3 px-3 pb-4 text-xs">
          {isLoading && <p className="text-muted-foreground">Loading analytics…</p>}
          {isError && <p className="text-destructive">Unable to load analytics.</p>}
          {a && (
            <>
              <p className={`rounded-md border px-3 py-2 ${a.sample.preliminary ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-100' : 'border-border text-muted-foreground'}`}>{a.sample.note}</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Closed trades" value={String(a.closedTradeCount)} />
                <Stat label="Win rate" value={pct(a.winRate)} />
                <Stat label="Expectancy" value={`${usd(a.expectancyDollars)} · ${rMultiple(a.expectancyR)}`} />
                <Stat label="Realized P&L" value={usd(a.realizedPnl)} />
                <Stat label="Profit factor" value={a.profitFactor == null ? '—' : a.profitFactor.toFixed(2)} />
                <Stat label="Avg win / loss" value={`${usd(a.averageWin)} / ${usd(a.averageLoss)}`} />
                <Stat label="Max losing streak" value={String(a.maxConsecutiveLosses)} />
                <Stat label="Avg hold" value={a.averageHoldMinutes == null ? '—' : `${a.averageHoldMinutes} min`} />
              </dl>
              <div className="grid gap-3 lg:grid-cols-2">
                <Breakdown title="By setup" groups={a.bySetup} />
                <Breakdown title="By catalyst class" groups={a.byCatalyst} />
                <Breakdown title="By entry window (ET)" groups={a.byWindow} />
                <Breakdown title="By session date" groups={a.bySessionDate} />
              </div>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">NO TRADE decisions ({a.noTrade.count})</dt>
                  <dd className="font-mono">{Object.entries(a.noTrade.byReason).map(([reason, n]) => `${reason} ×${n}`).join(', ') || '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Attention incidents ({a.attention.count})</dt>
                  <dd className="font-mono">{Object.entries(a.attention.byCode).map(([code, n]) => `${code} ×${n}`).join(', ') || '—'}</dd>
                </div>
              </dl>
              <p className="text-muted-foreground">NO TRADE decisions, attention incidents, open plans, operator-resolved plans ({a.excludedOperatorResolved}), and v1 history are excluded from expectancy.</p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
