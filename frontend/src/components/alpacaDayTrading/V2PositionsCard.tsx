import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useV2Snapshot } from '@/hooks/useAlpacaDayTradingV2'
import { price, usd } from './v2Format'

export function V2PositionsCard() {
  const { data, isLoading, isError } = useV2Snapshot()
  const positions = data?.positions ?? []
  return (
    <section aria-label="Current positions">
      <Card>
        <CardHeader className="pb-2"><CardTitle><h2>Current positions ({positions.length})</h2></CardTitle></CardHeader>
        <CardContent className="px-3 pb-4">
          {isLoading && <p className="text-xs text-muted-foreground">Loading positions…</p>}
          {isError && <p className="text-xs text-destructive">Broker positions are unavailable.</p>}
          {data && positions.length === 0 && <p className="text-xs text-muted-foreground">Flat — no open positions.</p>}
          {positions.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="bg-secondary/60 text-muted-foreground">
                  <tr><th className="px-2 py-1.5 text-left">Symbol</th><th>Qty</th><th>Avg entry</th><th>Current</th><th>Value</th><th>Unrealized</th><th>Plan</th></tr>
                </thead>
                <tbody>
                  {positions.map((position) => (
                    <tr key={position.symbol} className="border-t border-border/60 text-center">
                      <td className="px-2 py-1.5 text-left font-medium">{position.symbol}</td>
                      <td>{position.side === 'short' ? `−${position.qty}` : position.qty}</td>
                      <td>{price(position.avgEntryPrice)}</td><td>{price(position.currentPrice)}</td><td>{usd(position.marketValue)}</td>
                      <td className={(position.unrealizedPnl ?? 0) < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-300'}>{usd(position.unrealizedPnl)}</td>
                      <td>{position.planId != null ? <Badge variant="outline">{`Plan #${position.planId}`}</Badge> : <Badge variant="destructive">Untracked</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
