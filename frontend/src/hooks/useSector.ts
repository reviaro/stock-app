import { useQuery } from '@tanstack/react-query'

export interface SectorPerformance {
  ticker: string
  name: string
  change1M: number
  change3M: number
  change6M: number
  price: number
}

export function useSectorPerformance() {
  return useQuery({
    queryKey: ['sectors'],
    queryFn: async () => {
      const res = await fetch('/api/market/sectors')
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to fetch sector data')
      return json.data as SectorPerformance[]
    },
    staleTime: 10 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })
}
