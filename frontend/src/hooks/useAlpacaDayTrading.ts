import { useQuery } from '@tanstack/react-query'
import type {
  AlpacaDayTradingMonitorHealth,
  AlpacaDayTradingSnapshot,
  AlpacaDayTradePlan,
  AlpacaDayTradePlanDetail,
  AlpacaDayTradeJournalAnalytics,
} from '@/types/alpacaDayTrading'

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const json = await res.json()
  if (json.status !== 'success') throw new Error(json.error || 'API error')
  return json.data as T
}

// Local-only on the backend (no broker call) -- safe to poll on a short interval even during
// an Alpaca outage, and it's the one panel that should keep updating when everything else 503s.
export function useAlpacaDayTradingMonitorHealth() {
  return useQuery<AlpacaDayTradingMonitorHealth>({
    queryKey: ['alpaca-day-trading', 'monitor-health'],
    queryFn: () => apiFetch('/api/alpaca-paper/day-trading/monitor-health'),
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
  })
}

// Four broker calls per request (account/clock/positions, plus createPaperClient's own
// validation) -- refetch on a real interval, not aggressively, per the session's own note on
// this endpoint's cost.
export function useAlpacaDayTradingSnapshot() {
  return useQuery<AlpacaDayTradingSnapshot>({
    queryKey: ['alpaca-day-trading', 'snapshot'],
    queryFn: () => apiFetch('/api/alpaca-paper/day-trading/snapshot'),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: false,
  })
}

export function useAlpacaDayTradingPlans(state?: string) {
  return useQuery<AlpacaDayTradePlan[]>({
    queryKey: ['alpaca-day-trading', 'plans', state ?? 'all'],
    queryFn: () => apiFetch(`/api/alpaca-paper/day-trading/plans${state ? `?state=${encodeURIComponent(state)}` : ''}`),
    staleTime: 15_000,
    retry: false,
  })
}

export function useAlpacaDayTradingPlanDetail(id: number | null) {
  return useQuery<AlpacaDayTradePlanDetail>({
    queryKey: ['alpaca-day-trading', 'plan', id],
    queryFn: () => apiFetch(`/api/alpaca-paper/day-trading/plans/${id}`),
    enabled: id != null,
    retry: false,
  })
}

export function useAlpacaDayTradingJournal() {
  return useQuery<AlpacaDayTradeJournalAnalytics>({
    queryKey: ['alpaca-day-trading', 'journal'],
    queryFn: () => apiFetch('/api/alpaca-paper/day-trading/journal'),
    staleTime: 30_000,
    retry: false,
  })
}
