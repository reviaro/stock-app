import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useV2Journal } from '@/hooks/useAlpacaDayTradingV2'
import type { AlpacaV2Event } from '@/types/alpacaDayTrading'
import { time } from './v2Format'

const FILTERS = {
  all: 'All events',
  decision: 'NO TRADE decisions',
  submission: 'Submissions',
  fill: 'Fills',
  time_exit: 'Time exits',
  closure: 'Closures',
  review: 'Reviews',
  anomaly: 'Attention',
} as const
type Filter = keyof typeof FILTERS

function variant(event: AlpacaV2Event): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (event.type === 'anomaly' || event.outcome === 'rejected' || event.outcome === 'refused') return 'destructive'
  if (event.type === 'closure' || event.type === 'fill') return 'default'
  if (event.type === 'decision') return 'outline'
  return 'secondary'
}

function describe(event: AlpacaV2Event) {
  const d = event.detail || {}
  const parts: string[] = []
  if (d.symbol) parts.push(String(d.symbol))
  if (d.qty != null && d.price != null) parts.push(`${d.qty} @ ${d.price}`)
  if (d.realized_pnl != null) parts.push(`P&L ${d.realized_pnl}`)
  if (d.from && d.to) parts.push(`${d.from} → ${d.to}`)
  if (d.notes) parts.push(String(d.notes))
  return parts.join(' · ')
}

export function V2DecisionJournalCard() {
  const { data, isLoading, isError } = useV2Journal()
  const [filter, setFilter] = useState<Filter>('all')
  const events = [...(data?.events ?? [])].filter((event) => filter === 'all' || event.type === filter).reverse()
  return (
    <section aria-label="Decision journal">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle><h2>Decision journal</h2></CardTitle>
          <select aria-label="Filter journal events" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs">
            {(Object.keys(FILTERS) as Filter[]).map((key) => <option key={key} value={key}>{FILTERS[key]}</option>)}
          </select>
        </CardHeader>
        <CardContent className="px-3 pb-4 text-xs">
          {isLoading && <p className="text-muted-foreground">Loading journal…</p>}
          {isError && <p className="text-destructive">Unable to load the journal.</p>}
          {data && events.length === 0 && <p className="text-muted-foreground">No journal events yet.</p>}
          <ol className="max-h-96 space-y-1 overflow-y-auto">
            {events.map((event, index) => (
              <li key={`${event.occurredAt}-${index}`} className="flex flex-wrap items-center gap-2 border-b border-border/50 py-1">
                <span className="w-28 shrink-0 font-mono text-muted-foreground">{time(event.occurredAt)}</span>
                <Badge variant={variant(event)}>{event.type.replace(/_/g, ' ')}</Badge>
                <span className="font-medium">{(event.action ?? '').replace(/_/g, ' ')}</span>
                {event.reasonCode && <span className="font-mono text-muted-foreground">{event.reasonCode}</span>}
                <span className="text-muted-foreground">{describe(event)}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </section>
  )
}
