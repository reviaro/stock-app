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

export interface AlpacaDayTradeOrderLeg {
  status: string
  filledQty: number
}

export interface AlpacaDayTradeEntryOrder {
  status: string
  qty: number
  filledQty: number
  submittedAt: string | null
}

export interface AlpacaDayTradeStopLeg extends AlpacaDayTradeOrderLeg {
  stopPrice: number | null
}

export interface AlpacaDayTradeTargetLeg extends AlpacaDayTradeOrderLeg {
  limitPrice: number | null
}

// Discriminated on `unavailable` so the compiler forces a check before any leg is read --
// `null` (no live orders exist, e.g. a closed plan) is a distinct third state, not folded in.
export type AlpacaDayTradeLiveOrders =
  | { unavailable: true }
  | {
      unavailable: false
      entry: AlpacaDayTradeEntryOrder | null
      stopLeg: AlpacaDayTradeStopLeg | null
      targetLeg: AlpacaDayTradeTargetLeg | null
    }

export interface AlpacaDayTradePlanDetail {
  plan: AlpacaDayTradePlan
  fills: AlpacaDayTradeFill[]
  liveOrders: AlpacaDayTradeLiveOrders | null
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

export interface AlpacaDayTradeJournalEvent {
  source: 'semantic' | 'order_audit' | 'fill'
  eventKey?: string
  planId: number | null
  eventType: string
  action: string | null
  outcome: string | null
  reason: string | null
  detail: Record<string, unknown>
  occurredAt: string
}

export interface AlpacaDayTradeJournal {
  analytics: AlpacaDayTradeJournalAnalytics
  trades: AlpacaDayTradePlan[]
  events: AlpacaDayTradeJournalEvent[]
}

// ---- v2 strategy lab (sanitized reader shapes: no broker/client/order ids by contract) ----

export type AlpacaV2Mode = 'disabled' | 'shadow' | 'paper_execute'

export interface AlpacaV2Status {
  mode: AlpacaV2Mode
  killSwitch: boolean
  attentionRequired: boolean
  attentionCode: string | null
  lastReconciledAt: string | null
  lastWebsocketAt: string | null
  sessionDate: string | null
  heartbeatFresh: boolean
  openPlanCount: number
  attentionPlanCount: number
}

export interface AlpacaV2Position {
  symbol: string
  qty: number | null
  side: 'long' | 'short'
  avgEntryPrice: number | null
  currentPrice: number | null
  marketValue: number | null
  unrealizedPnl: number | null
  planId: number | null
}

export interface AlpacaV2OpenOrder {
  symbol: string
  side: 'buy' | 'sell'
  type: string | null
  qty: number | null
  filledQty: number | null
  status: string | null
  limitPrice: number | null
  stopPrice: number | null
  planOwned: boolean
}

export interface AlpacaV2Snapshot {
  account: { cash: number | null; equity: number | null; status: string | null }
  clock: { isOpen: boolean; nextOpen: string | null; nextClose: string | null }
  positions: AlpacaV2Position[]
  openOrders: AlpacaV2OpenOrder[]
  limits: Record<string, number | string>
}

export interface AlpacaV2Plan {
  id: number
  symbol: string
  setup: string
  catalyst: string
  thesis: string
  invalidation: string
  plannedQty: number
  plannedEntryPrice: number
  plannedStop: number
  plannedTarget: number
  plannedRiskDollars: number
  exitDeadline: string
  state: string
  attentionCode: string | null
  filledEntryQty: number
  avgEntryPrice: number | null
  filledExitQty: number
  avgExitPrice: number | null
  exitReason: string | null
  realizedPnl: number | null
  realizedR: number | null
  setupId: string
  strategyVersion: string
  catalystClass: string
  entryEvidence: Record<string, string | number | boolean | null>
  actualInitialRiskDollars: number | null
  actualRiskR: number | null
  fillEvidenceComplete: boolean
  observations?: {
    count: number | null
    mfeDollars: number | null
    maeDollars: number | null
    firstAt: string | null
    lastAt: string | null
    complete: boolean
    note: string | null
  }
  createdAt: string
  openedAt: string | null
  closedAt: string | null
}

export interface AlpacaV2Event {
  planId: number | null
  type: string
  action: string | null
  outcome: string | null
  reasonCode: string | null
  detail: Record<string, string | number | boolean | null>
  occurredAt: string
}

export interface AlpacaV2GroupStats {
  count: number
  winRate: number | null
  realizedPnl: number | null
  expectancyDollars: number | null
  expectancyR: number | null
  expectancyActualRiskR?: number | null
}

export interface AlpacaV2Analytics {
  closedTradeCount: number
  wins: number
  losses: number
  winRate: number | null
  grossProfit: number | null
  grossLoss: number | null
  profitFactor: number | null
  averageWin: number | null
  averageLoss: number | null
  expectancyDollars: number | null
  expectancyR: number | null
  expectancyActualRiskR: number | null
  realizedPnl: number | null
  maxConsecutiveLosses: number
  maxClosedTradeDrawdownDollars: number | null
  averageHoldMinutes: number | null
  bySetup: Record<string, AlpacaV2GroupStats>
  byCatalyst: Record<string, AlpacaV2GroupStats>
  byWindow: Record<string, AlpacaV2GroupStats>
  bySessionDate: Record<string, AlpacaV2GroupStats>
  byStrategyVersion: Record<string, AlpacaV2GroupStats>
  byExitReason: Record<string, AlpacaV2GroupStats>
  evidence: { classifiedTrades: number; measuredTrades: number; totalTrades: number; sampledObservationCount: number }
  noTrade: { count: number; byReason: Record<string, number> }
  attention: { count: number; byCode: Record<string, number> }
  excludedOperatorResolved: number
  excludedIncompleteFills: number
  sample: { size: number; preliminary: boolean; note: string }
}

export interface AlpacaV2Journal {
  analytics: AlpacaV2Analytics
  trades: AlpacaV2Plan[]
  events: AlpacaV2Event[]
}

export type AlpacaV2ExperimentDefinition = {
  name: string
  setupId: string
  strategyVersion: string
  durationDays: number
  minTrades: number
  costBps: number
} & (
  | { kind: 'stall_exit'; parameters: { afterMinutes: number; minimumProgressR: number } }
  | { kind: 'atr_target'; parameters: { atrMultiple: number } }
)

export type AlpacaV2Experiment = Omit<AlpacaV2ExperimentDefinition, 'durationDays' | 'kind' | 'parameters'> & (
  | { kind: 'stall_exit'; parameters: { afterMinutes: number; minimumProgressR: number } }
  | { kind: 'atr_target'; parameters: { atrMultiple: number } }
) & {
  id: number
  createdAt: string
  endsAt: string
  results: {
    status: 'collecting' | 'complete'
    eligibleCount: number
    excludedCount: number
    triggeredCount: number
    baselineGrossPnl: number | null
    baselineNetPnl: number | null
    shadowGrossPnl: number | null
    shadowNetPnl: number | null
    differenceNetPnl: number | null
    meanDifferenceNetPnl: number | null
    minimumTradesMet: boolean
    exclusions: Record<string, number>
  }
}

export interface AlpacaV2Experiments { experiments: AlpacaV2Experiment[] }

export interface AlpacaV2DailyRisk {
  complete: boolean
  sessionDate: string | null
  realizedPnl: number | null
  fillCount: number
  reasonCodes: string[]
  maxDailyLossPct: number
  minRewardRiskRatio: number
  scope: 'v2_realized'
}

export interface AlpacaHistoryValues {
  state: string | null
  entryQty: number | null
  exitQty: number | null
  entryPrice: number | null
  exitPrice: number | null
  realizedPnl: number | null
  realizedR: number | null
  openedAt: string | null
  closedAt: string | null
  exitReason: string | null
}

export interface AlpacaHistoryRepair {
  planId: number
  symbol: string
  kind: 'restore_closed_history'
  requiresAttributionReview: boolean
  missingFillCount: number
  linkedFillCount: number
  before: AlpacaHistoryValues
  after: AlpacaHistoryValues
}

interface AlpacaHistoryCounts {
  planCount: number
  fillCount: number
  canonicalFillCount: number
  duplicateRows: number
  unlinkedFills: number
}

export interface AlpacaHistoryPreview {
  reviewToken: string
  monitorModes: { v1: string | null; v2: string | null }
  summary: {
    v1: AlpacaHistoryCounts
    v2: AlpacaHistoryCounts
    broker: { fillCount: number; complete: boolean }
    repairablePlans: number
    attributionReviewPlans: number
  }
  issues: { code: string; severity: 'warning' | 'error'; version?: string; planId?: number; symbol?: string; count?: number; message: string }[]
  applyBlockers: string[]
  repairs: AlpacaHistoryRepair[]
}

export interface AlpacaHistoryApplyInput {
  reviewToken: string
  selectedPlanIds: number[]
  attributionPlanIds: number[]
  confirm: 'APPLY_HISTORY_REPAIR'
}

export interface AlpacaHistoryApplyResult {
  applied: boolean
  replayed: boolean
  repairedPlanCount: number
  importedFillCount: number
  linkedFillCount: number
}
