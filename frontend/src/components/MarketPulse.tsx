import { useMarketData } from '@/hooks/useMarketData'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { MarketIndex } from '@/types'

/** Format a number as a compact price string (e.g. 5123.45) */
function formatPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Format a change percent with sign (e.g. +0.47%) */
function formatPercent(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}%`
}

interface IndexRowProps {
  index: MarketIndex
}

function IndexRow({ index }: IndexRowProps) {
  const isPositive = index.changePercent >= 0
  const percentLabel = formatPercent(index.changePercent)

  return (
    <div className="data-hover flex items-center justify-between rounded-md border border-transparent px-2 py-2">
      <div>
        <p className="font-semibold text-sm text-foreground">{index.name}</p>
        <p className="text-xs text-muted-foreground">{index.symbol}</p>
      </div>
      <div className="text-right">
        <p className="font-mono text-sm font-semibold">{formatPrice(index.price)}</p>
        <Badge
          variant={isPositive ? 'default' : 'destructive'}
          className="text-xs mt-0.5"
        >
          {percentLabel}
        </Badge>
      </div>
    </div>
  )
}

/** Ordered list of index symbols for consistent display order */
const INDEX_ORDER = ['^GSPC', '^DJI', '^IXIC']

/**
 * MarketPulse component — displays major market index prices with change percent badges.
 * Fetches live data from /api/market/indexes via useMarketData hook.
 */
export function MarketPulse() {
  const { data, isLoading, isError, error } = useMarketData()

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Market Pulse</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="text-muted-foreground text-sm">Loading market data...</p>
        )}

        {isError && (
          <p className="text-destructive text-sm">
            Failed to load market data.{' '}
            {error instanceof Error ? error.message : 'Unknown error.'}
          </p>
        )}

        {data && (
          <div className="space-y-1">
            {INDEX_ORDER.map((symbol) => {
              const index = data[symbol]
              if (!index) return null
              return <IndexRow key={symbol} index={index} />
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default MarketPulse
