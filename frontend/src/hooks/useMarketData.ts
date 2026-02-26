import { useQuery } from '@tanstack/react-query'
import type { ApiResponse, MarketIndex } from '@/types'

/**
 * Fetches major market index prices from /api/market/indexes.
 * The response data is a record keyed by index symbol (e.g. "^GSPC", "^IXIC", "^DJI").
 *
 * NOTE: The plan specified /api/market but the actual backend route is
 * /api/market/indexes (market.js router registers GET /indexes, mounted at /api/market).
 */
async function fetchMarketData(): Promise<Record<string, MarketIndex>> {
  const response = await fetch('/api/market/indexes')
  if (!response.ok) {
    throw new Error(`Failed to fetch market data: ${response.statusText}`)
  }
  const json: ApiResponse<Record<string, MarketIndex>> = await response.json()
  if (json.status === 'error') {
    throw new Error(json.error ?? 'Unknown market data error')
  }
  return json.data ?? {}
}

/**
 * React Query hook to load major market index data.
 *
 * @returns TanStack Query result containing a record of MarketIndex by symbol
 */
export function useMarketData() {
  return useQuery({
    queryKey: ['marketData'],
    queryFn: fetchMarketData,
    staleTime: 60_000,   // 1 minute — indexes don't need sub-minute refresh
    retry: 1,
  })
}
