import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiResponse } from '@/types'
import type { SnapshotEntry, SnapshotGroup } from '@/types/history'

async function fetchHistory(days = 30): Promise<SnapshotGroup[]> {
  const response = await fetch(`/api/history?days=${days}`)
  if (!response.ok) throw new Error(`Failed to fetch history: ${response.statusText}`)
  const json: ApiResponse<SnapshotGroup[]> = await response.json()
  if (json.status === 'error') throw new Error(json.error ?? 'History error')
  return json.data ?? []
}

export function useSnapshotHistory(days = 30) {
  return useQuery({
    queryKey: ['snapshot-history', days],
    queryFn: () => fetchHistory(days),
    staleTime: 30_000,
  })
}

export function useTodaySnapshotMap() {
  return useQuery({
    queryKey: ['today-snapshot-map'],
    queryFn: async () => {
      const groups = await fetchHistory(7)
      const map = new Map<string, Partial<Record<'openish' | 'midday' | 'closeish' | 'manual-open', SnapshotEntry>>>()

      for (const group of groups) {
        const entries = group.history.slice().sort((a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime())
        const slots: Partial<Record<'openish' | 'midday' | 'closeish' | 'manual-open', SnapshotEntry>> = {}
        for (const entry of entries) {
          if (!(entry.slot in slots)) {
            slots[entry.slot as 'openish' | 'midday' | 'closeish' | 'manual-open'] = entry
          }
        }
        map.set(group.symbol, slots)
      }

      return map
    },
    staleTime: 30_000,
  })
}

export function useManualSnapshot() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/history/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: 'manual-open' }),
      })
      const json: ApiResponse<{ count: number; snapshots: SnapshotEntry[] }> = await response.json()
      if (json.status === 'error') throw new Error(json.error ?? 'Snapshot error')
      return json.data
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['watchlist'] })
      void queryClient.invalidateQueries({ queryKey: ['snapshot-history'] })
      void queryClient.invalidateQueries({ queryKey: ['today-snapshot-map'] })
    },
  })
}
