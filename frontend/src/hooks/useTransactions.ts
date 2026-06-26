import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PortfolioTransaction, TransactionPayload } from '@/types/portfolio'

export function useTransactions() {
  return useQuery({
    queryKey: ['transactions'],
    queryFn: async () => {
      const res = await fetch('/api/transactions')
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to load transactions')
      return json.data as PortfolioTransaction[]
    },
    staleTime: 30_000,
  })
}

export function useAddTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: TransactionPayload) => {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to add transaction')
      return json.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['watchlist'] })
      void qc.invalidateQueries({ queryKey: ['risk'] })
    },
  })
}

export function useDeleteTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (json.status !== 'success') throw new Error(json.error || 'Failed to delete transaction')
      return json.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['watchlist'] })
      void qc.invalidateQueries({ queryKey: ['risk'] })
    },
  })
}
