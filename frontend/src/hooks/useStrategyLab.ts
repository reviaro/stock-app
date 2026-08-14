import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateStrategyExperimentPayload,
  CreateStrategyRunPayload,
  CreateStrategyVersionPayload,
  StrategyExperimentDetail,
  StrategyExperimentSummary,
  StrategyRun,
  StrategyVersion,
} from '@/types/strategyLab'

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const payload = await response.json()
  if (!response.ok || payload.status !== 'success') {
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  return payload.data as T
}

const jsonOptions = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function useStrategyExperiments() {
  return useQuery<StrategyExperimentSummary[]>({
    queryKey: ['strategy-lab', 'experiments'],
    queryFn: () => apiFetch('/api/strategy-lab/experiments'),
  })
}

export function useStrategyExperiment(id: number | null) {
  return useQuery<StrategyExperimentDetail>({
    queryKey: ['strategy-lab', 'experiment', id],
    queryFn: () => apiFetch(`/api/strategy-lab/experiments/${id}`),
    enabled: id != null,
  })
}

export function useCreateStrategyExperiment() {
  const queryClient = useQueryClient()
  return useMutation<StrategyExperimentSummary, Error, CreateStrategyExperimentPayload>({
    mutationFn: (payload) => apiFetch('/api/strategy-lab/experiments', jsonOptions(payload)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['strategy-lab', 'experiments'] }),
  })
}

export function useAddStrategyVersion(experimentId: number | null) {
  const queryClient = useQueryClient()
  return useMutation<StrategyVersion, Error, CreateStrategyVersionPayload>({
    mutationFn: (payload) => {
      if (experimentId == null) throw new Error('Select an experiment first')
      return apiFetch(`/api/strategy-lab/experiments/${experimentId}/versions`, jsonOptions(payload))
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['strategy-lab', 'experiment', experimentId] }),
  })
}

export function useAddStrategyRun(experimentId: number | null, versionId: number | null) {
  const queryClient = useQueryClient()
  return useMutation<StrategyRun, Error, CreateStrategyRunPayload>({
    mutationFn: (payload) => {
      if (versionId == null) throw new Error('Create a strategy version first')
      return apiFetch(`/api/strategy-lab/versions/${versionId}/runs`, jsonOptions(payload))
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['strategy-lab', 'experiment', experimentId] }),
  })
}
