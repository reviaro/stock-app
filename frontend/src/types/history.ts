export interface SnapshotEntry {
  id: number
  symbol: string
  slot: string
  market_date: string
  captured_at: string
  quote_timestamp: string | null
  price: number
  previous_close: number | null
  change_amount: number | null
  change_percent: number | null
  open_price: number | null
  day_high: number | null
  fifty_two_week_high: number | null
  fifty_two_week_low: number | null
  change_from_open_percent: number | null
  gap_apr22_percent: number | null
  dist_from_52wh_percent: number | null
  dist_from_52wl_percent: number | null
  currency: string
  source: string
  is_market_closed: number
  is_carry_forward: number
  raw_payload: string | null
}

export interface SnapshotGroup {
  symbol: string
  history: SnapshotEntry[]
}
