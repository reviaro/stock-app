import type { CreateStrategyRunPayload } from './strategyLab'

export interface PortfolioLabRequest {
  symbols: string[]
  current_weights_pct: Record<string, number>
  cash_target_pct: number
  max_position_pct: number
  max_sector_pct: number
  transaction_cost_bps: number
  lookback_years: number
  train_days: number
  test_days: number
}

export interface PortfolioLabMetrics {
  total_return_pct: number
  benchmark_return_pct: number
  annualized_return_pct: number
  annualized_volatility_pct: number
  max_drawdown_pct: number
  sharpe: number
  turnover_pct: number
  transaction_cost_pct: number
}

export interface PortfolioLabWeight {
  symbol: string
  sector: string
  weight_pct: number
}

export interface PortfolioLabModel {
  id: 'equal_weight' | 'inverse_volatility' | 'hrp' | 'minimum_variance' | 'cvar' | string
  name: string
  status: 'success' | 'error'
  error?: string
  target_weights: PortfolioLabWeight[]
  cash_weight_pct?: number
  max_position_pct?: number
  concentration_hhi?: number
  constraint_handling?: 'native_optimization' | 'post_optimization_projection'
  current_target_turnover_pct?: number | null
  out_of_sample?: PortfolioLabMetrics
  strategy_lab_evidence?: CreateStrategyRunPayload
}

export interface PortfolioLabResult {
  read_only: true
  execution_enabled: false
  generated_at: string
  engine: { name: 'skfolio'; version: '0.20.2' }
  symbols: string[]
  sectors: Record<string, string>
  history: { start_date: string; end_date: string; daily_price_rows: number }
  validation: {
    method: 'rolling_walk_forward'
    train_days: number
    test_days: number
    fold_count: number
    fold_lengths_days: number[]
    includes_partial_final_fold: boolean
    out_of_sample_start: string
    out_of_sample_end: string
  }
  constraints: {
    cash_target_pct: number
    max_position_pct: number
    max_sector_pct: number
    transaction_cost_bps: number
  }
  benchmark_model_id: string
  data_quality: {
    provider: 'yfinance'
    auto_adjust: true
    alignment: 'complete_shared_trading_days'
    forward_filled_prices: 0
    dropped_incomplete_rows: 0
  }
  models: PortfolioLabModel[]
  warnings: string[]
}
