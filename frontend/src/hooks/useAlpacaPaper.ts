import { useQuery } from '@tanstack/react-query'
import type { AlpacaPaperSnapshot, AlpacaPaperStatus } from '@/types/alpacaPaper'

async function fetchPaperStatus(): Promise<AlpacaPaperStatus> {
  const response = await fetch('/api/alpaca-paper/status')
  const json = await response.json()
  if (json.status !== 'success') throw new Error(json.error || 'Unable to load Alpaca paper status')
  return json.data as AlpacaPaperStatus
}

export function useAlpacaPaperStatus() {
  return useQuery<AlpacaPaperStatus>({
    queryKey: ['alpaca-paper', 'status'],
    queryFn: fetchPaperStatus,
    staleTime: 60_000,
    retry: false,
  })
}

async function fetchPaperSnapshot(): Promise<AlpacaPaperSnapshot> {
  const response = await fetch('/api/alpaca-paper/snapshot')
  const json = await response.json()
  if (json.status !== 'success') throw new Error(json.error || 'Unable to load Alpaca paper reconciliation')
  return json.data as AlpacaPaperSnapshot
}

export function useAlpacaPaperSnapshot() {
  return useQuery<AlpacaPaperSnapshot>({
    queryKey: ['alpaca-paper', 'snapshot'],
    queryFn: fetchPaperSnapshot,
    staleTime: 15_000,
    retry: false,
  })
}
