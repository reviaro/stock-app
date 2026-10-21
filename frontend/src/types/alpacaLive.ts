export interface LiveTarget { symbol: string; weightPct: number }
export interface LivePolicy {
  budget: number; reservePct: number; maxPositionPct: number; maxOrderValue: number
  minTradeValue: number; driftPct: number; maxSpreadBps: number
  fractional: boolean; paused: boolean; executionMode: 'confirm' | 'automatic'; targets: LiveTarget[]
}
export interface LiveOrder {
  id: string; planId: string; decisionKey: string | null; symbol: string; side: 'buy' | 'sell'
  qty: number; limitPrice: number; status: string; filledQty: number; filledAvgPrice: number | null
  createdAt: string; updatedAt: string
}
export interface LiveOverview {
  configuration: { configured: boolean; accountBound: boolean; tradingEnabled: boolean; environment: 'live' }
  version: number; policy: LivePolicy; connected: boolean; blockers: string[]
  cash?: number; equity?: number; cashBuyingPower?: number; accountLabel?: string; marketOpen?: boolean; checkedAt?: string
  positions: { symbol: string; qty: number; price: number; value: number; managedQty: number; unrealizedPnl: number }[]
  orders: LiveOrder[]
  decisions: { decision_key: string; symbol: string; side: string; reason: string; created_at: string }[]
}
export interface LivePlanRow {
  symbol: string; side: 'buy' | 'sell'; qty: number; limitPrice: number; notional: number
  currentQty: number; currentValue: number; targetWeightPct: number; targetValue: number
  driftPct: number; actionable: boolean; quoteAt: string; feed: string; fractional: boolean
}
export interface LivePlan {
  id: string; policyVersion: number; createdAt: string; expiresAt: string; decisionKey: string | null
  nextOrder: LivePlanRow | null; rows: LivePlanRow[]; blockers: string[]
  managedValue: number; spendableCash: number; unmanagedValue: number; allocationCapital: number
}
export interface SimulatorAllocationDraft {
  sourceAccountId: number; targets: LiveTarget[]; sourceCashPct: number
  marks: { symbol: string; asOf: string; source: string }[]; note: string
}
