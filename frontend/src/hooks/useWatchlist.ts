import { useQuery } from '@tanstack/react-query'
import type { ApiResponse, WatchlistEntry } from '@/types'

/**
 * Fetches the watchlist from /api/watchlist.
 * The backend merges DB rows (id, symbol, added_at, notes) with live stock data.
 */
async function fetchWatchlist(): Promise<WatchlistEntry[]> {
  const response = await fetch('/api/watchlist')
  if (!response.ok) {
    throw new Error(`Failed to fetch watchlist: ${response.statusText}`)
  }
  const json: ApiResponse<WatchlistEntry[]> = await response.json()
  if (json.status === 'error') {
    throw new Error(json.error ?? 'Unknown watchlist error')
  }
  return json.data ?? []
}

/**
 * React Query hook to load the user's watchlist with live stock data.
 *
 * @returns TanStack Query result containing an array of WatchlistEntry
 */
export function useWatchlist() {
  return useQuery({
    queryKey: ['watchlist'],
    queryFn: fetchWatchlist,
    staleTime: 30_000,  // 30 seconds — matches project-wide default
    retry: 1,
  })
}
