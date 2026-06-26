import { useQuery } from '@tanstack/react-query'
import type { PortfolioResponse } from '@/types/portfolio'

async function fetchPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch('/api/portfolio')
  const json = await res.json()
  if (json.status !== 'success') throw new Error(json.error || 'Failed to fetch portfolio')
  return json.data
}

export function usePortfolio() {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: fetchPortfolio,
    refetchInterval: 60_000,
  })
}
