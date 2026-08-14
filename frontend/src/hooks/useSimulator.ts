import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SimAccount, SimHolding, SimTransaction, TaxPreview, TradePayload, SimReview, SimSleeve, SimRiskMonitor, SimJournal } from '@/types/simulator'

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  const json = await res.json()
  if (json.status !== 'success') throw new Error(json.error || 'API error')
  return json.data as T
}

function sleeveQuery(accountId: number) {
  return `?account_id=${accountId}`
}

function invalidateSleeve(qc: ReturnType<typeof useQueryClient>, accountId: number) {
  qc.invalidateQueries({ queryKey: ['sim-account', accountId] })
  qc.invalidateQueries({ queryKey: ['sim-holdings', accountId] })
  qc.invalidateQueries({ queryKey: ['sim-transactions', accountId] })
  qc.invalidateQueries({ queryKey: ['sim-review', accountId] })
  qc.invalidateQueries({ queryKey: ['sim-risk-monitor', accountId] })
  qc.invalidateQueries({ queryKey: ['sim-journal', accountId] })
  qc.invalidateQueries({ queryKey: ['sim-tax-preview', accountId] })
}

export function useSimSleeves() {
  return useQuery<SimSleeve[]>({
    queryKey: ['sim-sleeves'],
    queryFn: () => apiFetch('/api/simulator/accounts'),
    staleTime: 60_000,
  })
}

export function useSimAccount(accountId = 1) {
  return useQuery<SimAccount>({
    queryKey: ['sim-account', accountId],
    queryFn: () => apiFetch(`/api/simulator/account${sleeveQuery(accountId)}`),
    refetchInterval: 60_000,
  })
}

export function useSimHoldings(accountId = 1) {
  return useQuery<SimHolding[]>({
    queryKey: ['sim-holdings', accountId],
    queryFn: () => apiFetch(`/api/simulator/holdings${sleeveQuery(accountId)}`),
    refetchInterval: 60_000,
  })
}

export function useSimTransactions(accountId = 1) {
  return useQuery<SimTransaction[]>({
    queryKey: ['sim-transactions', accountId],
    queryFn: () => apiFetch(`/api/simulator/transactions${sleeveQuery(accountId)}`),
    refetchInterval: 60_000,
  })
}

export function useSimReview(accountId = 1) {
  return useQuery<SimReview>({
    queryKey: ['sim-review', accountId],
    queryFn: () => apiFetch(`/api/simulator/review${sleeveQuery(accountId)}`),
    refetchInterval: 60_000,
  })
}

export function useSimRiskMonitor(accountId = 1) {
  return useQuery<SimRiskMonitor>({
    queryKey: ['sim-risk-monitor', accountId],
    queryFn: () => apiFetch(`/api/simulator/risk-monitor${sleeveQuery(accountId)}`),
    refetchInterval: 60_000,
  })
}

export function useSimJournal(accountId = 1) {
  return useQuery<SimJournal>({
    queryKey: ['sim-journal', accountId],
    queryFn: () => apiFetch(`/api/simulator/journal${sleeveQuery(accountId)}`),
    refetchInterval: 60_000,
  })
}

export function useTaxPreview(accountId: number, symbol: string | null, shares: number) {
  return useQuery<TaxPreview>({
    queryKey: ['sim-tax-preview', accountId, symbol, shares],
    queryFn: () => apiFetch(`/api/simulator/tax-preview?symbol=${symbol}&shares=${shares}&account_id=${accountId}`),
    enabled: Boolean(symbol && shares > 0),
  })
}

export function useSimDeposit(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (amount: number) =>
      apiFetch(`/api/simulator/account${sleeveQuery(accountId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deposit: amount }),
      }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}

export function useSetTaxBracket(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bracket: number) =>
      apiFetch(`/api/simulator/account${sleeveQuery(accountId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tax_bracket: bracket }),
      }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}

export function useSimTrade(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: TradePayload) =>
      apiFetch('/api/simulator/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, account_id: accountId }),
      }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}

export function useSimReset(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/simulator/reset${sleeveQuery(accountId)}`, { method: 'POST' }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}
