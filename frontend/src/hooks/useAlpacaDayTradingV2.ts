import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AlpacaV2Journal,
  AlpacaV2Mode,
  AlpacaV2Plan,
  AlpacaV2Snapshot,
  AlpacaV2Status,
  AlpacaV2ExperimentDefinition,
  AlpacaV2Experiments,
  AlpacaV2Experiment,
  AlpacaHistoryPreview,
  AlpacaHistoryApplyInput,
  AlpacaHistoryApplyResult,
  AlpacaV2DailyRisk,
} from '@/types/alpacaDayTrading'

import { AlpacaV2Error } from '@/lib/alpacaV2Errors'

const BASE = '/api/alpaca-paper/day-trading/v2'

async function v2Fetch<T>(path: string, options?: RequestInit): Promise<T> {
  let json: { status?: string; code?: string; data?: T } = {}
  try {
    const res = await fetch(`${BASE}${path}`, options)
    json = await res.json()
  } catch {
    throw new AlpacaV2Error('ALPACA_V2_UNREACHABLE')
  }
  if (json.status !== 'success') throw new AlpacaV2Error(typeof json.code === 'string' ? json.code : 'ALPACA_V2_ERROR')
  return json.data as T
}

function post<T>(path: string, body: unknown) {
  return v2Fetch<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

// Local-only on the backend: cheap to poll and still answers during a broker outage.
export function useV2Status() {
  return useQuery<AlpacaV2Status>({ queryKey: ['alpaca-dt-v2', 'status'], queryFn: () => v2Fetch('/status'), staleTime: 5_000, refetchInterval: 10_000, retry: false })
}

export function useV2Snapshot() {
  return useQuery<AlpacaV2Snapshot>({ queryKey: ['alpaca-dt-v2', 'snapshot'], queryFn: () => v2Fetch('/snapshot'), staleTime: 15_000, refetchInterval: 30_000, retry: false })
}

export function useV2Plans() {
  return useQuery<AlpacaV2Plan[]>({ queryKey: ['alpaca-dt-v2', 'plans'], queryFn: () => v2Fetch('/plans'), staleTime: 15_000, refetchInterval: 30_000, retry: false })
}

export function useV2Journal() {
  return useQuery<AlpacaV2Journal>({ queryKey: ['alpaca-dt-v2', 'journal'], queryFn: () => v2Fetch('/journal'), staleTime: 30_000, retry: false })
}

export function useV2DailyRisk() {
  return useQuery<AlpacaV2DailyRisk>({ queryKey: ['alpaca-dt-v2', 'risk'], queryFn: () => v2Fetch('/risk'), staleTime: 15_000, refetchInterval: 30_000, retry: false })
}

export function useV2Experiments() {
  return useQuery<AlpacaV2Experiments>({ queryKey: ['alpaca-dt-v2', 'experiments'], queryFn: () => v2Fetch('/experiments'), staleTime: 30_000, retry: false })
}

export function useCreateV2Experiment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (definition: AlpacaV2ExperimentDefinition) => post<AlpacaV2Experiment>('/experiments', definition),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alpaca-dt-v2', 'experiments'] }),
  })
}

export function usePreviewAlpacaHistory() {
  return useMutation({ mutationFn: () => post<AlpacaHistoryPreview>('/history/preview', {}) })
}

export function useDisableLegacyAlpacaMonitor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => post<{ disabled: true; alreadyDisabled: boolean; mode: 'disabled' }>('/history/disable-legacy', { confirm: 'DISABLE_LEGACY' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
  })
}

export function useApplyAlpacaHistory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AlpacaHistoryApplyInput) => post<AlpacaHistoryApplyResult>('/history/apply', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alpaca-dt-v2'] })
      void qc.invalidateQueries({ queryKey: ['alpaca-day-trading'] })
    },
  })
}

// Operator controls ride the authenticated session cookie only: no token ever lives in the browser.
export function useSetV2Mode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ mode, confirm }: { mode: AlpacaV2Mode; confirm: string | true }) => post<{ mode: AlpacaV2Mode }>('/mode', { mode, confirm }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
  })
}

export function useClearV2KillSwitch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => post<{ killSwitch: boolean }>('/kill-switch/clear', { confirm: 'CLEAR' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
  })
}

export function useResolveV2Plan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ planId, symbol }: { planId: number; symbol: string }) => post<{ plan: AlpacaV2Plan }>(`/plans/${planId}/resolve`, { confirm: symbol }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alpaca-dt-v2'] }),
  })
}
