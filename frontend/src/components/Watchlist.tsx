import { useEffect, useState, useCallback } from 'react'
import { useWatchlist } from '@/hooks/useWatchlist'
import { useAnalysisWorker } from '@/hooks/useAnalysisWorker'
import { useTickerStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { WatchlistEntry } from '@/types'
import type { SortCriteria, SortField, SortDirection } from '../workers/analysis.worker.ts'

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

const SORT_OPTIONS: { label: string; field: SortField; direction: SortDirection }[] = [
  { label: '% Change', field: 'changePercent', direction: 'desc' },
  { label: 'Price', field: 'price', direction: 'desc' },
  { label: 'Symbol', field: 'symbol', direction: 'asc' },
]

/**
 * Watchlist component — displays saved stocks with live price data.
 * Sorting is offloaded to a Web Worker via the useAnalysisWorker hook to
 * keep the main thread free from heavy computation on large datasets.
 * Clicking a stock calls setSelectedTicker to update global state.
 */
export function Watchlist() {
  const { data, isLoading, isError, error } = useWatchlist()
  const selectedTicker = useTickerStore((s) => s.selectedTicker)
  const setSelectedTicker = useTickerStore((s) => s.setSelectedTicker)

  const { workerApi, isReady } = useAnalysisWorker()
  const [sortedData, setSortedData] = useState<WatchlistEntry[]>([])
  const [activeSortIdx, setActiveSortIdx] = useState(0)

  /**
   * Re-sort whenever the raw data or the active sort option changes.
   * The sort runs asynchronously on the worker thread — no main-thread blocking.
   */
  const runSort = useCallback(
    async (entries: WatchlistEntry[], sortIdx: number) => {
      if (!workerApi || !entries.length) {
        setSortedData(entries)
        return
      }
      const option = SORT_OPTIONS[sortIdx]
      const criteria: SortCriteria[] = [
        { field: option.field, direction: option.direction },
        // Secondary tiebreak: alphabetical by symbol
        { field: 'symbol', direction: 'asc' },
      ]
      try {
        const result = await workerApi.sortEntries(entries, criteria)
        setSortedData(result)
      } catch {
        // Fallback to unsorted if worker fails
        setSortedData(entries)
      }
    },
    [workerApi]
  )

  useEffect(() => {
    if (!data) {
      setSortedData([])
      return
    }
    if (isReady) {
      void runSort(data, activeSortIdx)
    } else {
      // Worker not yet initialised — show data unsorted while it loads
      setSortedData(data)
    }
  }, [data, activeSortIdx, isReady, runSort])

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Watchlist</CardTitle>
          {/* Sort controls — only show when there is data to sort */}
          {sortedData.length > 1 && (
            <div className="flex gap-1 flex-wrap justify-end">
              {SORT_OPTIONS.map((opt, idx) => (
                <button
                  key={opt.field}
                  type="button"
                  onClick={() => setActiveSortIdx(idx)}
                  className={[
                    'text-xs px-2 py-0.5 rounded-md border transition-colors',
                    idx === activeSortIdx
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-transparent text-muted-foreground border-border hover:border-primary hover:text-foreground',
                  ].join(' ')}
                  aria-pressed={idx === activeSortIdx}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
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

        {!isLoading && !isError && sortedData.length === 0 && (
          <p className="text-muted-foreground text-sm px-3">
            Your watchlist is empty. Add stocks to get started.
          </p>
        )}

        {sortedData.length > 0 && (
          <div className="flex flex-col gap-1">
            {sortedData.map((entry) => (
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
