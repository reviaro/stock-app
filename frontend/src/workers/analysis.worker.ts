import * as Comlink from 'comlink'
import type { WatchlistEntry } from '@/types'

/**
 * Sort criteria for watchlist entries.
 */
export type SortField = 'changePercent' | 'price' | 'volume' | 'symbol' | 'name'
export type SortDirection = 'asc' | 'desc'

export interface SortCriteria {
  field: SortField
  direction: SortDirection
}

/**
 * A rank entry computed for a set of watchlist items.
 */
export interface RankedEntry {
  symbol: string
  rank: number
  percentileRank: number
}

/**
 * Analysis service exposed via Comlink to the main thread.
 * All methods run on a background thread, off the main thread.
 */
const analysisService = {
  /**
   * Sort and optionally filter a list of watchlist entries.
   * Supports multi-criteria sorting: primary sort by `criteria[0]`, tiebreak by `criteria[1]`, etc.
   *
   * @param entries - Array of WatchlistEntry items to sort.
   * @param criteria - Ordered array of sort criteria.
   * @returns Sorted copy of the entries array.
   */
  sortEntries(entries: WatchlistEntry[], criteria: SortCriteria[]): WatchlistEntry[] {
    if (!entries || entries.length === 0) return []
    if (!criteria || criteria.length === 0) return [...entries]

    const sorted = [...entries].sort((a, b) => {
      for (const { field, direction } of criteria) {
        const aVal = a[field as keyof WatchlistEntry]
        const bVal = b[field as keyof WatchlistEntry]

        let cmp = 0

        if (typeof aVal === 'number' && typeof bVal === 'number') {
          cmp = aVal - bVal
        } else if (typeof aVal === 'string' && typeof bVal === 'string') {
          cmp = aVal.localeCompare(bVal)
        } else if (aVal == null && bVal != null) {
          cmp = 1 // nulls last
        } else if (aVal != null && bVal == null) {
          cmp = -1
        }

        if (cmp !== 0) {
          return direction === 'asc' ? cmp : -cmp
        }
      }
      return 0
    })

    return sorted
  },

  /**
   * Compute a percentile rank (1–99) for each entry based on a numeric field.
   * Useful for displaying RS Rating-style rankings within the watchlist.
   *
   * @param entries - Array of WatchlistEntry items to rank.
   * @param field - The numeric field to rank by.
   * @returns Array of RankedEntry objects in descending rank order.
   */
  calculateRanks(entries: WatchlistEntry[], field: SortField): RankedEntry[] {
    if (!entries || entries.length === 0) return []

    const withValues = entries
      .map((e) => ({ symbol: e.symbol, value: e[field as keyof WatchlistEntry] as number }))
      .filter((e) => typeof e.value === 'number' && isFinite(e.value))

    if (withValues.length === 0) return []

    // Sort ascending to compute percentile positions
    const sorted = [...withValues].sort((a, b) => a.value - b.value)
    const n = sorted.length

    const ranks: RankedEntry[] = sorted.map((item, idx) => {
      // Percentile rank: 1-99 scale (avoid 0 and 100)
      const percentileRank = Math.round(((idx + 1) / n) * 98) + 1
      return {
        symbol: item.symbol,
        rank: idx + 1,
        percentileRank: Math.min(99, Math.max(1, percentileRank)),
      }
    })

    // Return highest ranked first
    return ranks.reverse()
  },

  /**
   * Filter entries by a minimum change percent threshold.
   *
   * @param entries - Array of WatchlistEntry items to filter.
   * @param minChangePercent - Minimum changePercent value (inclusive).
   * @returns Filtered array of entries.
   */
  filterByMinChange(entries: WatchlistEntry[], minChangePercent: number): WatchlistEntry[] {
    if (!entries || entries.length === 0) return []
    return entries.filter((e) => (e.changePercent ?? 0) >= minChangePercent)
  },
}

Comlink.expose(analysisService)
