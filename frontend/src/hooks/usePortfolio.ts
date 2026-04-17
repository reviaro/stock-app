import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { PortfolioPosition, AddPositionPayload } from '@/types/portfolio'

async function fetchPortfolio(): Promise<PortfolioPosition[]> {
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

export function useAddPosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: AddPositionPayload) => {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to add position')
      return json.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  })
}

export function useRemovePosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (symbol: string) => {
      const res = await fetch(`/api/portfolio/${symbol}`, { method: 'DELETE' })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to remove position')
      return json.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  })
}
