import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useMarketData } from './useMarketData'
import { useWatchlist, searchStocks } from './useWatchlist'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => ({ status: 'success', data: url.includes('/market/') ? {} : [] }),
  })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('quote refresh', () => {
  it('refreshes mounted market and watchlist queries periodically and manually', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => ({ market: useMarketData(), watchlist: useWatchlist() }), { wrapper })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetch).toHaveBeenCalledTimes(4)
    await act(async () => { await result.current.market.refetch(); await result.current.watchlist.refetch() })
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(result.current.market.dataUpdatedAt).toBeGreaterThan(0)
    client.clear()
  })

  it('reports provider search failures instead of an empty success result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response)
    await expect(searchStocks('AAPL')).rejects.toThrow('Unable to search stocks')
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'error', error: 'Search unavailable' }) } as Response)
    await expect(searchStocks('MSFT')).rejects.toThrow('Search unavailable')
  })
})
