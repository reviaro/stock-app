export interface AlpacaPaperSnapshot {
  clock: { timestamp: string; isOpen: boolean; nextOpen: string; nextClose: string }
  positions: Array<{ symbol: string; qty: string; avgEntryPrice: string; currentPrice: string; marketValue: string; unrealizedPnl: string; unrealizedPnlPct: string; side: string }>
  openOrders: Array<{ symbol: string; qty: string; side: string; type: string; timeInForce: string; limitPrice?: string; status: string; submittedAt: string }>
}

export interface AlpacaPaperStatus {
  configured: boolean
  environment: 'paper'
  baseUrl: 'https://paper-api.alpaca.markets'
  reason?: 'missing_paper_credentials'
  connection?: 'verified'
  accountStatus?: string
  cash?: string
  equity?: string
  portfolioValue?: string
  buyingPower?: string
  multiplier?: string
  orderEntryEnabled: boolean
}
