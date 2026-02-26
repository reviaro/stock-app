import { useWatchlist } from '@/hooks/useWatchlist'
import { useTickerStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { WatchlistEntry } from '@/types'

/** Format a change percent with sign (e.g. +0.47%) */
function formatPercent(n: number | undefined): string {
  if (n === undefined || n === null) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}%`
}

/** Format price to 2 decimal places */
function formatPrice(n: number | undefined): string {
  if (n === undefined || n === null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

interface WatchlistRowProps {
  entry: WatchlistEntry
  isSelected: boolean
  onSelect: (symbol: string) => void
}

function WatchlistRow({ entry, isSelected, onSelect }: WatchlistRowProps) {
  const isPositive = (entry.changePercent ?? 0) >= 0
  const hasPriceData = entry.price !== undefined

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.symbol)}
      className={[
        'w-full flex items-center justify-between px-3 py-2 rounded-lg',
        'text-left transition-colors duration-150 border border-transparent',
        'hover:bg-accent hover:border-border',
        isSelected ? 'bg-accent border-border ring-1 ring-primary' : '',
      ].join(' ')}
      aria-pressed={isSelected}
      aria-label={`Select ${entry.symbol}`}
    >
      <div>
        <p className="font-semibold text-sm text-foreground">{entry.symbol}</p>
        <p className="text-xs text-muted-foreground truncate max-w-[120px]">
          {entry.name ?? entry.symbol}
        </p>
      </div>
      <div className="text-right shrink-0 ml-2">
        {hasPriceData ? (
          <>
            <p className="font-mono text-sm font-semibold">${formatPrice(entry.price)}</p>
            <Badge
              variant={isPositive ? 'default' : 'destructive'}
              className="text-xs mt-0.5"
            >
              {formatPercent(entry.changePercent)}
            </Badge>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No data</p>
        )}
      </div>
    </button>
  )
}

/**
 * Watchlist component — displays saved stocks with live price data.
 * Clicking a stock calls setSelectedTicker to update global state.
 */
export function Watchlist() {
  const { data, isLoading, isError, error } = useWatchlist()
  const selectedTicker = useTickerStore((s) => s.selectedTicker)
  const setSelectedTicker = useTickerStore((s) => s.setSelectedTicker)

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Watchlist</CardTitle>
      </CardHeader>
      <CardContent className="px-3">
        {isLoading && (
          <p className="text-muted-foreground text-sm px-3">Loading watchlist...</p>
        )}

        {isError && (
          <p className="text-destructive text-sm px-3">
            Failed to load watchlist.{' '}
            {error instanceof Error ? error.message : 'Unknown error.'}
          </p>
        )}

        {data && data.length === 0 && (
          <p className="text-muted-foreground text-sm px-3">
            Your watchlist is empty. Add stocks to get started.
          </p>
        )}

        {data && data.length > 0 && (
          <div className="flex flex-col gap-1">
            {data.map((entry) => (
              <WatchlistRow
                key={entry.symbol}
                entry={entry}
                isSelected={selectedTicker === entry.symbol}
                onSelect={setSelectedTicker}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default Watchlist
