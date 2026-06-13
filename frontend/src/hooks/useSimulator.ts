import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SimAccount, SimHolding, SimTransaction, TaxPreview, TradePayload } from '@/types/simulator'

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  const json = await res.json()
  if (json.status !== 'success') throw new Error(json.error || 'API error')
  return json.data as T
}

export function useSimAccount() {
  return useQuery<SimAccount>({
    queryKey: ['sim-account'],
    queryFn: () => apiFetch('/api/simulator/account'),
    refetchInterval: 60_000,
  })
}

export function useSimHoldings() {
  return useQuery<SimHolding[]>({
    queryKey: ['sim-holdings'],
    queryFn: () => apiFetch('/api/simulator/holdings'),
    refetchInterval: 60_000,
  })
}

export function useSimTransactions() {
  return useQuery<SimTransaction[]>({
    queryKey: ['sim-transactions'],
    queryFn: () => apiFetch('/api/simulator/transactions'),
    refetchInterval: 60_000,
  })
}

export function useTaxPreview(symbol: string | null, shares: number) {
  return useQuery<TaxPreview>({
    queryKey: ['sim-tax-preview', symbol, shares],
    queryFn: () =>
      apiFetch(`/api/simulator/tax-preview?symbol=${symbol}&shares=${shares}`),
    enabled: Boolean(symbol && shares > 0),
  })
}

export function useSimDeposit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (amount: number) =>
      apiFetch('/api/simulator/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deposit: amount }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sim-account'] })
      qc.invalidateQueries({ queryKey: ['sim-transactions'] })
    },
  })
}

export function useSetTaxBracket() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bracket: number) =>
      apiFetch('/api/simulator/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tax_bracket: bracket }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sim-account'] }),
  })
}

export function useSimTrade() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: TradePayload) =>
      apiFetch('/api/simulator/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sim-account'] })
      qc.invalidateQueries({ queryKey: ['sim-holdings'] })
      qc.invalidateQueries({ queryKey: ['sim-transactions'] })
    },
  })
}

export function useSimReset() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch('/api/simulator/reset', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sim-account'] })
      qc.invalidateQueries({ queryKey: ['sim-holdings'] })
      qc.invalidateQueries({ queryKey: ['sim-transactions'] })
    },
  })
}
