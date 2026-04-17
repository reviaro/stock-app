export interface PortfolioPosition {
  id: number
  symbol: string
  name: string
  shares: number
  buy_price: number
  buy_date: string | null
  notes: string | null
  currentPrice: number | null
  currentValue: number | null
  costBasis: number
  pnl: number | null
  pnlPct: number | null
  created_at: string
}

export interface AddPositionPayload {
  symbol: string
  shares: number
  buy_price: number
  buy_date?: string
  notes?: string
}
