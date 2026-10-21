import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LiveOverview, LivePlan, LivePolicy, LiveOrder, SimulatorAllocationDraft } from '@/types/alpacaLive'

export async function liveRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch('/api/alpaca-live' + path, body === undefined
    ? { credentials: 'same-origin' }
    : { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await response.json()
  if (!response.ok || json.status !== 'success') throw new Error(json.error || 'Unable to reach live investing.')
  return json.data as T
}
export function useAlpacaLive() {
  const cache = useQueryClient()
  const refresh = () => cache.invalidateQueries({ queryKey: ['alpaca-live'] })
  const overview = useQuery({ queryKey: ['alpaca-live', 'overview'], queryFn: () => liveRequest<LiveOverview>('/overview'),
    retry: false, staleTime: 15000, refetchOnWindowFocus: false })
  const policy = useMutation({ mutationFn: (body: { policy: LivePolicy; expectedVersion: number; confirmation: string }) => liveRequest('/policy', body, 'PUT'), onSuccess: refresh })
  const preview = useMutation({ mutationFn: (body: { decisionKey?: string }) => liveRequest<LivePlan>('/preview', body) })
  const execute = useMutation({ mutationFn: (body: { planId: string; confirmation: string }) => liveRequest<{ order: LiveOrder }>('/execute', body), onSettled: refresh })
  const cancel = useMutation({ mutationFn: (id: string) => liveRequest('/orders/' + encodeURIComponent(id) + '/cancel', {}), onSettled: refresh })
  const draft = useMutation({ mutationFn: () => liveRequest<SimulatorAllocationDraft>('/simulator-draft') })
  const ownership = useMutation({ mutationFn: (body: { symbol: string; qty: number; confirmation: string; reason: string }) => liveRequest('/ownership', body), onSuccess: refresh })
  return { overview, policy, preview, execute, cancel, draft, ownership }
}
