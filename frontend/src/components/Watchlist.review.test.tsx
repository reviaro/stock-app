import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Watchlist } from './Watchlist'

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}))

const mocks = vi.hoisted(() => ({
  searchStocks: vi.fn(),
  workerApi: null as null | { sortEntries: ReturnType<typeof vi.fn> },
  memos: [] as Array<{ symbol: string; last_reviewed_at: string | null }>,
  earningsDate: null as string | null,
  watchlist: [
    { symbol: 'AAPL', name: 'Apple', bucket: 'compounders', price: 100, changePercent: 1 },
    { symbol: 'GME', name: 'GameStop', bucket: 'speculative', price: 20, changePercent: -1 },
  ],
  setSelectedTicker: vi.fn(),
}))

const defaultWatchlist = () => [
  { symbol: 'AAPL', name: 'Apple', bucket: 'compounders', price: 100, changePercent: 1 },
  { symbol: 'GME', name: 'GameStop', bucket: 'speculative', price: 20, changePercent: -1 },
]

vi.mock('@/hooks/useMarketData', () => ({
  useEarningsDate: (symbol: string | null) => ({ data: symbol && mocks.earningsDate ? { earningsDate: mocks.earningsDate } : null }),
}))
vi.mock('@/hooks/useMemo', () => ({
  useMemosListQuery: () => ({ data: mocks.memos }),
}))
vi.mock('@/hooks/useHistory', () => ({
  useTodaySnapshotMap: () => ({ data: new Map() }),
}))
vi.mock('@/hooks/useAnalysisWorker', () => ({
  useAnalysisWorker: () => ({ workerApi: mocks.workerApi }),
}))
vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({
    data: mocks.watchlist,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useAddToWatchlist: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
  useRemoveFromWatchlist: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetWatchlistBucket: () => ({ mutate: vi.fn() }),
  searchStocks: mocks.searchStocks,
}))
vi.mock('@/lib/store', () => ({
  useTickerStore: (selector: (state: { selectedTicker: string; setSelectedTicker: () => void }) => unknown) =>
    selector({ selectedTicker: 'AAPL', setSelectedTicker: mocks.setSelectedTicker }),
}))
vi.mock('@/components/MemoDrawer', () => ({ MemoDrawer: () => null }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function openSearch() {
  fireEvent.click(screen.getByRole('button', { name: 'Add stock to watchlist' }))
  return screen.getByPlaceholderText('Search by symbol or name…')
}

describe('Watchlist review regressions', () => {
  beforeEach(() => {
    mocks.searchStocks.mockReset()
    mocks.workerApi = null
    mocks.memos = []
    mocks.earningsDate = null
    mocks.watchlist = defaultWatchlist()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores an older debounced search response after a newer response wins', async () => {
    const older = deferred<Array<{ symbol: string; name: string }>>()
    const newer = deferred<Array<{ symbol: string; name: string }>>()
    mocks.searchStocks.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)

    render(<Watchlist />)
    const input = await openSearch()
    fireEvent.change(input, { target: { value: 'app' } })
    await waitFor(() => expect(mocks.searchStocks).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'micro' } })
    await waitFor(() => expect(mocks.searchStocks).toHaveBeenCalledTimes(2))

    newer.resolve([{ symbol: 'MSFT', name: 'Microsoft' }])
    expect(await screen.findByText('MSFT')).toBeInTheDocument()

    older.resolve([{ symbol: 'AAPL-OLD', name: 'Old Apple result' }])
    await act(async () => {})
    expect(screen.getByText('MSFT')).toBeInTheDocument()
    expect(screen.queryByText('AAPL-OLD')).not.toBeInTheDocument()
  })

  it('keeps manual searches race-safe and clears loading when the latest request rejects', async () => {
    const older = deferred<Array<{ symbol: string; name: string }>>()
    const latest = deferred<Array<{ symbol: string; name: string }>>()
    mocks.searchStocks.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)

    render(<Watchlist />)
    const input = await openSearch()
    fireEvent.change(input, { target: { value: 'old' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'latest' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    latest.reject(new Error('network down'))
    await waitFor(() => expect(screen.queryByText('Searching…')).not.toBeInTheDocument())

    await act(async () => { older.resolve([{ symbol: 'STALE', name: 'Stale result' }]) })
    expect(screen.queryByText('STALE')).not.toBeInTheDocument()
    expect(screen.getByText('No results found')).toBeInTheDocument()
  })

  it('never renders rows from the prior bucket while the new bucket sort is pending', async () => {
    const initialSort = deferred<typeof mocks.watchlist>()
    const bucketSort = deferred<typeof mocks.watchlist>()
    const sortEntries = vi.fn()
      .mockReturnValueOnce(initialSort.promise)
      .mockReturnValueOnce(bucketSort.promise)
    mocks.workerApi = { sortEntries }

    render(<Watchlist />)
    initialSort.resolve(mocks.watchlist)
    expect(await screen.findByText('GME')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Compounders (1)' }))

    expect(screen.queryByText('GME')).not.toBeInTheDocument()
    expect(screen.getByText('AAPL')).toBeInTheDocument()
    expect(sortEntries).toHaveBeenCalledTimes(2)
  })

  it('renders refreshed row data while the worker sort for the same symbols is pending', async () => {
    const initialSort = deferred<typeof mocks.watchlist>()
    const refreshSort = deferred<typeof mocks.watchlist>()
    mocks.workerApi = {
      sortEntries: vi.fn()
        .mockReturnValueOnce(initialSort.promise)
        .mockReturnValueOnce(refreshSort.promise),
    }

    const view = render(<Watchlist />)
    initialSort.resolve(mocks.watchlist.map((entry) => ({ ...entry })))
    expect(await screen.findByText('Apple')).toBeInTheDocument()

    mocks.watchlist = mocks.watchlist.map((entry) =>
      entry.symbol === 'AAPL' ? { ...entry, name: 'Apple refreshed', price: 125 } : entry
    )
    view.rerender(<Watchlist />)

    expect(screen.getByText('Apple refreshed')).toBeInTheDocument()
    expect(screen.queryByText('Apple')).not.toBeInTheDocument()
  })

  it('uses the symbol tie-breaker immediately when the active sort changes', async () => {
    mocks.watchlist = [
      { symbol: 'GME', name: 'GameStop', bucket: 'speculative', price: 100, changePercent: 1 },
      { symbol: 'AAPL', name: 'Apple', bucket: 'compounders', price: 100, changePercent: 1 },
    ]
    const initialSort = deferred<typeof mocks.watchlist>()
    const priceSort = deferred<typeof mocks.watchlist>()
    mocks.workerApi = {
      sortEntries: vi.fn()
        .mockReturnValueOnce(initialSort.promise)
        .mockReturnValueOnce(priceSort.promise),
    }

    render(<Watchlist />)
    initialSort.resolve([...mocks.watchlist])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Price' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Price' }))

    const rowOrder = screen.getAllByRole('button', { name: /^Select / }).map((button) => button.getAttribute('aria-label'))
    expect(rowOrder).toEqual(['Select AAPL', 'Select GME'])
  })

  it('advances time-sensitive earnings state while the watchlist remains mounted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    mocks.earningsDate = '2026-02-01T00:00:00Z'

    render(<Watchlist />)
    expect(screen.queryByText(/ER in/)).not.toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(86_460_000) })

    expect(screen.getByText('ER in 30d')).toBeInTheDocument()
  })
})
