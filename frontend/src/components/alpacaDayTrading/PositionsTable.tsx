import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAlpacaDayTradingSnapshot } from '@/hooks/useAlpacaDayTrading'

function usd(value?: string | null) {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value))
}

export function PositionsTable() {
  const { data, isLoading, isError } = useAlpacaDayTradingSnapshot()
  const positions = data?.positions ?? []

  return (
    <Card aria-label="Alpaca Day Trading broker positions">
      <CardHeader className="pb-2"><CardTitle><h2>Broker positions ({positions.length})</h2></CardTitle></CardHeader>
      <CardContent className="px-3 pb-4">
        {isLoading && <p className="text-xs text-muted-foreground">Loading positions…</p>}
        {isError && <p className="text-xs text-destructive">Unable to load broker positions.</p>}
        {data && positions.length === 0 && <p className="text-xs text-muted-foreground">No open Alpaca positions.</p>}
        {data && positions.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">Symbol</th>
                  <th>Qty</th>
                  <th>Avg entry</th>
                  <th>Current</th>
                  <th>Market value</th>
                  <th>Unrealized P&amp;L</th>
                  <th>Managed by</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const pnl = Number(position.unrealizedPnl)
                  return (
                    <tr key={position.symbol} className="border-t border-border/60">
                      <td className="px-2 py-1.5 font-medium">{position.symbol}</td>
                      <td className="text-center font-mono">{position.qty}</td>
                      <td className="text-center font-mono">{usd(position.avgEntryPrice)}</td>
                      <td className="text-center font-mono">{usd(position.currentPrice)}</td>
                      <td className="text-center font-mono">{usd(position.marketValue)}</td>
                      <td className={`text-center font-mono ${Number.isFinite(pnl) && pnl < 0 ? 'text-destructive' : Number.isFinite(pnl) && pnl > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{usd(position.unrealizedPnl)}</td>
                      <td className="text-center">
                        {position.tracked
                          ? <Badge variant="outline">plan #{position.planId}</Badge>
                          : <Badge variant="destructive">untracked</Badge>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
