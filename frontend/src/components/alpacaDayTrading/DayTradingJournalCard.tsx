import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAlpacaDayTradingJournal } from '@/hooks/useAlpacaDayTrading'
import type { AlpacaDayTradeJournalEvent } from '@/types/alpacaDayTrading'

function money(value: number | null) {
  return value == null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function pct(value: number | null) {
  return value == null ? '—' : `${value.toFixed(1)}%`
}

function rMultiple(value: number | null) {
  return value == null ? '—' : `${value.toFixed(2)}R`
}

const OUTCOME_BAD = new Set(['rejected', 'failed', 'stalled', 'unresolved', 'refused'])
const OUTCOME_GOOD = new Set(['cleared', 'closed', 'acknowledged', 'activated'])

function eventBadgeVariant(event: AlpacaDayTradeJournalEvent): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (event.eventType === 'anomaly' || (event.eventType === 'kill_switch' && event.action === 'activate')) return 'destructive'
  if (event.outcome && OUTCOME_BAD.has(event.outcome)) return 'destructive'
  if (event.outcome && OUTCOME_GOOD.has(event.outcome)) return 'default'
  return 'secondary'
}

function eventSymbol(event: AlpacaDayTradeJournalEvent): string | null {
  const symbol = (event.detail as { symbol?: unknown } | null)?.symbol
  return typeof symbol === 'string' ? symbol : null
}

function eventBrokerCode(event: AlpacaDayTradeJournalEvent): number | string | null {
  const detail = event.detail as { broker_code?: unknown; brokerCode?: unknown } | null
  const code = detail?.broker_code ?? detail?.brokerCode
  return (typeof code === 'number' || typeof code === 'string') && code ? code : null
}

function eventBrokerMessage(event: AlpacaDayTradeJournalEvent): string | null {
  const detail = event.detail as { broker_message?: unknown; brokerMessage?: unknown } | null
  const message = detail?.broker_message ?? detail?.brokerMessage
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

type JournalSourceFilter = 'all' | 'semantic' | 'order_audit' | 'fill'

const SOURCE_FILTER_LABELS: Record<JournalSourceFilter, string> = {
  all: 'All events',
  semantic: 'Decisions & reviews',
  order_audit: 'Orders',
  fill: 'Fills',
}

// Newest first, like a log -- the backend returns events in chronological (ascending) order
// because that's also what a plan's own fill/order history needs, but an operator scanning
// this card wants to see what just happened without scrolling past the whole day first.
function JournalTimeline({ events }: { events: AlpacaDayTradeJournalEvent[] }) {
  const [sourceFilter, setSourceFilter] = useState<JournalSourceFilter>('all')
  const filtered = sourceFilter === 'all' ? events : events.filter((event) => event.source === sourceFilter)
  const mostRecentFirst = [...filtered].reverse()

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
        <select
          aria-label="Filter timeline by event source"
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value as JournalSourceFilter)}
        >
          {(Object.keys(SOURCE_FILTER_LABELS) as JournalSourceFilter[]).map((key) => (
            <option key={key} value={key}>{SOURCE_FILTER_LABELS[key]}</option>
          ))}
        </select>
      </div>
      {mostRecentFirst.length === 0 ? (
        <p className="text-xs text-muted-foreground">No journal events recorded yet.</p>
      ) : (
        <ol className="max-h-96 space-y-1.5 overflow-y-auto text-xs">
          {mostRecentFirst.map((event, index) => {
            const symbol = eventSymbol(event)
            return (
              <li key={event.eventKey ?? `${event.source}-${event.occurredAt}-${index}`} className="rounded-md border border-border/70 bg-background/60 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-muted-foreground">{new Date(event.occurredAt).toLocaleString()}</span>
                  <Badge variant={eventBadgeVariant(event)}>{event.eventType}</Badge>
                  {symbol && <span className="font-medium">{symbol}</span>}
                  {event.action && <span className="text-muted-foreground">{event.action}</span>}
                  {event.outcome && <span className="font-medium">{event.outcome}</span>}
                </div>
                {event.reason && <p className="mt-1 text-muted-foreground">{event.reason}</p>}
                {eventBrokerMessage(event) && (
                  <p className="mt-1 text-destructive font-mono text-[11px]">
                    {eventBrokerCode(event)
                      ? `Broker ${eventBrokerCode(event)}: ${eventBrokerMessage(event)}`
                      : `Broker: ${eventBrokerMessage(event)}`}
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

export function DayTradingJournalCard() {
  const { data: journal, isLoading, isError } = useAlpacaDayTradingJournal()
  const analytics = journal?.analytics

  return (
    <Card aria-label="Alpaca Day Trading journal analytics">
      <CardHeader className="pb-2"><CardTitle><h2>Day Trading journal</h2></CardTitle></CardHeader>
      <CardContent className="space-y-4 px-3 pb-4">
        {isLoading && <p className="text-xs text-muted-foreground">Loading journal…</p>}
        {isError && <p className="text-xs text-destructive">Journal analytics unavailable.</p>}
        {analytics && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
              <Metric label="Closed trades" value={String(analytics.closed_trade_count)} />
              <Metric label="Win rate" value={pct(analytics.win_rate_pct)} />
              <Metric label="Expectancy" value={money(analytics.expectancy)} />
              <Metric label="Average R" value={rMultiple(analytics.average_r)} />
              <Metric label="Profit factor" value={analytics.profit_factor == null ? '—' : analytics.profit_factor.toFixed(2)} />
              <Metric label="Total P&L" value={money(analytics.total_pnl)} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">By setup</p>
              {Object.keys(analytics.by_setup).length === 0 ? (
                <p className="text-xs text-muted-foreground">No closed Day Trading plans yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead className="bg-secondary/60 text-muted-foreground"><tr><th className="px-2 py-1.5 text-left">Setup</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Avg R</th><th>Total P&L</th></tr></thead>
                    <tbody>
                      {Object.entries(analytics.by_setup).map(([setup, stats]) => (
                        <tr key={setup} className="border-t border-border/60">
                          <td className="px-2 py-1.5 font-medium">{setup}</td>
                          <td className="text-center">{stats.trade_count}</td>
                          <td className="text-center">{pct(stats.win_rate_pct)}</td>
                          <td className="text-center font-mono">{money(stats.expectancy)}</td>
                          <td className="text-center font-mono">{rMultiple(stats.average_r)}</td>
                          <td className="text-center font-mono">{money(stats.total_pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <JournalTimeline events={journal?.events ?? []} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">{label}</p><p className="font-mono font-semibold">{value}</p></div>
}
