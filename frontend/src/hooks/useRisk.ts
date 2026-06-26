import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RiskPayload, RiskRules } from '@/types/risk'

export function useRisk() {
  return useQuery({
    queryKey: ['risk'],
    queryFn: async () => {
      const res = await fetch('/api/risk')
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to load risk data')
      return json.data as RiskPayload
    },
    staleTime: 30_000,
  })
}

export function useSaveRiskRules() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (rules: Partial<RiskRules>) => {
      const res = await fetch('/api/risk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rules),
      })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to save risk rules')
      return json.data as RiskRules
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['risk'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
    },
  })
}

export function useSetStopLoss() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ symbol, stop_loss }: { symbol: string; stop_loss: number }) => {
      const res = await fetch(`/api/risk/stops/${encodeURIComponent(symbol)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stop_loss }),
      })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to set stop loss')
      return json.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['risk'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
    },
  })
}

export function useDeleteStopLoss() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (symbol: string) => {
      const res = await fetch(`/api/risk/stops/${encodeURIComponent(symbol)}`, { method: 'DELETE' })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to clear stop loss')
      return json.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['risk'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
    },
  })
}
