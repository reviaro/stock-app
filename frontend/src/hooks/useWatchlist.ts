import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiResponse, WatchlistEntry, StockSearchResult } from '@/types'

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
 * Search stocks by symbol or name via /api/watchlist/search/:query
 */
export async function searchStocks(query: string): Promise<StockSearchResult[]> {
  if (!query.trim()) return []
  const response = await fetch(`/api/watchlist/search/${encodeURIComponent(query.trim())}`)
  if (!response.ok) return []
  const json: ApiResponse<StockSearchResult[]> = await response.json()
  return json.data ?? []
}

/**
 * React Query hook to load the user's watchlist with live stock data.
 */
export function useWatchlist() {
  return useQuery({
    queryKey: ['watchlist'],
    queryFn: fetchWatchlist,
    staleTime: 30_000,
    retry: 1,
  })
}

/**
 * Mutation hook to add a stock to the watchlist.
 * Invalidates the watchlist cache on success.
 */
export function useAddToWatchlist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (symbol: string) => {
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      const json: ApiResponse<WatchlistEntry> = await response.json()
      if (json.status === 'error') {
        throw new Error(json.error ?? 'Failed to add stock')
      }
      return json.data
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['watchlist'] })
    },
  })
}

/**
 * Mutation hook to remove a stock from the watchlist.
 * Invalidates the watchlist cache on success.
 */
export function useRemoveFromWatchlist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (symbol: string) => {
      const response = await fetch(`/api/watchlist/${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
      })
      const json: ApiResponse<{ deleted: number }> = await response.json()
      if (json.status === 'error') {
        throw new Error(json.error ?? 'Failed to remove stock')
      }
      return json.data
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['watchlist'] })
    },
  })
}
