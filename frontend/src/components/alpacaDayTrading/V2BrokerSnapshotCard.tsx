import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useV2Snapshot } from '@/hooks/useAlpacaDayTradingV2'
import { price, time, usd } from './v2Format'

export function V2BrokerSnapshotCard() {
  const { data, isLoading, isError } = useV2Snapshot()
  return (
    <section aria-label="Broker snapshot">
      <Card>
        <CardHeader className="pb-2"><CardTitle><h2>Broker snapshot</h2></CardTitle></CardHeader>
        <CardContent className="space-y-3 px-3 pb-4 text-sm">
          {isLoading && <p className="text-xs text-muted-foreground">Loading broker snapshot…</p>}
          {isError && <p className="text-xs text-destructive">The broker snapshot is unavailable.</p>}
          {data && (
            <>
              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div><dt className="text-muted-foreground">Cash</dt><dd className="font-mono">{usd(data.account.cash)}</dd></div>
                <div><dt className="text-muted-foreground">Equity</dt><dd className="font-mono">{usd(data.account.equity)}</dd></div>
                <div><dt className="text-muted-foreground">Account</dt><dd className="font-mono">{data.account.status ?? '—'}</dd></div>
                <div><dt className="text-muted-foreground">Market</dt><dd className="font-mono">{data.clock.isOpen ? `Open · closes ${time(data.clock.nextClose)}` : `Closed · opens ${time(data.clock.nextOpen)}`}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">Sizing uses cash only (never margin buying power), net of working buy orders.</p>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Open orders ({data.openOrders.length})</p>
                {data.openOrders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No open broker orders.</p>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead className="bg-secondary/60 text-muted-foreground">
                        <tr><th className="px-2 py-1.5 text-left">Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Limit</th><th>Stop</th><th>Status</th><th>Owner</th></tr>
                      </thead>
                      <tbody>
                        {data.openOrders.map((order, index) => (
                          <tr key={`${order.symbol}-${order.type}-${index}`} className="border-t border-border/60 text-center">
                            <td className="px-2 py-1.5 text-left font-medium">{order.symbol}</td>
                            <td>{order.side}</td><td>{order.type ?? '—'}</td><td>{order.qty ?? '—'}</td>
                            <td>{price(order.limitPrice)}</td><td>{price(order.stopPrice)}</td><td>{order.status ?? '—'}</td>
                            <td>{order.planOwned ? <Badge variant="outline">v2 plan</Badge> : <Badge variant="destructive">Unexpected</Badge>}</td>
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
    </section>
  )
}
