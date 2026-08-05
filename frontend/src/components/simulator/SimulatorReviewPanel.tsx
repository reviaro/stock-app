import { useSimReview } from '@/hooks/useSimulator'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function fmt(n: number | null | undefined, d = 2) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

interface Props {
  accountId: number
}

export function SimulatorReviewPanel({ accountId }: Props) {
  const { data, isLoading, isError } = useSimReview(accountId)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Buffett Review</CardTitle>
          {/* filename comes from the server's Content-Disposition (sleeve slug) */}
          <a href={`/api/simulator/export.csv?account_id=${accountId}`} download className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-foreground">
            Export CSV
          </a>
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-4 space-y-4">
        {isLoading && <p className="text-xs text-muted-foreground">Loading review…</p>}
        {isError && <p className="text-xs text-destructive">Failed to load simulator review.</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 text-xs">
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Return</p><p className={`font-mono font-semibold ${data.total_return_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{data.total_return_pct >= 0 ? '+' : ''}{fmt(data.total_return_pct)}%</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Cash</p><p className="font-mono font-semibold">{fmt(data.cash_pct)}%</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Total value</p><p className="font-mono font-semibold">${fmt(data.total_value)}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Unrealized</p><p className={`font-mono font-semibold ${data.unrealized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{data.unrealized_pnl >= 0 ? '+' : ''}${fmt(data.unrealized_pnl)}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Realized</p><p className={`font-mono font-semibold ${data.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{data.realized_pnl >= 0 ? '+' : ''}${fmt(data.realized_pnl)}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Positions</p><p className="font-mono font-semibold">{data.position_count}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Largest</p><p className="font-mono font-semibold">{data.largest_position ? `${data.largest_position.symbol} ${fmt(data.largest_position.weight_pct, 1)}%` : '—'}</p></div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Position contribution</p>
                {data.positions.length === 0 ? <p className="text-xs text-muted-foreground">No open positions.</p> : (
                  <div className="space-y-1">
                    {data.positions.map((p) => (
                      <div key={p.symbol} className="flex items-center justify-between rounded-md border border-border/50 px-2 py-1 text-xs">
                        <span className="font-semibold">{p.symbol} <span className="text-muted-foreground font-normal">{fmt(p.weight_pct, 1)}%</span></span>
                        <span className={`font-mono ${p.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{p.pnl >= 0 ? '+' : ''}${fmt(p.pnl)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Buffett action log</p>
                {data.recent_buffett_actions.length === 0 ? <p className="text-xs text-muted-foreground">No noted Buffett simulator actions yet.</p> : (
                  <div className="space-y-1">
                    {data.recent_buffett_actions.map((a) => (
                      <div key={a.id} className="rounded-md border border-border/50 px-2 py-1 text-xs">
                        <p><span className="font-semibold">{a.date} {a.type.toUpperCase()} {a.symbol}</span> <span className="font-mono text-muted-foreground">${fmt(a.amount)}</span></p>
                        <p className="text-muted-foreground mt-0.5">{a.notes}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
