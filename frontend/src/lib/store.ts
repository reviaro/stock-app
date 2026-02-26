import { create } from 'zustand'

/**
 * Market pulse data for the three major indexes shown in the header.
 */
export interface MarketPulse {
  sp500: number
  nasdaq: number
  dow: number
}

/**
 * Global UI state managed by Zustand.
 *
 * - selectedTicker: the currently active stock symbol (drives all detail panels)
 * - setSelectedTicker: action to change the active symbol
 * - marketPulse: last-known major index prices for header display
 * - setMarketPulse: action to update index prices
 */
interface TickerStore {
  selectedTicker: string
  setSelectedTicker: (ticker: string) => void
  marketPulse: MarketPulse
  setMarketPulse: (pulse: MarketPulse) => void
}

export const useTickerStore = create<TickerStore>()((set) => ({
  selectedTicker: 'AAPL',

  setSelectedTicker: (ticker: string) =>
    set({ selectedTicker: ticker.toUpperCase() }),

  marketPulse: {
    sp500: 0,
    nasdaq: 0,
    dow: 0,
  },

  setMarketPulse: (pulse: MarketPulse) => set({ marketPulse: pulse }),
}))
