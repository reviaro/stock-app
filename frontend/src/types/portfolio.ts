export interface PortfolioBreach {
  kind: 'position' | 'sector' | 'risk_per_trade' | 'cash_below_target'
  symbol?: string
  sector?: string
  actual: number
  limit: number
  message: string
}

export interface PortfolioPosition {
  currentPrice: number | null
  currentValue: number | null
  avg_cost: number
  total_cost: number
  dividends_received: number
  symbol: string
  name: string
  shares: number
  sector: string | null
  stop_loss: number | null
  pnl: number | null
  pnlPct: number | null
  breaches: PortfolioBreach[]
}

export interface PortfolioSummary {
  cash: number
  cashPct: number | null
  holdingsValue: number
  totalValue: number
  realizedPnl: number
  unrealizedPnl: number
}

export interface PortfolioTransaction {
  id: number
  symbol: string | null
  type: 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal'
  shares: number | null
  price: number | null
  amount: number
  fees: number
  txn_date: string
  notes: string | null
}

export interface PortfolioResponse {
  summary: PortfolioSummary
  holdings: PortfolioPosition[]
  recentTransactions: PortfolioTransaction[]
  breaches?: PortfolioBreach[]
  rules?: {
    max_position_pct: number
    max_sector_pct: number
    max_risk_per_trade_pct: number
    target_cash_pct: number
  } | null
}

export interface TransactionPayload {
  type: 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal'
  symbol?: string
  shares?: number
  price?: number
  amount?: number
  fees?: number
  txn_date: string
  notes?: string
}
