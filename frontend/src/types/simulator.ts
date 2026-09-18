export interface SimSleeve {
  id: number
  name: string
  slug: 'long-term' | 'day-trading' | string
  tax_bracket: number
  created_at: string
}

export interface SimAccount {
  id: number
  name: string
  tax_bracket: number
  created_at: string
  cash: number
  /** null when valuation is incomplete (some holdings lack a quote) */
  total_value: number | null
  unrealized_pnl: number | null
  realized_pnl: number | null
  valuation_complete: boolean
  missing_symbols: string[]
  marked_value: number | null
  dividend_reinvestment_mode: 'cash' | 'drip'
  profit_reinvestment_mode: 'hold_cash' | 'redeploy_excess'
  target_cash_pct: number
  dividend_income: number
  reinvested_dividends: number
  redeployable_cash: number | null
  reinvestment_data_complete: boolean
}

export interface SimHolding {
  symbol: string
  shares: number
  avg_cost: number
  total_cost: number
  currentPrice: number | null
  priceChange: number | null
  priceChangePct: number | null
  previousClose: number | null
  currentValue: number | null
  pnl: number | null
  pnlPct: number | null
  oldest_lot_date: string | null
}

export interface SimTransaction {
  id: number
  account_id: number
  symbol: string | null
  type: 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal'
  shares: number | null
  price: number | null
  amount: number
  fees: number
  txn_date: string
  notes: string | null
  created_at: string
  idempotency_key?: string | null
  reinvestment_mode?: 'cash' | 'drip' | null
  reinvested_shares?: number | null
}

export interface TaxPreview {
  symbol: string
  shares: number
  current_price: number
  proceeds: number
  cost_basis: number
  gross_gain: number
  short_term_gain: number
  short_term_tax: number
  long_term_gain: number
  long_term_tax: number
  total_tax: number
  after_tax_net_gain: number
  worth_selling: boolean
  breakeven_price: number
}

export interface SimReview {
  twr_pct?: number | null
  observed_drawdown_pct?: number | null
  performance_blockers?: string[]
  observation_count?: number
  starting_capital: number
  cash: number
  holdings_value: number | null
  total_value: number | null
  total_return_pct: number | null
  realized_pnl: number | null
  unrealized_pnl: number | null
  dividend_income: number
  reinvested_dividends: number
  cash_pct: number | null
  position_count: number
  largest_position: { symbol: string; weight_pct: number; market_value: number } | null
  closed_trade_count: number
  hit_rate_pct: number | null
  valuation_complete?: boolean
  missing_symbols?: string[]
  positions: Array<{ symbol: string; shares: number; cost: number; market_value: number | null; pnl: number | null; weight_pct: number | null }>
  recent_buffett_actions: Array<{ id: number; date: string; type: string; symbol: string | null; amount: number; notes: string }>
}

export interface SimReinvestmentSettings {
  dividend_reinvestment_mode: 'cash' | 'drip'
  profit_reinvestment_mode: 'hold_cash' | 'redeploy_excess'
  target_cash_pct: number
}

export interface SimDividendPayload {
  symbol: string
  amount: number
  price: number
  txn_date: string
  idempotency_key: string
  notes?: string
}

export interface TradePlanPayload {
  setup: string
  catalyst?: string
  thesis: string
  stop_price: number
  target_price: number
  invalidation?: string
}

export interface TradeJournalExitPayload {
  exit_reason: 'stop' | 'target' | 'time_exit' | 'thesis_break' | 'discretionary'
  thesis_valid: boolean
  mfe?: number
  mae?: number
  review_notes?: string
}

export interface TradePayload {
  type: 'buy' | 'sell'
  symbol: string
  shares: number
  /** @deprecated server validates its own quote; price is ignored on /api/simulator/trade */
  price?: number
  /** @deprecated server timestamps fills; txn_date is ignored on /api/simulator/trade */
  txn_date?: string
  fees?: number
  notes?: string
  trade_plan?: TradePlanPayload
  journal?: TradeJournalExitPayload
}

export interface SimRiskAlert {
  type: 'missing_plan' | 'plan_share_mismatch' | 'stop_breached' | 'target_hit' | 'price_unavailable' | 'stale_price' | 'orphan_plan'
  severity: 'critical' | 'warning' | 'info'
  symbol: string
  message: string
  current_price?: number
  threshold?: number
}

export interface SimRiskPosition {
  symbol: string
  shares: number | null
  avg_cost: number | null
  current_price: number | null
  quote_timestamp: string | null
  price_age_seconds: number | null
  market_state: string | null
  data_source: 'alpaca_iex' | 'alpaca_sip' | 'yfinance' | 'unavailable' | string
  plan: Record<string, unknown> | null
}

export interface SimRiskMonitor {
  read_only: true
  execution_enabled: false
  checked_at: string
  market_open: boolean
  alerts: SimRiskAlert[]
  positions: SimRiskPosition[]
}

export interface SimJournalSetupStats {
  trade_count: number
  win_rate_pct: number | null
  expectancy: number | null
  average_r: number | null
  total_pnl: number
}

export interface SimJournal {
  analytics: {
    closed_trade_count: number
    win_rate_pct: number | null
    expectancy: number | null
    profit_factor: number | null
    average_r: number | null
    total_pnl: number
    by_setup: Record<string, SimJournalSetupStats>
  }
  trades: Array<Record<string, unknown>>
}
