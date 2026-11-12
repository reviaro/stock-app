export type PortfolioPeriod = '1M' | '3M' | '1A'
export interface PaperHolding {
  symbol: string; qty: number; avgCost: number | null; price: number | null; value: number | null
  priceChange: number | null; priceChangePct: number | null
  unrealizedPnl: number | null; unrealizedPnlPct: number | null
  weightPct: number | null; managedQty: number; heldSince: string | null
}
export interface PaperFill {
  id: string; orderId: string | null; symbol: string; side: 'buy' | 'sell'
  qty: number; price: number; amount: number; date: string; reason: string | null; origin: string
}
export interface PaperPortfolio {
  environment: 'paper'; checkedAt: string; period: PortfolioPeriod
  cash: number; equity: number; cashPct: number | null; positions: PaperHolding[]
  unrealizedPnl: number | null; realizedPnl: number | null; realizedExitCount: number | null; winRatePct: number | null
  fifoAvailable: boolean; periodReturnPct: number | null; observedEquityDrawdownPct: number | null
  history: { date: string; equity: number; profitLoss: number | null; returnPct: number | null }[]
  trades: PaperFill[]; actions: PaperFill[]; fillHistoryComplete: boolean; fillsAvailable: boolean; warnings: string[]
}
