export type StrategyRunType = 'backtest' | 'out_of_sample' | 'paper'

export interface PromotionGate {
  ready: boolean
  blockers: string[]
}

export interface PromotionReadiness {
  paper: PromotionGate
  live: PromotionGate
}

export interface StrategyRun {
  id: number
  version_id: number
  run_type: StrategyRunType
  start_date: string
  end_date: string
  trade_count: number
  total_return_pct: number
  benchmark_return_pct: number
  max_drawdown_pct: number
  sharpe: number | null
  win_rate: number | null
  expectancy: number | null
  avg_r: number | null
  notes: string | null
}

export interface StrategyVersion {
  id: number
  experiment_id: number
  version_number: number
  rules: Record<string, unknown> | unknown[]
  notes: string | null
  runs: StrategyRun[]
  promotion_readiness: PromotionReadiness
}

export interface StrategyExperimentSummary {
  id: number
  name: string
  hypothesis: string
  created_at?: string
  updated_at?: string
}

export interface StrategyExperimentDetail extends StrategyExperimentSummary {
  versions: StrategyVersion[]
  promotion_readiness: PromotionReadiness
}

export interface CreateStrategyExperimentPayload {
  name: string
  hypothesis: string
}

export interface CreateStrategyVersionPayload {
  rules: Record<string, unknown> | unknown[]
  notes?: string
}

export interface CreateStrategyRunPayload {
  run_type: StrategyRunType
  start_date: string
  end_date: string
  trade_count: number
  total_return_pct: number
  benchmark_return_pct: number
  max_drawdown_pct: number
  sharpe?: number
  win_rate?: number
  expectancy?: number
  avg_r?: number
  notes?: string
}
