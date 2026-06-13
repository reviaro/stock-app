import { useSimHoldings } from '@/hooks/useSimulator'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { SimHolding } from '@/types/simulator'

interface Props {
  onSell: (holding: SimHolding) => void
}

function fmt(n: number | null, d = 2) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function holdingPeriodLabel(oldestLotDate: string | null) {
  if (!oldestLotDate) return '—'
  const days = Math.floor((Date.now() - new Date(oldestLotDate).getTime()) / (1000 * 60 * 60 * 24))
  if (days >= 365) return `${Math.floor(days / 365)}y ${days % 365}d`
  return `${days}d`
}

export function HoldingsPanel({ onSell }: Props) {
  const { data: holdings, isLoading, isError } = useSimHoldings()

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle>Simulated Holdings</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto min-h-0 px-3 pb-3">
        {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {isError && <p className="text-xs text-destructive">Failed to load holdings.</p>}
        {!isLoading && holdings?.length === 0 && (
          <p className="text-xs text-muted-foreground">No open positions. Buy something to get started.</p>
        )}
        {holdings && holdings.length > 0 && (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-1 pr-2">Symbol</th>
                <th className="text-right py-1 pr-2">Shares</th>
                <th className="text-right py-1 pr-2">Avg Cost</th>
                <th className="text-right py-1 pr-2">Price</th>
                <th className="text-right py-1 pr-2">Value</th>
                <th className="text-right py-1 pr-2">P&L</th>
                <th className="text-right py-1 pr-2">P&L%</th>
                <th className="text-right py-1 pr-2">Held</th>
                <th className="text-right py-1"></th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.symbol} className="data-hover border-b border-border/50">
                  <td className="py-1 pr-2 font-semibold">{h.symbol}</td>
                  <td className="font-mono text-right py-1 pr-2">{fmt(h.shares)}</td>
                  <td className="font-mono text-right py-1 pr-2">${fmt(h.avg_cost)}</td>
                  <td className="font-mono text-right py-1 pr-2">{h.currentPrice != null ? `$${fmt(h.currentPrice)}` : '—'}</td>
                  <td className="font-mono text-right py-1 pr-2">{h.currentValue != null ? `$${fmt(h.currentValue)}` : '—'}</td>
                  <td className={`font-mono text-right py-1 pr-2 ${h.pnl != null && h.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {h.pnl != null ? `${h.pnl >= 0 ? '+' : ''}$${fmt(h.pnl)}` : '—'}
                  </td>
                  <td className={`font-mono text-right py-1 pr-2 ${h.pnlPct != null && h.pnlPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {h.pnlPct != null ? `${h.pnlPct >= 0 ? '+' : ''}${fmt(h.pnlPct)}%` : '—'}
                  </td>
                  <td className="text-right py-1 pr-2 text-muted-foreground">{holdingPeriodLabel(h.oldest_lot_date)}</td>
                  <td className="text-right py-1">
                    <button
                      type="button"
                      onClick={() => onSell(h)}
                      className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive"
                    >
                      Sell
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
