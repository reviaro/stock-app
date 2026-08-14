import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Watchlist } from './Watchlist'

const { watchlistData, setSelectedTicker } = vi.hoisted(() => ({
  watchlistData: [
    { symbol: 'AAPL', name: 'Apple', bucket: 'unsorted', price: 100, changePercent: 1 },
    { symbol: 'MSFT', name: 'Microsoft', bucket: 'unsorted', price: 200, changePercent: 2 },
  ],
  setSelectedTicker: vi.fn(),
}))
const earningsSpy = vi.fn((symbol: string | null) => {
  void symbol
  return { data: null }
})

vi.mock('@/hooks/useMarketData', () => ({
  useEarningsDate: (symbol: string | null) => earningsSpy(symbol),
}))
vi.mock('@/hooks/useMemo', () => ({
  useMemosListQuery: () => ({ data: [] }),
}))
vi.mock('@/hooks/useHistory', () => ({
  useTodaySnapshotMap: () => ({ data: new Map() }),
}))
vi.mock('@/hooks/useAnalysisWorker', () => ({
  useAnalysisWorker: () => ({ workerApi: null }),
}))
vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({
    data: watchlistData,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useAddToWatchlist: () => ({ mutateAsync: vi.fn() }),
  useRemoveFromWatchlist: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetWatchlistBucket: () => ({ mutate: vi.fn() }),
  searchStocks: vi.fn(),
}))
vi.mock('@/lib/store', () => ({
  useTickerStore: (selector: (state: { selectedTicker: string; setSelectedTicker: () => void }) => unknown) =>
    selector({ selectedTicker: 'AAPL', setSelectedTicker }),
}))
vi.mock('@/components/MemoDrawer', () => ({ MemoDrawer: () => null }))

describe('Watchlist market-data loading', () => {
  it('loads earnings only for the selected ticker instead of every row', async () => {
    earningsSpy.mockClear()
    render(<Watchlist />)

    await waitFor(() => expect(earningsSpy).toHaveBeenCalledTimes(2))
    expect(earningsSpy).toHaveBeenCalledWith('AAPL')
    expect(earningsSpy).toHaveBeenCalledWith(null)
    expect(earningsSpy).not.toHaveBeenCalledWith('MSFT')
  })
})
