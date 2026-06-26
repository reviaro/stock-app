import { useQuery } from '@tanstack/react-query'

export interface QualityMetric {
  value: number | null
  grade: string | null
  unit: string
}

export interface QualityData {
  symbol: string
  composite: number | null
  metrics: Record<string, QualityMetric>
}

export function useQuality(symbol: string) {
  return useQuery({
    queryKey: ['quality', symbol],
    queryFn: async () => {
      const res = await fetch(`/api/quality/${encodeURIComponent(symbol)}`)
      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        const text = await res.text()
        if (text.trim().startsWith('<')) {
          throw new Error('Received HTML instead of JSON from /api/quality. Restart the backend on port 3002 so the new quality route is active.')
        }
        throw new Error('Quality endpoint returned a non-JSON response.')
      }
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to load quality metrics')
      return json.data as QualityData
    },
    enabled: Boolean(symbol),
    staleTime: 15 * 60 * 1000,
    retry: 1,
  })
}
