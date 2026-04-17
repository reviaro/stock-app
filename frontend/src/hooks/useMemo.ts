import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Memo, MemoInput } from '@/types/memo'

const API = '/api/memos'

async function fetchMemo(symbol: string): Promise<Memo | null> {
  const res = await fetch(`${API}/${encodeURIComponent(symbol)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Failed to load memo')
  const j = await res.json()
  return j.data
}

async function saveMemo(symbol: string, input: MemoInput): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(symbol)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error('Failed to save memo')
}

async function reviewMemo(symbol: string): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(symbol)}/reviewed`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to mark reviewed')
}

async function listMemos(): Promise<Memo[]> {
  const res = await fetch(API)
  if (!res.ok) throw new Error('Failed to list memos')
  const j = await res.json()
  return j.data
}

export function useMemoQuery(symbol: string | null) {
  return useQuery({
    queryKey: ['memo', symbol],
    queryFn: () => (symbol ? fetchMemo(symbol) : Promise.resolve(null)),
    enabled: !!symbol,
  })
}

export function useMemosListQuery() {
  return useQuery({ queryKey: ['memos'], queryFn: listMemos })
}

export function useSaveMemo(symbol: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: MemoInput) => saveMemo(symbol, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memo', symbol] })
      qc.invalidateQueries({ queryKey: ['memos'] })
    },
  })
}

export function useReviewMemo(symbol: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => reviewMemo(symbol),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memo', symbol] })
      qc.invalidateQueries({ queryKey: ['memos'] })
    },
  })
}