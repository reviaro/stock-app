import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InvestingOverview } from '@/components/investing/LongTermInvestingWorkspace'
import type { LivePlan, LivePolicy, LiveOrder, SimulatorAllocationDraft } from '@/types/alpacaLive'

export async function paperInvestingRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch('/api/alpaca-paper/long-term' + path, body === undefined
    ? { credentials: 'same-origin' }
    : { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await response.json()
  if (!response.ok || json.status !== 'success') throw new Error(json.error || 'Unable to reach paper investing.')
  return json.data as T
}

export function useAlpacaPaperInvesting() {
  const cache = useQueryClient()
  const refresh = () => cache.invalidateQueries({ queryKey: ['alpaca-paper', 'long-term'] })
  const overview = useQuery({ queryKey: ['alpaca-paper', 'long-term', 'overview'], queryFn: () => paperInvestingRequest<InvestingOverview>('/overview'),
    retry: false, staleTime: 15000, refetchOnWindowFocus: false })
  const policy = useMutation({ mutationFn: (body: { policy: LivePolicy; expectedVersion: number; confirmation: string }) => paperInvestingRequest('/policy', body, 'PUT'), onSuccess: refresh })
  const pause = useMutation({ mutationFn: (expectedVersion: number) => paperInvestingRequest('/pause', { expectedVersion }), onSettled: refresh })
  const preview = useMutation({ mutationFn: (body: { decisionKey?: string }) => paperInvestingRequest<LivePlan>('/preview', body) })
  const execute = useMutation({ mutationFn: (body: { planId: string; confirmation: string }) => paperInvestingRequest<{ order: LiveOrder }>('/execute', body), onSettled: refresh })
  const cancel = useMutation({ mutationFn: (id: string) => paperInvestingRequest('/orders/' + encodeURIComponent(id) + '/cancel', {}), onSettled: refresh })
  const draft = useMutation({ mutationFn: () => paperInvestingRequest<SimulatorAllocationDraft>('/simulator-draft') })
  const ownership = useMutation({ mutationFn: (body: { symbol: string; qty: number; confirmation: string; reason: string }) => paperInvestingRequest('/ownership', body), onSuccess: refresh })
  return { overview, policy, pause, preview, execute, cancel, draft, ownership }
}

export function useRetirePaperDayTrading() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: async (confirmation: string) => {
      const response = await fetch('/api/alpaca-paper/retire-day-trading', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      })
      const json = await response.json()
      if (!response.ok || json.status !== 'success') throw new Error(json.error || 'Unable to retire the day-trading monitors.')
      return json.data
    },
    onSuccess: () => Promise.all([
      cache.invalidateQueries({ queryKey: ['alpaca-paper'] }),
      cache.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
      cache.invalidateQueries({ queryKey: ['alpaca-day-trading'] }),
    ]),
  })
}

export function useTransferLegacyPaperHolding() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (body: { symbol: string; qty: number; reason: string; confirmation: string }) =>
      paperInvestingRequest('/legacy-handover', body),
    onSuccess: () => Promise.all([
      cache.invalidateQueries({ queryKey: ['alpaca-paper'] }),
      cache.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
      cache.invalidateQueries({ queryKey: ['alpaca-day-trading'] }),
    ]),
  })
}

export interface LegacyPaperReconciliation {
  checked: number
  updated: number
  unchanged: number
  failures: number
  plans?: {
    checked: number
    reconciled: number
    closed: number
    cancelled: number
    blocked: number
    skipped: number
    blockers: { planId: number; symbol: string; code: string; message?: string }[]
  }
}

export function useReconcileLegacyPaperOrders() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: () => paperInvestingRequest<LegacyPaperReconciliation>('/legacy-reconcile', {}),
    onSuccess: () => Promise.all([
      cache.invalidateQueries({ queryKey: ['alpaca-paper'] }),
      cache.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
      cache.invalidateQueries({ queryKey: ['alpaca-day-trading'] }),
    ]),
  })
}
