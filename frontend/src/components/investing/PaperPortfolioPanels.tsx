import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { paperInvestingRequest } from '@/hooks/useAlpacaPaperInvesting'
import { paperFillsCsv } from '@/lib/paperPortfolio'
import type { PaperPortfolio, PortfolioPeriod } from '@/types/alpacaPortfolio'

const money = (n: number | null) => n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const number = (n: number | null, digits = 2) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits })
const pct = (n: number | null) => n == null ? '—' : `${number(n)}%`
const move = (n: number | null) => n == null ? 'text-muted-foreground' : n >= 0 ? 'text-positive' : 'text-negative'
const signedMoney = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+' : ''}${money(n)}`
const date = (stamp: string) => new Date(stamp).toLocaleDateString()
const inputClass = 'min-h-11 min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm'
const periods: Record<PortfolioPeriod, string> = { '1M': '1 month', '3M': '3 months', '1A': '1 year' }
function held(since: string | null, asOf: string) {
  if (!since) return '—'
  const days = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(since)) / 86_400_000))
  return days >= 365 ? `${Math.floor(days / 365)}y ${days % 365}d` : `${days}d`
}

function EquityChart({ data }: { data: PaperPortfolio }) {
  const rows = data.history
  if (!rows.length) return <p className="text-sm text-muted-foreground">No broker equity observations available for this period.</p>
  const low = Math.min(...rows.map(p => p.equity)), high = Math.max(...rows.map(p => p.equity))
  const start = Date.parse(rows[0].date), end = Date.parse(rows.at(-1)!.date)
  const x = (stamp: string) => 8 + (Date.parse(stamp) - start) / (end - start || 1) * 624
  const y = (equity: number) => high === low ? 80 : 152 - (equity - low) / (high - low) * 144
  return <div className="min-w-0">
    <div className="mt-2 flex min-w-0 gap-2">
    <div aria-hidden="true" className={`flex shrink-0 flex-col py-1 text-right text-[11px] tabular-nums text-muted-foreground ${high === low ? 'justify-center' : 'justify-between'}`}><span>{money(high)}</span>{high !== low && <span>{money(low)}</span>}</div>
    <svg role="img" aria-label={`Alpaca paper account equity over ${periods[data.period]}; ${rows.length} daily observations. Values available in the table below.`} viewBox="0 0 640 160" preserveAspectRatio="none" className="h-40 min-w-0 flex-1 text-primary">
      {[high, ...(high === low ? [] : [low])].map(value => <g key={value}>
        <line x1="8" y1={y(value)} x2="632" y2={y(value)} className="stroke-border" vectorEffect="non-scaling-stroke" />
      </g>)}
      <polyline fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" points={rows.map(p => `${x(p.date)},${y(p.equity)}`).join(' ')} />
      {rows.length === 1 && <circle cx={x(rows[0].date)} cy={y(rows[0].equity)} r="3" fill="currentColor" />}
    </svg>
    </div>
    <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground"><span>{date(rows[0].date)}</span><span>{date(rows.at(-1)!.date)}</span></div>
    <details className="mt-2 text-xs"><summary className="cursor-pointer py-2 text-muted-foreground">View equity observations</summary>
      <div className="max-h-56 overflow-auto" tabIndex={0} role="region" aria-label="Daily equity observations"><table className="w-full text-right tabular-nums"><caption className="sr-only">Broker daily equity and P&amp;L for the selected period</caption>
        <thead><tr>{['Date', 'Equity', 'Broker P&L', 'Broker P&L %'].map(label => <th scope="col" className="py-2 first:text-left" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(p => <tr className="border-t border-border" key={p.date}><th scope="row" className="py-2 text-left font-normal">{date(p.date)}</th><td>{money(p.equity)}</td><td>{money(p.profitLoss)}</td><td>{pct(p.returnPct)}</td></tr>)}</tbody>
      </table></div>
    </details>
  </div>
}

function PortfolioContent({ data }: { data: PaperPortfolio }) {
  const [symbol, setSymbol] = useState(''), [side, setSide] = useState('all'), [limit, setLimit] = useState(20)
  const trades = data.trades.filter(t => (!symbol || t.symbol.includes(symbol.toUpperCase())) && (side === 'all' || t.side === side))
  const largest = data.positions.filter(p => p.weightPct !== null).reduce<PaperPortfolio['positions'][number] | null>((a, p) => !a || p.weightPct! > a.weightPct! ? p : a, null)
  const metrics = [
    { label: `Broker P&L · ${periods[data.period]}`, value: pct(data.periodReturnPct), change: data.periodReturnPct },
    { label: 'Cash', value: pct(data.cashPct) }, { label: 'Total value', value: money(data.equity) },
    { label: 'Unrealized', value: signedMoney(data.unrealizedPnl), change: data.unrealizedPnl },
    { label: 'Realized · FIFO estimate', value: signedMoney(data.realizedPnl), change: data.realizedPnl },
    { label: 'Positions', value: String(data.positions.length) },
    { label: 'Realized exits · estimated', value: number(data.realizedExitCount, 0) },
    { label: 'Win rate · estimated', value: pct(data.winRatePct) },
    { label: 'Largest', value: largest ? `${largest.symbol} ${pct(largest.weightPct)}` : '—' },
  ]
  function download() {
    const url = URL.createObjectURL(new Blob([paperFillsCsv(trades)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'alpaca-paper-fills.csv'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <>
    {data.warnings.map(warning => <p role="status" className="text-sm text-warning" key={warning}>{warning}</p>)}
    <Card className="min-w-0">
      <CardHeader className="pb-2"><CardTitle>Simulated Holdings</CardTitle><p className="text-xs text-muted-foreground">Alpaca paper · All broker holdings · USD · Checked {new Date(data.checkedAt).toLocaleString()}</p></CardHeader>
      <CardContent className="px-3 pb-4">
        {!data.positions.length ? <p className="text-sm text-muted-foreground">No open Alpaca paper positions.</p> : <div className="overflow-x-auto" role="region" aria-label="Alpaca paper holdings" tabIndex={0}>
          <table className="w-full whitespace-nowrap text-right text-xs tabular-nums"><caption className="sr-only">Alpaca paper holdings with cost, daily price movement and unrealized profit and loss</caption>
            <thead className="border-b border-border text-muted-foreground"><tr>{['Symbol', 'Shares', 'Avg Cost', 'Price', 'Today', 'Value', 'P&L', 'P&L%', 'Held · estimate', 'Managed shares'].map(label => <th key={label} scope="col" className="px-2 py-2 first:text-left font-medium">{label}</th>)}</tr></thead>
            <tbody>{data.positions.map(p => <tr key={p.symbol} className="data-hover border-b border-border/50">
              <th scope="row" className="px-2 py-3 text-left font-semibold">{p.symbol}</th><td className="px-2">{number(p.qty, 8)}</td><td className="px-2">{money(p.avgCost)}</td><td className="px-2">{money(p.price)}</td>
              <td className={`px-2 ${move(p.priceChange)}`}>{signedMoney(p.priceChange)} ({pct(p.priceChangePct)})</td><td className="px-2">{money(p.value)}</td><td className={`px-2 ${move(p.unrealizedPnl)}`}>{signedMoney(p.unrealizedPnl)}</td><td className={`px-2 ${move(p.unrealizedPnlPct)}`}>{pct(p.unrealizedPnlPct)}</td>
              <td className="px-2 text-muted-foreground" title={p.heldSince ? `Earliest remaining recorded fill: ${new Date(p.heldSince).toLocaleString()}` : 'Insufficient reconciled fill history'}>{held(p.heldSince, data.checkedAt)}</td><td className="px-2 text-muted-foreground">{p.managedQty > 0 ? number(p.managedQty, 8) : 'External holding'}</td>
            </tr>)}</tbody>
          </table>
        </div>}
        <p className="mt-3 text-xs text-muted-foreground">Today is the per-share move from Alpaca’s previous close. Managed quantities come from confirmed app fills and ownership reviews. Holding periods are estimates from remaining FIFO fills.</p>
      </CardContent>
    </Card>
    <Card className="min-w-0">
      <CardHeader className="pb-2"><CardTitle>Buffett Review</CardTitle><p className="text-xs text-muted-foreground">Alpaca paper account review · includes external and legacy paper activity</p></CardHeader>
      <CardContent className="space-y-5 px-3 pb-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs md:grid-cols-3 xl:grid-cols-9">{metrics.map(m => <div className="min-w-0" key={m.label}><dt className="text-muted-foreground">{m.label}</dt><dd className={`mt-1 font-semibold tabular-nums ${m.change === undefined ? '' : move(m.change)}`}>{m.value}</dd></div>)}</dl>
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <section className="min-w-0" aria-label="Paper equity chart"><h3 className="text-sm font-medium">Account equity</h3><EquityChart data={data} />
            <p className="mt-2 text-xs text-muted-foreground">Observed equity drawdown: {pct(data.observedEquityDrawdownPct)} · {data.history.length} daily observations. Broker P&amp;L and equity include the effect of account cash flows. Time-weighted return is unavailable without valuations at each cash flow.</p>
          </section>
          <section aria-label="Paper position contribution"><h3 className="mb-3 text-sm font-medium">Position contribution</h3>
            {!data.positions.length && <p className="text-xs text-muted-foreground">No open positions.</p>}
            <div className="space-y-3">{data.positions.map(p => <div key={p.symbol}><div className="mb-1 flex flex-wrap justify-between gap-2 text-xs"><span className="font-semibold">{p.symbol} <span className="font-normal text-muted-foreground">{pct(p.weightPct)} of equity</span></span><span className={`tabular-nums ${move(p.unrealizedPnl)}`}>{signedMoney(p.unrealizedPnl)}</span></div>
              <div className="h-1.5 overflow-hidden rounded bg-muted" aria-hidden="true"><div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, p.weightPct ?? 0))}%` }} /></div>
            </div>)}</div>
            <p className="mt-3 text-xs text-muted-foreground">Cash {money(data.cash)} · {pct(data.cashPct)} of account equity. Contribution shows unrealized P&amp;L.</p>
          </section>
        </div>
        <section className="border-t border-border pt-4" aria-label="Paper Buffett action log"><h3 className="mb-2 text-sm font-medium">Buffett action log</h3>
          {!data.actions.length && <p className="text-xs text-muted-foreground">No broker fills linked to a long-term investment thesis in the retrieved history.</p>}
          <div className="space-y-3">{data.actions.map(a => <article key={a.id} className="text-xs"><p className="font-medium">{new Date(a.date).toLocaleString()} · {a.side.toUpperCase()} {number(a.qty, 8)} {a.symbol} · {money(a.amount)}</p><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{a.reason}</p></article>)}</div>
        </section>
        <p className="text-xs text-muted-foreground">Realized P&amp;L, exits, win rate and held periods are FIFO estimates from retrieved executions, before fees and without tax-lot or corporate-action adjustments. Estimates are shown only when fill history is complete and its remaining quantities match the broker. Exits group sell fills by order; break-even exits are not wins.</p>
      </CardContent>
    </Card>
    <Card className="min-w-0">
      <CardHeader className="pb-2"><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Trade History</CardTitle><Button variant="outline" disabled={!trades.length} onClick={download}>Export CSV</Button></div><p className="text-xs text-muted-foreground">Actual Alpaca paper executions, including partial fills. Amount is gross fill value. Pending and unfilled orders remain in Broker order evidence below.</p></CardHeader>
      <CardContent className="space-y-3 px-3 pb-4">
        <div className="flex flex-wrap gap-3"><label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Symbol<input className={inputClass} value={symbol} placeholder="All symbols" onChange={e => { setSymbol(e.target.value); setLimit(20) }} /></label><label className="flex flex-col gap-1 text-xs text-muted-foreground">Type<select className={inputClass} value={side} onChange={e => { setSide(e.target.value); setLimit(20) }}><option value="all">All trades</option><option value="buy">Buy</option><option value="sell">Sell</option></select></label></div>
        {!trades.length && <p className="text-sm text-muted-foreground">{!data.fillsAvailable ? 'Trade history is unavailable.' : data.trades.length ? 'No trades match these filters.' : 'No fills returned by Alpaca.'}</p>}
        {!!trades.length && <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Alpaca paper trade history"><table className="w-full whitespace-nowrap text-right text-xs tabular-nums"><caption className="sr-only">Alpaca paper broker executions, newest first</caption>
          <thead className="border-b border-border text-muted-foreground"><tr>{['Date', 'Type', 'Symbol', 'Shares', 'Price', 'Amount', 'Origin'].map(label => <th scope="col" key={label} className="px-2 py-2 first:text-left font-medium">{label}</th>)}</tr></thead>
          <tbody>{trades.slice(0, limit).map(t => <tr className="data-hover border-b border-border/50" key={t.id}><td className="px-2 py-3 text-left text-muted-foreground">{new Date(t.date).toLocaleString()}</td><td className="px-2"><span className={`rounded px-1.5 py-0.5 ${t.side === 'buy' ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative'}`}>{t.side}</span></td><th scope="row" className="px-2 font-semibold">{t.symbol}</th><td className="px-2">{number(t.qty, 8)}</td><td className="px-2">{money(t.price)}</td><td className="px-2">{money(t.amount)}</td><td className="px-2 text-muted-foreground">{t.origin}</td></tr>)}</tbody>
        </table></div>}
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Showing {Math.min(limit, trades.length)} of {trades.length} matching fills · {data.fillHistoryComplete ? 'All available broker fills retrieved' : 'History incomplete'} · CSV includes all matching retrieved fills.</p>{trades.length > limit && <Button variant="outline" onClick={() => setLimit(n => n + 50)}>Show more trades</Button>}</div>
      </CardContent>
    </Card>
  </>
}

export function PaperPortfolioPanels() {
  const [period, setPeriod] = useState<PortfolioPeriod>('1M')
  const query = useQuery({ queryKey: ['alpaca-paper', 'long-term', 'portfolio', period], queryFn: () => paperInvestingRequest<PaperPortfolio>(`/portfolio?period=${period}`), staleTime: 30_000, retry: false, refetchOnWindowFocus: false })
  return <section aria-label="Alpaca paper portfolio review" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><label className="flex flex-col gap-1 text-xs text-muted-foreground">Equity history period<select className={inputClass} value={period} onChange={e => setPeriod(e.target.value as PortfolioPeriod)}>{Object.entries(periods).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Reading broker data…' : 'Refresh portfolio'}</Button></div>
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading Alpaca paper holdings, review and fills…</p>}
    {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}{query.data ? ' Showing the last successful snapshot; its checked time is shown below.' : ''}</p>}
    {query.data && <PortfolioContent data={query.data} />}
  </section>
}
