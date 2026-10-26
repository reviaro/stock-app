import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LiveOverview, LivePlan, LivePolicy, LiveOrder, SimulatorAllocationDraft } from '@/types/alpacaLive'

export interface OperatorSecurity {
  authenticated: boolean
  mfaConfigured: boolean
  recentMfa: boolean
  recentAuthUntil: string | null
}

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
  const security = useQuery({ queryKey: ['operator-security'], queryFn: async (): Promise<OperatorSecurity> => {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' })
    const json = await response.json()
    if (!response.ok || json.status !== 'success') throw new Error('Unable to verify your sign-in status.')
    return json.data
  }, retry: false, staleTime: 0, refetchOnWindowFocus: true })
  const policy = useMutation({ mutationFn: (body: { policy: LivePolicy; expectedVersion: number; confirmation: string }) => liveRequest('/policy', body, 'PUT'), onSuccess: refresh })
  const pause = useMutation({ mutationFn: (expectedVersion: number) => liveRequest('/pause', { expectedVersion }), onSettled: refresh })
  const preview = useMutation({ mutationFn: (body: { decisionKey?: string }) => liveRequest<LivePlan>('/preview', body) })
  const execute = useMutation({ mutationFn: (body: { planId: string; confirmation: string }) => liveRequest<{ order: LiveOrder }>('/execute', body), onSettled: refresh })
  const cancel = useMutation({ mutationFn: (id: string) => liveRequest('/orders/' + encodeURIComponent(id) + '/cancel', {}), onSettled: refresh })
  const draft = useMutation({ mutationFn: () => liveRequest<SimulatorAllocationDraft>('/simulator-draft') })
  const ownership = useMutation({ mutationFn: (body: { symbol: string; qty: number; confirmation: string; reason: string }) => liveRequest('/ownership', body), onSuccess: refresh })
  return { overview, security, policy, pause, preview, execute, cancel, draft, ownership }
}
