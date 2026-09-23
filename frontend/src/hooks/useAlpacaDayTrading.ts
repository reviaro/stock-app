import { useQuery } from '@tanstack/react-query'
import type { AlpacaDayTradeJournal } from '@/types/alpacaDayTrading'

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  const json = await res.json()
  if (json.status !== 'success') throw new Error(json.error || 'API error')
  return json.data as T
}

// v1 is retired: only its read-only journal remains, shown under Historical v1.
export function useAlpacaDayTradingJournal() {
  return useQuery<AlpacaDayTradeJournal>({
    queryKey: ['alpaca-day-trading', 'journal'],
    queryFn: () => apiFetch('/api/alpaca-paper/day-trading/journal'),
    staleTime: 30_000,
    retry: false,
  })
}
