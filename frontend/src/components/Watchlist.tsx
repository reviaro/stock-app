import { useEffect, useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MemoDrawer } from '@/components/MemoDrawer'
import { useMemosListQuery } from '@/hooks/useMemo'
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist, useSetWatchlistBucket, searchStocks } from '@/hooks/useWatchlist'
import { useEarningsDate } from '@/hooks/useMarketData'
import { useTodaySnapshotMap } from '@/hooks/useHistory'
import { useAnalysisWorker } from '@/hooks/useAnalysisWorker'
import { useTickerStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { BUCKETS, BUCKET_LABELS, type Bucket, type WatchlistEntry, type StockSearchResult } from '@/types'
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

function SnapshotCell({ label, value }: { label: string; value?: { price: number; captured_at: string } }) {
  return (
    <div className="data-hover min-w-[72px] rounded-md border border-border/70 bg-background/70 px-2 py-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-[11px] text-foreground">{value ? `$${formatPrice(value.price)}` : '—'}</p>
    </div>
  )
}

interface WatchlistRowProps {
  entry: WatchlistEntry
  isSelected: boolean
  onSelect: (symbol: string) => void
  onRemove: (symbol: string) => void
  onMemo: (symbol: string) => void
  onBucketChange: (symbol: string, bucket: Bucket) => void
  hasMemo: boolean
  isMemoStale: boolean
  isRemoving: boolean
  displayMode: SortField
  snapshots?: Partial<Record<'openish' | 'midday' | 'closeish' | 'manual-open', { price: number; captured_at: string }>>
}

function WatchlistRow({ entry, isSelected, onSelect, onRemove, onMemo, onBucketChange, hasMemo, isMemoStale, isRemoving, displayMode, snapshots }: WatchlistRowProps) {
  const isPositive = (entry.changePercent ?? 0) >= 0
  const hasPriceData = entry.price !== undefined

  // Earnings date badge
  const { data: earningsData } = useEarningsDate(entry.symbol)
  const earningsDate = earningsData?.earningsDate ?? null
  const earningsDaysAway = earningsDate
    ? Math.ceil((new Date(earningsDate).getTime() - Date.now()) / 86_400_000)
    : null
  const showEarningsBadge = earningsDaysAway != null && earningsDaysAway >= 0 && earningsDaysAway <= 30

  // 52-week high proximity badge (within 5% is a CANSLIM buy signal)
  const pctFrom52High = entry.week52High && entry.price
    ? ((entry.price - entry.week52High) / entry.week52High) * 100
    : null
  const nearHigh = pctFrom52High != null && pctFrom52High >= -5

  // Volume surge badge (1.5x average = institutional buying signal)
  const isVolumeSurge = entry.volume != null && entry.avgVolume != null && entry.avgVolume > 0
    && (entry.volume / entry.avgVolume) >= 1.5

  /** Render the right-side value based on active display mode */
  function renderValue() {
    if (!hasPriceData) {
      return <p className="text-xs text-muted-foreground">No data</p>
    }

    switch (displayMode) {
      case 'changePercent':
        return (
          <Badge
            variant={isPositive ? 'default' : 'destructive'}
            className="text-sm px-2 py-0.5"
          >
            {formatPercent(entry.changePercent)}
          </Badge>
        )
      case 'price':
        return (
          <p className="font-mono text-sm font-semibold text-foreground">
            ${formatPrice(entry.price)}
          </p>
        )
      case 'symbol':
      default:
        return (
          <>
            <p className="font-mono text-sm font-semibold">${formatPrice(entry.price)}</p>
            <Badge
              variant={isPositive ? 'default' : 'destructive'}
              className="text-xs mt-0.5"
            >
              {formatPercent(entry.changePercent)}
            </Badge>
          </>
        )
    }
  }

  return (
    <motion.div
      className={[
        'group w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg',
        'data-hover text-left border border-transparent',
        isSelected ? 'bg-accent border-border ring-1 ring-primary' : '',
      ].join(' ')}
      whileTap={{ scale: 0.995, transition: { duration: 0.08 } }}
    >
      <button
        type="button"
        onClick={() => onSelect(entry.symbol)}
        className="flex-1 min-w-0"
        aria-pressed={isSelected}
        aria-label={`Select ${entry.symbol}`}
      >
        <div className="grid min-w-0 grid-cols-1 items-center gap-3 lg:grid-cols-[minmax(0,1.7fr)_auto_auto]">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="font-semibold text-sm text-foreground">{entry.symbol}</p>
              <span className="hidden text-[10px] uppercase tracking-wide text-muted-foreground sm:inline">
                {entry.sector ?? '—'}
              </span>
              {showEarningsBadge && earningsDaysAway != null && (
                <Badge variant="outline" className="text-[9px] py-0 px-1 text-amber-400 border-amber-400/40">
                  ER {earningsDaysAway === 0 ? 'today' : `in ${earningsDaysAway}d`}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-snug break-words sm:truncate sm:pr-4">
              {entry.name ?? entry.symbol}
            </p>
            {(nearHigh || isVolumeSurge) && (
              <div className="mt-1 flex items-center gap-1 flex-wrap">
                {nearHigh && pctFrom52High != null && (
                  <Badge variant="outline" className="text-[9px] py-0 px-1 text-green-400 border-green-400/40">
                    {pctFrom52High >= 0 ? 'NEW HIGH' : `${pctFrom52High.toFixed(1)}% 52w`}
                  </Badge>
                )}
                {isVolumeSurge && entry.volume != null && entry.avgVolume != null && (
                  <Badge variant="outline" className="text-[9px] py-0 px-1 text-blue-400 border-blue-400/40">
                    VOL {(entry.volume / entry.avgVolume).toFixed(1)}x
                  </Badge>
                )}
              </div>
            )}
          </div>

          <div className="hidden 2xl:flex items-center gap-1.5 shrink-0">
            <SnapshotCell label="Morning" value={snapshots?.openish} />
            <SnapshotCell label="Midday" value={snapshots?.midday} />
            <SnapshotCell label="Close" value={snapshots?.closeish} />
          </div>

          <div className="text-left sm:text-right shrink-0 min-w-[96px]">
            {renderValue()}
          </div>
        </div>
      </button>

      <select
        value={entry.bucket}
        onChange={(e) => onBucketChange(entry.symbol, e.target.value as Bucket)}
        onClick={(e) => e.stopPropagation()}
        className="text-[10px] px-1.5 py-1 rounded bg-secondary border border-border shrink-0"
      >
        {BUCKETS.map(b => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
      </select>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onMemo(entry.symbol) }}
        title={hasMemo ? 'Edit research memo' : 'Add research memo'}
        className={[
          'data-hover relative z-10 text-[10px] px-2 py-1 rounded border shrink-0 transition-colors',
          hasMemo ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground hover:border-primary',
          isMemoStale ? 'ring-1 ring-amber-500/60' : '',
        ].join(' ')}
      >
        📝 Memo
      </button>
      {/* Delete button — visible on hover */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(entry.symbol) }}
        disabled={isRemoving}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded shrink-0"
        aria-label={`Remove ${entry.symbol} from watchlist`}
        title="Remove from watchlist"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </motion.div>
  )
}

const SORT_OPTIONS: { label: string; field: SortField; direction: SortDirection }[] = [
  { label: '% Change', field: 'changePercent', direction: 'desc' },
  { label: 'Price', field: 'price', direction: 'desc' },
  { label: 'Symbol', field: 'symbol', direction: 'asc' },
]

/**
 * AddStockSearch — inline search input with dropdown results.
 * Searches /api/watchlist/search/:query and calls POST /api/watchlist on selection.
 */
function AddStockSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StockSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const addMutation = useAddToWatchlist()
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      return
    }
    setIsSearching(true)
    debounceRef.current = setTimeout(async () => {
      const data = await searchStocks(query)
      setResults(data)
      setIsSearching(false)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const handleAdd = async (symbol: string) => {
    try {
      await addMutation.mutateAsync(symbol)
      onClose()
    } catch {
      // error shown via mutation state
    }
  }

  const triggerSearch = async () => {
    if (!query.trim()) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setIsSearching(true)
    const data = await searchStocks(query)
    setResults(data)
    setIsSearching(false)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="relative z-50 mb-2"
    >
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by symbol or name…"
            className="w-full pl-3 pr-8 py-1.5 rounded-md bg-secondary text-foreground text-sm border border-border focus:border-primary focus:outline-none transition-colors placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'Enter') {
                e.preventDefault()
                void triggerSearch()
              }
            }}
          />
          {/* Search icon button */}
          <button
            type="button"
            onClick={() => void triggerSearch()}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
            aria-label="Search"
            title="Search"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
          aria-label="Cancel search"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Search results dropdown */}
      {query.trim() && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-md border border-border bg-card shadow-lg max-h-48 overflow-y-auto">
          {isSearching && (
            <p className="text-xs text-muted-foreground px-3 py-2">Searching…</p>
          )}
          {!isSearching && results.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-2">No results found</p>
          )}
          {results.map((stock) => (
            <button
              key={stock.symbol}
              type="button"
              onClick={() => handleAdd(stock.symbol)}
              disabled={addMutation.isPending}
              className="data-hover w-full flex items-center justify-between rounded-md border border-transparent px-3 py-2 text-left text-sm"
            >
              <div>
                <span className="font-semibold text-foreground">{stock.symbol}</span>
                <span className="text-muted-foreground ml-2 text-xs">{stock.name}</span>
              </div>
              <span className="text-xs text-primary font-medium">+ Add</span>
            </button>
          ))}
        </div>
      )}
      {/* Error message */}
      {addMutation.isError && (
        <p className="text-xs text-destructive mt-1">
          {addMutation.error instanceof Error ? addMutation.error.message : 'Failed to add stock'}
        </p>
      )}
    </motion.div>
  )
}

/**
 * Watchlist component — displays saved stocks with live price data.
 * Sorting is offloaded to a Web Worker via the useAnalysisWorker hook.
 * Includes add-stock search and per-row delete functionality.
 */
export function Watchlist() {
  const [memoSymbol, setMemoSymbol] = useState<string | null>(null)
  const { data: memos } = useMemosListQuery()
  const memoMap = new Map((memos ?? []).map(m => [m.symbol, m]))

  function isStale(m: { last_reviewed_at: string | null } | undefined) {
    if (!m || !m.last_reviewed_at) return false
    return Date.now() - new Date(m.last_reviewed_at).getTime() > 30 * 86400000
  }

  const { data, isLoading, isError, error } = useWatchlist()
  const { data: snapshotMap } = useTodaySnapshotMap()
  const selectedTicker = useTickerStore((s) => s.selectedTicker)
  const setSelectedTicker = useTickerStore((s) => s.setSelectedTicker)
  const removeMutation = useRemoveFromWatchlist()
  const setBucket = useSetWatchlistBucket()

  const [bucketFilter, setBucketFilter] = useState<Bucket | 'all'>('all')

  const bucketCounts: Record<string, number> = { all: data?.length ?? 0 }
  for (const b of BUCKETS) bucketCounts[b] = 0
  for (const row of data ?? []) bucketCounts[row.bucket] = (bucketCounts[row.bucket] ?? 0) + 1

  const filteredData = bucketFilter === 'all' ? (data ?? []) : (data ?? []).filter(r => r.bucket === bucketFilter)

  const { workerApi } = useAnalysisWorker()
  const [sortedData, setSortedData] = useState<WatchlistEntry[]>([])
  const [activeSortIdx, setActiveSortIdx] = useState(0)
  const [showAddSearch, setShowAddSearch] = useState(false)

  /** Main-thread fallback sort when the web worker isn't available */
  const sortLocal = useCallback(
    (entries: WatchlistEntry[], sortIdx: number): WatchlistEntry[] => {
      const option = SORT_OPTIONS[sortIdx]
      const sorted = [...entries]
      sorted.sort((a, b) => {
        const field = option.field
        let aVal: string | number | undefined
        let bVal: string | number | undefined

        if (field === 'symbol') {
          aVal = a.symbol
          bVal = b.symbol
        } else if (field === 'price') {
          aVal = a.price ?? 0
          bVal = b.price ?? 0
        } else if (field === 'changePercent') {
          aVal = a.changePercent ?? 0
          bVal = b.changePercent ?? 0
        }

        if (aVal === undefined) aVal = 0
        if (bVal === undefined) bVal = 0

        let cmp: number
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          cmp = aVal.localeCompare(bVal)
        } else {
          cmp = (aVal as number) - (bVal as number)
        }

        return option.direction === 'desc' ? -cmp : cmp
      })
      return sorted
    },
    []
  )

  const runSort = useCallback(
    async (entries: WatchlistEntry[], sortIdx: number) => {
      if (!entries.length) {
        setSortedData(entries)
        return
      }
      // Try worker first, fall back to main-thread sort
      if (workerApi) {
        const option = SORT_OPTIONS[sortIdx]
        const criteria: SortCriteria[] = [
          { field: option.field, direction: option.direction },
          { field: 'symbol', direction: 'asc' },
        ]
        try {
          const result = await workerApi.sortEntries(entries, criteria)
          setSortedData(result)
          return
        } catch {
          // Worker failed — fall through to local sort
        }
      }
      // Fallback: sort on main thread
      setSortedData(sortLocal(entries, sortIdx))
    },
    [workerApi, sortLocal]
  )

  useEffect(() => {
    if (!filteredData.length) {
      setSortedData([])
      // Don't return here if data exists but filtered is empty, 
      // otherwise sortedData won't clear when switching buckets
    }
    void runSort(filteredData, activeSortIdx)
  }, [filteredData, activeSortIdx, runSort])

  const handleRemove = async (symbol: string) => {
    try {
      await removeMutation.mutateAsync(symbol)
    } catch {
      // Error state available via removeMutation
    }
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Watchlist</CardTitle>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            {/* CSV export link */}
            <a
              href="/api/watchlist/export/csv"
              download="watchlist.csv"
              className="data-hover text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-foreground"
              title="Export watchlist to CSV"
            >
              CSV
            </a>
            {/* Add stock button */}
            <button
              type="button"
              onClick={() => setShowAddSearch((v) => !v)}
              className={[
                'data-hover text-xs px-2 py-0.5 rounded-md border',
                showAddSearch
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-transparent text-muted-foreground border-border hover:border-primary hover:text-foreground',
              ].join(' ')}
              aria-label="Add stock to watchlist"
              title="Add stock"
            >
              + Add
            </button>
            {/* Sort controls */}
            {sortedData.length > 1 &&
              SORT_OPTIONS.map((opt, idx) => (
                <button
                  key={opt.field}
                  type="button"
                  onClick={() => setActiveSortIdx(idx)}
                  className={[
                    'data-hover text-xs px-2 py-0.5 rounded-md border',
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
        </div>
      </CardHeader>
      <CardContent className="px-3 flex-1 overflow-y-auto min-h-0 pb-4">
        <div className="flex flex-wrap gap-1 mb-3">
          {(['all', ...BUCKETS] as const).map(b => {
            const count = bucketCounts[b] ?? 0
            const active = bucketFilter === b
            return (
              <button key={b}
                onClick={() => setBucketFilter(b)}
                className={[
                  'data-hover text-[10px] px-2 py-0.5 rounded-full border',
                  active ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-primary',
                ].join(' ')}
              >
                {b === 'all' ? 'All' : BUCKET_LABELS[b as Bucket]} ({count})
              </button>
            )
          })}
        </div>

        {/* Add stock search bar */}
        <AnimatePresence>
          {showAddSearch && (
            <AddStockSearch onClose={() => setShowAddSearch(false)} />
          )}
        </AnimatePresence>

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
            Your watchlist is empty. Click "+ Add" to get started.
          </p>
        )}

        {sortedData.length > 0 && (
          <div className="flex flex-col gap-1">
            <AnimatePresence initial={false}>
              {sortedData.map((entry, i) => (
                <motion.div
                  key={entry.symbol}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0, transition: { delay: i * 0.04, duration: 0.25 } }}
                  exit={{ opacity: 0, x: 12, transition: { duration: 0.15 } }}
                  layout
                >
                  <WatchlistRow
                    entry={entry}
                    isSelected={selectedTicker === entry.symbol}
                    onSelect={setSelectedTicker}
                    onRemove={handleRemove}
                    onMemo={setMemoSymbol}
                    onBucketChange={(symbol, bucket) => setBucket.mutate({ symbol, bucket })}
                    hasMemo={memoMap.has(entry.symbol)}
                    isMemoStale={isStale(memoMap.get(entry.symbol))}
                    isRemoving={removeMutation.isPending}
                    displayMode={SORT_OPTIONS[activeSortIdx].field}
                    snapshots={snapshotMap?.get(entry.symbol)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </CardContent>
      <MemoDrawer symbol={memoSymbol} open={!!memoSymbol} onOpenChange={(o) => { if (!o) setMemoSymbol(null) }} />
    </Card>
  )
}

export default Watchlist
