import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EarningsReview } from '@/components/EarningsReview'
import { useTickerStore } from '@/lib/store'
import { monitorDate, monitorRequest, sourceUrl } from '@/lib/researchMonitor'
import type { MonitorOverview, PriceAlert } from '@/types/researchMonitor'

const field = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const conditionLabel = { above: 'At or above', below: 'At or below', pct_up: 'Daily gain of', pct_down: 'Daily loss of' }

export function ResearchMonitorPage() {
  const client = useQueryClient()
  const selectedTicker = useTickerStore(s => s.selectedTicker)
  const [symbol, setSymbol] = useState(selectedTicker || '')
  const [symbolInput, setSymbolInput] = useState(selectedTicker || '')
  const [filterSymbol, setFilterSymbol] = useState('')
  const [kind, setKind] = useState('')
  const [includeReviewed, setIncludeReviewed] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [condition, setCondition] = useState<PriceAlert['condition']>('below')
  const [threshold, setThreshold] = useState('')
  const [label, setLabel] = useState('')
  const [repeat, setRepeat] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const params = new URLSearchParams({ ...(filterSymbol ? { symbol: filterSymbol } : {}), ...(kind ? { kind } : {}),
    ...(includeReviewed ? { includeReviewed: '1' } : {}), ...(cursor ? { before: String(cursor) } : {}) })
  const query = useQuery({ queryKey: ['research-monitor', params.toString()], queryFn: () => monitorRequest<MonitorOverview>(`?${params}`), refetchInterval: 30_000, retry: 1 })
  const data = query.data
  const busy = Boolean(pending)
  const visibleUnread = data?.events.filter(event => !event.reviewedAt).map(event => event.id) || []
  const issues = data?.symbols.filter(row => Object.values(row.status).some(Boolean)) || []

  async function act(name: string, task: () => Promise<unknown>, success: string, onSuccess?: () => void) {
    setPending(name); setError(''); setMessage('')
    try {
      await task(); onSuccess?.(); setMessage(success)
      await Promise.all([client.invalidateQueries({ queryKey: ['research-monitor'] }), client.invalidateQueries({ queryKey: ['monitor-earnings'] })])
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete this action. Please retry.') }
    finally { setPending('') }
  }
  function chooseSymbol(value: string, revealEarnings = false) {
    setSymbol(value); setSymbolInput(value)
    if (revealEarnings) document.getElementById('monitor-earnings-review')?.scrollIntoView?.({ block: 'start' })
  }

  return <main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6">
    <div className="mx-auto max-w-[1440px] space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Research monitor</p>
          <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Since your last review</h1>
          <p className="mt-2 text-sm text-muted-foreground">New headlines, company filings and price levels across your watchlist, portfolio ledger and active alerts.</p>
        </div>
        <Button variant="outline" disabled={busy || data?.checking} onClick={() => void act('check', () => monitorRequest('/check', {}), 'Research check complete. Source gaps are listed below.')}>
          <RefreshCw size={15} className={pending === 'check' || data?.checking ? 'animate-spin motion-reduce:animate-none' : ''} />
          {pending === 'check' || data?.checking ? 'Checking sources…' : 'Check now'}
        </Button>
      </header>

      <div className="flex flex-wrap gap-x-6 gap-y-2 border-y border-border py-3 text-sm">
        <span><strong className="font-semibold">{data?.unread ?? '—'}</strong> awaiting review</span>
        <span className="text-muted-foreground">{data?.tracked.length ?? '—'} symbols followed</span>
        <span className="text-muted-foreground">Checks every 15 minutes while Oakline runs</span>
        <span className="text-muted-foreground">In-app notifications</span>
      </div>
      {(error || query.error) && <p role="alert" className="text-sm text-destructive">{error || query.error?.message}</p>}
      {message && <p role="status" className="text-sm text-primary">{message}</p>}
      {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading your research inbox…</p>}
      {data && <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer py-1">Source coverage · {issues.length ? `${issues.length} symbols with gaps` : data.symbols.length ? 'No gaps at last check' : 'Not checked yet'}</summary>
        <p className="mt-2 max-w-3xl">The first check collects available news and filings from the last 14 days. Provider feeds may be incomplete. Price alerts require a dated USD quote no more than 20 minutes old; after-hours prices may be too old. Category tags describe topics, not their investment impact.</p>
        {data.tracked.length > data.symbols.length && <p className="mt-2">Some followed symbols have not been checked yet.</p>}
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">{data.symbols.map(row => <li key={row.symbol}><strong className="text-foreground">{row.symbol}</strong> · {monitorDate(row.checkedAt)}<br />{Object.values(row.status).filter(Boolean).join(' ') || 'News, filings and quote checks available.'}</li>)}</ul>
      </details>}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
        <section aria-label="Research inbox" className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Review inbox</h2>
            <Button size="sm" variant="ghost" disabled={busy || visibleUnread.length === 0} onClick={() => void act('review', () => monitorRequest('/reviewed', { ids: visibleUnread }), 'Displayed items marked reviewed.')}><Check size={14} />Mark displayed reviewed</Button>
          </div>
          <div className="my-4 flex flex-wrap items-end gap-3">
            <label className="text-xs">Symbol<select className={field} value={filterSymbol} onChange={e => { setFilterSymbol(e.target.value); setCursor(null) }}><option value="">All symbols</option>{[...new Set([...(data?.tracked || []), ...(data?.events.map(e => e.symbol) || []), filterSymbol])].filter(Boolean).sort().map(s => <option key={s}>{s}</option>)}</select></label>
            <label className="text-xs">Event<select className={field} value={kind} onChange={e => { setKind(e.target.value); setCursor(null) }}><option value="">All events</option><option value="news">News</option><option value="filing">Filings</option><option value="earnings">Earnings</option><option value="price">Price alerts</option></select></label>
            <label className="flex min-h-10 items-center gap-2 text-xs"><input type="checkbox" checked={includeReviewed} onChange={e => { setIncludeReviewed(e.target.checked); setCursor(null) }} />Include reviewed</label>
          </div>
          {data && data.events.length === 0 && <div className="border-y border-dashed border-border py-10">
            <p className="text-sm font-medium">{data.tracked.length ? 'No items in this view.' : 'Start with a company you follow.'}</p>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">{data.tracked.length ? 'Check for updates or include reviewed items. An empty inbox does not rule out material news.' : 'Add a stock to your watchlist or create a price alert, then check for updates. Your portfolio ledger holdings are followed automatically.'}</p>
          </div>}
          <ol className="divide-y divide-border border-t border-border lg:max-h-[44rem] lg:overflow-y-auto lg:pr-2">{data?.events.map(event => <li key={event.id} className="py-4">
            <div className="flex items-start gap-3">
              <button className="shrink-0 rounded border border-border px-2 py-1 text-xs font-semibold text-primary hover:border-primary" onClick={() => chooseSymbol(event.symbol, true)} aria-label={`Review ${event.symbol} earnings`}>{event.symbol}</button>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{event.detail.category || event.kind}</span><span>· {monitorDate(event.publishedAt)}</span>{event.reviewedAt && <span>· Reviewed</span>}</div>
                {sourceUrl(event.url) ? <a href={sourceUrl(event.url)} target="_blank" rel="noreferrer" className="break-words text-sm font-medium leading-relaxed hover:text-primary hover:underline">{event.title}</a> : <p className="break-words text-sm font-medium leading-relaxed">{event.title}</p>}
                {event.detail.publisher && <p className="mt-1 text-xs text-muted-foreground">{event.detail.publisher}</p>}
                {event.kind === 'price' && <p className="mt-2 text-xs text-muted-foreground">{event.detail.label && `${event.detail.label} · `}Observed ${event.detail.price?.toFixed(2)}{event.detail.changePct != null ? ` · ${event.detail.changePct.toFixed(2)}% from previous close` : ''}. Review your thesis before acting.</p>}
                {event.detail.changes?.map(text => <p key={text} className="mt-1 text-xs text-muted-foreground">{text}</p>)}
              </div>
              {!event.reviewedAt && <button disabled={busy} className="shrink-0 rounded p-2 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-50" aria-label={`Mark reviewed: ${event.title}`} onClick={() => void act('review', () => monitorRequest('/reviewed', { ids: [event.id] }), 'Item marked reviewed.')}><Check size={16} /></button>}
            </div>
          </li>)}</ol>
          <div className="mt-3 flex gap-2">
            {cursor && <Button variant="ghost" size="sm" onClick={() => setCursor(null)}>Newest items</Button>}
            {data?.nextCursor && <Button variant="outline" size="sm" onClick={() => setCursor(data.nextCursor)}>Earlier items</Button>}
          </div>
        </section>

        <aside className="min-w-0 space-y-6 lg:border-l lg:border-border lg:pl-8" aria-label="Company and price alerts">
          <section>
            <h2 className="text-lg font-semibold">Company to review</h2>
            <form className="mt-3 flex items-end gap-2" onSubmit={e => { e.preventDefault(); chooseSymbol(symbolInput.trim().toUpperCase()) }}>
              <label className="min-w-0 flex-1 text-xs">Stock or ETF symbol<input className={field} required pattern="[A-Za-z][A-Za-z0-9.\-]{0,14}" maxLength={15} value={symbolInput} onChange={e => setSymbolInput(e.target.value.toUpperCase())} placeholder="AAPL" /></label>
              <Button type="submit" variant="outline">Open</Button>
            </form>
            {symbol && <p className="mt-2 text-xs text-muted-foreground">Showing {symbol}. <a className="text-primary underline underline-offset-4" href="#monitor-earnings-review">Jump to earnings review</a></p>}
          </section>
          <section className="border-t border-border pt-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><Bell size={17} />Price alerts {symbol && <span className="text-primary">{symbol}</span>}</h2>
            <p className="mt-2 text-xs text-muted-foreground">Receive an inbox item when a level is observed. Alerts do not submit orders.</p>
            <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); void act('create', () => monitorRequest('/alerts', { symbol, condition, threshold: Number(threshold), repeat, label }), 'Price alert created. It will be evaluated at the next check.', () => { setThreshold(''); setLabel('') }) }}>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">Condition<select className={field} value={condition} onChange={e => setCondition(e.target.value as PriceAlert['condition'])}>{Object.entries(conditionLabel).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
                <label className="text-xs">{condition.startsWith('pct_') ? 'Change (%)' : 'Price (USD)'}<input className={field} type="number" required min="0.0001" max={condition.startsWith('pct_') ? 1000 : 1e9} step="any" value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
              </div>
              <label className="block text-xs">Label (optional)<input className={field} maxLength={120} value={label} onChange={e => setLabel(e.target.value)} placeholder="Thesis review level" /></label>
              <label className="flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} />{condition.startsWith('pct_') ? 'Repeat at most once per market date' : 'Repeat after price moves away and reaches the level again'}</label>
              <Button type="submit" disabled={busy || !symbol}>{pending === 'create' ? 'Saving…' : 'Create alert'}</Button>
            </form>
            <div className="mt-5 border-t border-border pt-4">
              <Button variant="outline" size="sm" disabled={busy || !symbol} onClick={() => void act('import', () => monitorRequest('/alerts/import-memo', { symbol }), 'Saved memo price levels imported. Unchanged alerts keep their current state.')}>Import saved memo levels</Button>
              <p className="mt-2 text-xs text-muted-foreground">Uses {symbol || 'the selected company’s'} saved buy-below and trim-above prices. Import again after changing a memo to update its levels.</p>
            </div>
          </section>
          <section className="border-t border-border pt-5">
            <h3 className="text-sm font-semibold">Saved alerts <span className="font-normal text-muted-foreground">({data?.alerts.length || 0})</span></h3>
            {data?.alerts.length === 0 && <p className="mt-3 text-xs text-muted-foreground">Create a level or import one from a saved research memo.</p>}
            <ul className="mt-3 max-h-[32rem] divide-y divide-border overflow-y-auto">{data?.alerts.map(alert => <li key={alert.id} className="py-3 first:pt-0">
              <p className="text-sm"><button className="font-semibold text-primary hover:underline" onClick={() => chooseSymbol(alert.symbol)}>{alert.symbol}</button> · {conditionLabel[alert.condition]} {alert.condition.startsWith('pct_') ? `${alert.threshold}%` : `$${alert.threshold}`}</p>
              <p className="mt-1 text-xs text-muted-foreground">{alert.label && `${alert.label} · `}{!alert.enabled ? 'Paused' : !alert.repeat && alert.state.armed === false ? 'Triggered · reset to watch again' : alert.repeat ? 'Repeating' : 'Watching once'}</p>
              <div className="mt-2 flex gap-2">{[alert.enabled ? 'disable' : 'enable', 'reset', 'delete'].map(action => <button key={action} disabled={busy} className="rounded border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-50" onClick={() => void act(action, () => monitorRequest(`/alerts/${encodeURIComponent(alert.id)}/${action}`, {}), action === 'delete' ? 'Alert removed. Previous notifications remain in your inbox.' : 'Alert updated.')}>{action === 'disable' ? 'Pause' : action === 'enable' ? 'Resume' : action === 'reset' ? 'Reset' : 'Remove'}</button>)}</div>
            </li>)}</ul>
          </section>
        </aside>
      </div>
      <EarningsReview symbol={symbol} />
    </div>
  </main>
}
