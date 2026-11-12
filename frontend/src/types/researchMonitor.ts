export interface MonitorEvent {
  id: number; symbol: string; kind: 'news' | 'filing' | 'earnings' | 'price'; title: string
  url: string | null; publishedAt: string | null; createdAt: string; reviewedAt: string | null
  detail: { category?: string; publisher?: string; source?: string; label?: string; price?: number; changePct?: number | null; changes?: string[] }
}
export interface PriceAlert {
  id: string; symbol: string; condition: 'above' | 'below' | 'pct_up' | 'pct_down'; threshold: number
  repeat: boolean; label: string; enabled: boolean; source: string
  state: { armed?: boolean; triggerCount?: number; lastDay?: string }
}
export interface MonitorOverview {
  events: MonitorEvent[]; unread: number; nextCursor: number | null; tracked: string[]; alerts: PriceAlert[]
  symbols: { symbol: string; checkedAt: string; status: { news: string | null; filings: string | null; price: string | null } }[]
  checking: boolean; intervalMinutes: number
}
export interface EarningsFact { value: number; start: string; end: string; filed: string; derived: boolean; url: string | null; tag: string }
export interface EarningsReport {
  asOf: string; source: string; currency: string; changes: string[]; warnings: string[]; limitations: string[]
  latestReport: { form: string; url: string | null; filedAt: string } | null
  earningsRelease: { url: string; exhibitUrl: string | null; filedAt: string } | null
  rows: { end: string; start: string; revenueYoY: number | null; epsYoY: number | null; operatingMargin: number | null; netMargin: number | null
    metrics: Record<'revenue' | 'grossProfit' | 'operatingIncome' | 'netIncome' | 'eps', EarningsFact | null> }[]
}
export interface EarningsResponse { report: EarningsReport | null; checkedAt: string | null; status: string | null }
