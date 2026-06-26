import { useQuery } from '@tanstack/react-query'
import type { ScreenerCandidate } from '@/types/screener'

export function useValueScreener() {
  return useQuery<ScreenerCandidate[]>({
    queryKey: ['value-screener', 'watchlist'],
    queryFn: async () => {
      const res = await fetch('/api/screener/value?universe=watchlist')
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to load screener')
      return json.data as ScreenerCandidate[]
    },
    staleTime: 5 * 60_000,
  })
}
