import type { PortfolioBreach } from './portfolio'

export interface RiskRules {
  id?: number
  max_position_pct: number
  max_sector_pct: number
  max_risk_per_trade_pct: number
  target_cash_pct: number
  updated_at?: string
}

export interface RiskPosition {
  symbol: string
  shares: number
  avg_cost: number
  currentPrice: number | null
  currentValue: number | null
  sector: string | null
  stop_loss: number | null
}

export interface RiskPayload {
  rules: RiskRules
  cash: number
  cashPct: number | null
  positions: RiskPosition[]
  breaches: PortfolioBreach[]
}
