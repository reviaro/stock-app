import { useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SimAccount, SimHolding, SimTransaction, TaxPreview, TradePayload, SimReview, SimSleeve, SimRiskMonitor, SimJournal, SimReinvestmentSettings, SimDividendPayload } from '@/types/simulator'

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

export function useSetSimReinvestmentSettings(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (settings: SimReinvestmentSettings) =>
      apiFetch(`/api/simulator/reinvestment-settings${sleeveQuery(accountId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}

export function useRecordSimDividend(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dividend: SimDividendPayload) =>
      apiFetch('/api/simulator/dividend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dividend, account_id: accountId }),
      }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}

type PendingOrder = TradePayload & { account_id: number; client_order_id: string }
const orderListeners = new Set<() => void>()
const activeOrders = new Set<number>()
const orderKey = (id: number) => `sim-pending-order:${id}`
function readOrder(id: number) { return sessionStorage.getItem(orderKey(id)) }
function storeOrder(id: number, body: string | null) {
  if (body === null) sessionStorage.removeItem(orderKey(id))
  else sessionStorage.setItem(orderKey(id), body)
  orderListeners.forEach(listener => listener())
}
function subscribeOrders(listener: () => void) {
  orderListeners.add(listener)
  return () => { orderListeners.delete(listener) }
}

export function useSimTrade(accountId: number) {
  const qc = useQueryClient()
  const stored = useSyncExternalStore(subscribeOrders, () => readOrder(accountId))
  const pendingOrder: PendingOrder | null = stored ? JSON.parse(stored) : null
  const mutation = useMutation({
    retry: false,
    mutationFn: async (payload: TradePayload | undefined) => {
      if (activeOrders.has(accountId)) throw new Error('An order is already in flight')
      let body = readOrder(accountId)
      if (payload && body) throw new Error('Resolve the unresolved order before a new trade')
      if (!body && !payload) throw new Error('No unresolved order to retry')
      if (payload) {
        body = JSON.stringify({ type: payload.type, symbol: payload.symbol, shares: payload.shares,
          account_id: accountId, client_order_id: crypto.randomUUID(),
          ...(payload.trade_plan ? { trade_plan: payload.trade_plan } : {}),
          ...(payload.journal ? { journal: payload.journal } : {}),
        })
        // Persist BEFORE sending; storage failure must prevent the mutation.
        storeOrder(accountId, body)
      }
      activeOrders.add(accountId)
      try {
        const res = await fetch('/api/simulator/trade', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        })
        if (res.status === 400 || res.status === 409) storeOrder(accountId, null)
        const json = await res.json()
        if (!res.ok || json.status !== 'success') throw new Error(json.error || 'Order outcome unknown; reconcile before retrying')
        storeOrder(accountId, null)
        return json.data
      } finally { activeOrders.delete(accountId) }
    },
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
  const reconcileOrder = async (): Promise<unknown | null> => {
    const stored = readOrder(accountId)
    if (!stored) return null
    const { client_order_id } = JSON.parse(stored) as PendingOrder
    const res = await fetch(`/api/simulator/orders/${client_order_id}?account_id=${accountId}`)
    if (res.status === 404) return null
    const json = await res.json()
    if (!res.ok || json.status !== 'success') throw new Error(json.error || 'Order lookup failed; try again')
    storeOrder(accountId, null)
    invalidateSleeve(qc, accountId)
    return json.data?.result ?? json.data
  }
  return { ...mutation, pendingOrder, retryOrder: () => mutation.mutateAsync(undefined), reconcileOrder }
}

export function useSimReset(accountId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/simulator/reset${sleeveQuery(accountId)}`, { method: 'POST' }),
    onSuccess: () => invalidateSleeve(qc, accountId),
  })
}
