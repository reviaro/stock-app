import { useQuery } from '@tanstack/react-query'
import type { ApiResponse, MarketIndex, StockHistory, TechnicalIndicators } from '@/types'

/**
 * Fetches major market index prices from /api/market/indexes.
 * The response data is a record keyed by index symbol (e.g. "^GSPC", "^IXIC", "^DJI").
 *
 * NOTE: The plan specified /api/market but the actual backend route is
 * /api/market/indexes (market.js router registers GET /indexes, mounted at /api/market).
 */
async function fetchMarketData(): Promise<Record<string, MarketIndex>> {
  const response = await fetch('/api/market/indexes')
  if (!response.ok) {
    throw new Error(`Failed to fetch market data: ${response.statusText}`)
  }
  const json: ApiResponse<Record<string, MarketIndex>> = await response.json()
  if (json.status === 'error') {
    throw new Error(json.error ?? 'Unknown market data error')
  }
  return json.data ?? {}
}

/**
 * React Query hook to load major market index data.
 *
 * @returns TanStack Query result containing a record of MarketIndex by symbol
 */
export function useMarketData() {
  return useQuery({
    queryKey: ['marketData'],
    queryFn: fetchMarketData,
    staleTime: 60_000,   // 1 minute — indexes don't need sub-minute refresh
    retry: 1,
  })
}

/**
 * Fetches OHLCV historical price data for a given ticker symbol.
 * Endpoint: GET /api/stock/:symbol/history
 */
async function fetchStockHistory(symbol: string): Promise<StockHistory> {
  const response = await fetch(`/api/stock/${encodeURIComponent(symbol)}/history`)
  if (!response.ok) {
    throw new Error(`Failed to fetch history for ${symbol}: ${response.statusText}`)
  }
  const json: ApiResponse<StockHistory> = await response.json()
  if (json.status === 'error') {
    throw new Error(json.error ?? `Unknown error fetching history for ${symbol}`)
  }
  if (!json.data) {
    throw new Error(`No history data returned for ${symbol}`)
  }
  return json.data
}

/**
 * React Query hook to load historical OHLCV data for the active ticker.
 * Used by StockChart to populate the candlestick series.
 *
 * @param symbol - Stock ticker symbol (e.g. "AAPL")
 * @returns TanStack Query result containing StockHistory
 */
export function useStockHistory(symbol: string) {
  return useQuery({
    queryKey: ['stockHistory', symbol],
    queryFn: () => fetchStockHistory(symbol),
    staleTime: 5 * 60_000,  // 5 minutes — historical data doesn't change intraday
    retry: 1,
    enabled: Boolean(symbol),
  })
}

/**
 * Fetches technical indicator data for a given ticker symbol.
 * Endpoint: GET /api/stock/:symbol/technical
 */
async function fetchTechnicalData(symbol: string): Promise<TechnicalIndicators> {
  const response = await fetch(`/api/stock/${encodeURIComponent(symbol)}/technical`)
  if (!response.ok) {
    throw new Error(`Failed to fetch technical data for ${symbol}: ${response.statusText}`)
  }
  const json: ApiResponse<TechnicalIndicators> = await response.json()
  if (json.status === 'error') {
    throw new Error(json.error ?? `Unknown error fetching technical data for ${symbol}`)
  }
  if (!json.data) {
    throw new Error(`No technical data returned for ${symbol}`)
  }
  return json.data
}

/**
 * React Query hook to load technical indicator series for the active ticker.
 * Provides SMA 50, SMA 200, EMA 21, RSI, MACD, and Bollinger Bands chart arrays.
 *
 * @param symbol - Stock ticker symbol (e.g. "AAPL")
 * @returns TanStack Query result containing TechnicalIndicators
 */
export function useTechnicalData(symbol: string) {
  return useQuery({
    queryKey: ['technicalData', symbol],
    queryFn: () => fetchTechnicalData(symbol),
    staleTime: 5 * 60_000,  // 5 minutes — technical indicators are daily data
    retry: 1,
    enabled: Boolean(symbol),
  })
}
