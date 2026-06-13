export interface SimAccount {
  id: number
  name: string
  tax_bracket: number
  created_at: string
  cash: number
  total_value: number
  unrealized_pnl: number
  realized_pnl: number
}

export interface SimHolding {
  symbol: string
  shares: number
  avg_cost: number
  total_cost: number
  currentPrice: number | null
  currentValue: number | null
  pnl: number | null
  pnlPct: number | null
  oldest_lot_date: string | null
}

export interface SimTransaction {
  id: number
  account_id: number
  symbol: string | null
  type: 'buy' | 'sell' | 'deposit' | 'withdrawal'
  shares: number | null
  price: number | null
  amount: number
  fees: number
  txn_date: string
  notes: string | null
  created_at: string
}

export interface TaxPreview {
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

export interface TradePayload {
  type: 'buy' | 'sell'
  symbol: string
  shares: number
  price: number
  txn_date?: string
  fees?: number
  notes?: string
}
