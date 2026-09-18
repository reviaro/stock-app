export type AlpacaMonitorMode = 'disabled' | 'shadow' | 'paper_execute'

export interface AlpacaDayTradingMonitorHealth {
  mode: AlpacaMonitorMode | null
  killSwitch: boolean
  healthCode: string | null
  healthError: string | null
  lastRestReconciliationAt: string | null
  lastWebsocketEventAt: string | null
  lastWebsocketReconnectAt: string | null
  lastSyncedThrough: string | null
  sessionDate: string | null
  lastFlattenSweepAt: string | null
}

export interface AlpacaDayTradingPosition {
  symbol: string
  qty: string
  avgEntryPrice: string
  currentPrice: string
  marketValue: string
  unrealizedPnl: string
  unrealizedPnlPct: string
  side: string
  tracked: boolean
  planId: number | null
}

export interface AlpacaDayTradingRiskLimits {
  maxPositionPct: number
  minCashPct: number
  maxRiskPerTradePct: number
  maxTotalOpenRiskPct: number
  maxDailyLossPct: number
}

export interface AlpacaDayTradingRisk {
  equity: string
  cashPct: number | null
  totalOpenRiskDollars: number
  totalOpenRiskPct: number | null
  dailyRealizedPnl: number | null
  dailyLossPct: number | null
  dailyPnlUnavailableReason?: string
  limits: AlpacaDayTradingRiskLimits
}

export interface AlpacaDayTradePlan {
  id: number
  symbol: string
  setup: string
  catalyst: string
  thesis: string
  invalidation: string
  plannedEntryLow: number
  plannedEntryHigh: number
  plannedStop: number
  plannedTarget: number
  plannedQty: number
  plannedRiskDollars: number
  plannedRewardRisk: number
  plannedAccountRiskPct: number
  state: string
  filledEntryQty: number
  avgEntryPrice: number | null
  filledExitQty: number
  avgExitPrice: number | null
  exitDeadline: string
  exitReason: string | null
  realizedPnl: number | null
  realizedR: number | null
  mfe: number | null
  mae: number | null
  thesisValid: boolean | null
  reviewNotes: string | null
  strategyVersion: string | null
  createdAt: string
  openedAt: string | null
  closedAt: string | null
}

export interface AlpacaDayTradeFill {
  activityId: string
  symbol: string
  side: string
  qty: number
  price: number
  executedAt: string
  fillType: string
  source: string
  isBust: boolean
  correctionOf: string | null
}

export interface AlpacaDayTradePlanDetail {
  plan: AlpacaDayTradePlan
  fills: AlpacaDayTradeFill[]
}

export interface AlpacaDayTradingSnapshot {
  account: { cash: string; equity: string; buyingPower: string; status: string }
  clock: { isOpen: boolean; nextOpen: string; nextClose: string }
  positions: AlpacaDayTradingPosition[]
  activePlans: AlpacaDayTradePlan[]
  risk: AlpacaDayTradingRisk
  monitorHealth: {
    mode: AlpacaMonitorMode | null
    killSwitch: boolean
    healthCode: string | null
    healthError: string | null
    lastRestReconciliationAt: string | null
  }
}

export interface AlpacaDayTradeJournalSetupStats {
  trade_count: number
  win_rate_pct: number | null
  expectancy: number | null
  average_r: number | null
  total_pnl: number
}

export interface AlpacaDayTradeJournalAnalytics {
  closed_trade_count: number
  win_rate_pct: number | null
  expectancy: number | null
  profit_factor: number | null
  average_r: number | null
  total_pnl: number
  by_setup: Record<string, AlpacaDayTradeJournalSetupStats>
}
