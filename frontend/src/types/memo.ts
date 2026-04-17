export interface Memo {
  symbol: string
  thesis: string | null
  fair_value_low: number | null
  fair_value_high: number | null
  buy_below: number | null
  sell_rule: string | null
  invalidation: string | null
  risks: string | null
  conviction: number | null
  last_reviewed_at: string | null
  updated_at: string
  created_at: string
}

export type MemoInput = Partial<Omit<Memo, 'symbol' | 'updated_at' | 'created_at' | 'last_reviewed_at'>>