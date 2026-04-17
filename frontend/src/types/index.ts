/**
 * Shared TypeScript types for the stock dashboard.
 * Field names match exactly what the Express backend returns from the Python yfinance wrapper.
 */

/**
 * Full stock quote and fundamental data as returned by GET /api/stock/:symbol
 * Field names match yf_wrapper.py get_stock_info() output.
 */
export interface Stock {
  symbol: string
  name: string
  exchange: string
  sector: string
  industry: string
  currency: string
  price: number
  change: number
  changePercent: number   // backend field is "changePercent" (not "percentChange")
  volume: number
  avgVolume: number
  bid: number
  ask: number
  open: number
  previousClose: number
  dayHigh: number
  dayLow: number
  marketCap: number
  peRatio: number
  eps: number
  beta: number
  week52High: number
  week52Low: number
  dividendYield: number
  dividendRate: number
  exDividendDate: string | null
  sharesOutstanding: number
  float: number
  bookValue: number
  priceToBook: number
  profitMargin: number
  returnOnEquity: number
  revenue: number
  revenuePerShare: number
  grossProfit: number
  operatingCashflow: number
  freeCashflow: number
  forwardPE: number
  pegRatio: number
  enterpriseValue: number
  enterpriseToRevenue: number
  enterpriseToEbitda: number
  sma50: number
  sma200: number
  currentRatio: number
  quickRatio: number
  debtToEquity: number
}

export const BUCKETS = ['compounders', 'buy_soon', 'expensive', 'speculative', 'owned', 'unsorted'] as const
export type Bucket = typeof BUCKETS[number]

export const BUCKET_LABELS: Record<Bucket, string> = {
  compounders: 'Compounders',
  buy_soon: 'Buy-Soon',
  expensive: 'Expensive',
  speculative: 'Speculative',
  owned: 'Owned',
  unsorted: 'Unsorted',
}

/**
 * A saved watchlist row as returned by GET /api/watchlist.
 * The backend merges DB row (id, symbol, added_at, notes) with live stock data,
 * so WatchlistEntry extends Stock with the DB-specific fields.
 */
export interface WatchlistEntry extends Partial<Stock> {
  id?: number
  symbol: string
  name: string
  added_at?: string
  notes?: string
  bucket: Bucket
}

/**
 * Generic API response envelope used by all backend routes.
 * On success: { status: 'success', data: T }
 * On error:   { status: 'error', error: string }
 */
export interface ApiResponse<T> {
  status: 'success' | 'error'
  data?: T
  error?: string
  message?: string
}

/**
 * Market index data as returned by GET /api/market/indexes.
 * The response data is a record keyed by index symbol (e.g. "^GSPC").
 */
export interface MarketIndex {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  week52High: number
  week52Low: number
  volume: number
}

/**
 * Stock search result as returned by GET /api/watchlist/search/:query
 * and GET /api/stock/search/:query
 */
export interface StockSearchResult {
  symbol: string
  name: string
}

/**
 * CAN SLIM criterion score
 */
export interface CANSLIMCriterion {
  name: string
  score: number
  status: 'Pass' | 'Fail'
  value?: number
  pricePosition?: number
  volumeRatio?: number
}

/**
 * Full CAN SLIM analysis as returned by GET /api/stock/:symbol/analysis
 */
export interface CANSLIMAnalysis {
  symbol: string
  generatedAt: string
  overall: {
    score: number
    rating: 'Excellent' | 'Good' | 'Average' | 'Poor'
    passCount: number
    failCount: number
  }
  criteria: {
    C: CANSLIMCriterion
    A: CANSLIMCriterion
    N: CANSLIMCriterion
    S: CANSLIMCriterion
    L: CANSLIMCriterion
    I: CANSLIMCriterion
    M: CANSLIMCriterion
  }
}

/**
 * A single OHLCV data point from GET /api/stock/:symbol/history
 */
export interface OHLCVPoint {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Historical price data as returned by GET /api/stock/:symbol/history
 */
export interface StockHistory {
  symbol: string
  range: string
  interval: string
  data: OHLCVPoint[]
}

/**
 * Technical indicators as returned by GET /api/stock/:symbol/technical
 */
export interface TechnicalIndicators {
  symbol: string
  generatedAt: string
  current: {
    price: number
    rsi: number
    macd: { line: number; signal: number; histogram: number }
    sma: { '20': number; '50': number; '200': number }
    ema: { '12': number; '21': number; '26': number }
    bollingerBands: { upper: number; middle: number; lower: number }
    atr: number
  }
  interpretation: {
    rsi: 'Overbought' | 'Oversold' | 'Neutral'
    macd: 'Bullish' | 'Bearish'
    priceVsSma20: 'Above' | 'Below'
    priceVsSma50: 'Above' | 'Below'
    priceVsSma200: 'Above' | 'Below'
    priceVsBb: 'Upper Band' | 'Lower Band' | 'Middle'
  }
  charts: {
    rsi: number[]
    macd: { line: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] }
    bollingerBands: {
      upper: (number | null)[]
      middle: (number | null)[]
      lower: (number | null)[]
      price: (number | null)[]
    }
    sma50: (number | null)[]
    sma200: (number | null)[]
    ema21: (number | null)[]
  }
}
