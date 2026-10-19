import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useV2Journal } from '@/hooks/useAlpacaDayTradingV2'
import type { AlpacaV2GroupStats, AlpacaV2Plan } from '@/types/alpacaDayTrading'
import { pct, rMultiple, time, usd } from './v2Format'

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="font-mono text-sm">{value}</dd></div>
}

function Breakdown({ title, groups = {} }: { title: string; groups?: Record<string, AlpacaV2GroupStats> }) {
  const rows = Object.entries(groups)
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {rows.length === 0 ? <p className="text-muted-foreground">No closed trades yet.</p> : (
        <div className="overflow-x-auto rounded-md border border-border" role="region" aria-label={title} tabIndex={0}>
          <table className="w-full min-w-[580px]">
            <caption className="sr-only">{title}: closed v2 trade results</caption>
            <thead className="bg-secondary/60 text-muted-foreground"><tr><th scope="col" className="px-2 py-2 text-left">Group</th><th scope="col">Trades</th><th scope="col">Win rate</th><th scope="col">P&amp;L</th><th scope="col">Exp. $</th><th scope="col">Auth. R</th><th scope="col">Fill-risk R</th></tr></thead>
            <tbody>
              {rows.map(([key, stats]) => (
                <tr key={key} className="border-t border-border/60 text-center">
                  <th scope="row" className="max-w-48 break-words px-2 py-2 text-left font-normal">{key}</th><td>{stats.count}</td><td>{pct(stats.winRate)}</td>
                  <td>{usd(stats.realizedPnl)}</td><td>{usd(stats.expectancyDollars)}</td><td>{rMultiple(stats.expectancyR)}</td><td>{rMultiple(stats.expectancyActualRiskR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TradeEvidence({ trades }: { trades: AlpacaV2Plan[] }) {
  const closed = trades.filter((trade) => trade.state === 'closed' && trade.exitReason !== 'operator_resolved')
  return (
    <details className="border-t border-border pt-3">
      <summary className="cursor-pointer py-2 font-medium">Closed trade evidence ({closed.length})</summary>
      <p className="mb-2 text-muted-foreground">Recorded closed plans are shown below; only verified fills enter analytics. MFE and MAE are sampled favorable and adverse excursions in dollars while fully entered. Partial-exit intervals and gaps between observations can miss highs, lows, and exit triggers. Missing evidence stays unavailable.</p>
      {closed.length === 0 ? <p className="text-muted-foreground">Evidence will appear when a v2 trade closes.</p> : (
        <div role="region" aria-label="Closed trade evidence" tabIndex={0} className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[920px] text-left">
            <caption className="sr-only">Closed v2 trade outcomes and sampled evidence</caption>
            <thead className="bg-secondary/60 text-muted-foreground"><tr>{['Trade', 'Setup / version', 'Exit', 'P&L', 'Authorized R', 'Fill-risk R', 'Sampled MFE / MAE', 'Coverage'].map((label) => <th key={label} scope="col" className="px-2 py-2">{label}</th>)}</tr></thead>
            <tbody>{closed.map((trade) => (
              <tr key={trade.id} className="border-t border-border/60 align-top">
                <th scope="row" className="px-2 py-2 font-normal"><span className="font-medium">{trade.symbol}</span><span className="block text-muted-foreground">{time(trade.closedAt)} ET</span></th>
                <td className="max-w-48 break-words px-2 py-2">{trade.setupId?.replace(/_/g, ' ') || 'Legacy unclassified'}<span className="block text-muted-foreground">{trade.strategyVersion || 'Unclassified'}</span></td>
                <td className="px-2 py-2">{trade.exitReason?.replace(/_/g, ' ') || 'Unknown'}</td>
                <td className="px-2 py-2 font-mono">{usd(trade.realizedPnl)}</td>
                <td className="px-2 py-2 font-mono">{rMultiple(trade.realizedR)}<span className="block text-muted-foreground">Risk {usd(trade.plannedRiskDollars)}</span></td>
                <td className="px-2 py-2 font-mono">{rMultiple(trade.actualRiskR)}<span className="block text-muted-foreground">Risk {usd(trade.actualInitialRiskDollars)}</span></td>
                <td className="px-2 py-2 font-mono">{usd(trade.observations?.mfeDollars)} / {usd(trade.observations?.maeDollars)}</td>
                <td className="px-2 py-2"><span className="block">{trade.fillEvidenceComplete ? "Verified fills" : "Fill basis unverified"}</span><span>{trade.observations?.count == null ? 'No observations' : `${trade.observations.count} samples`}</span><span className="block text-muted-foreground">{trade.observations?.complete ? 'Sample window complete' : 'Incomplete coverage'}</span>{trade.observations?.firstAt && <span className="block text-muted-foreground">{time(trade.observations.firstAt)}–{time(trade.observations.lastAt)} ET</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </details>
  )
}

export function V2SetupAnalyticsCard() {
  const { data, isLoading, isError } = useV2Journal()
  const a = data?.analytics
  return (
    <section aria-label="Setup analytics">
      <Card>
        <CardHeader className="pb-2"><CardTitle>Setup analytics (v2 only)</CardTitle></CardHeader>
        <CardContent className="space-y-4 px-3 pb-4 text-xs">
          {isLoading && <p className="text-muted-foreground">Loading analytics…</p>}
          {isError && <p role="alert" className="text-destructive">Unable to load analytics.</p>}
          {a && (
            <>
              <p className={`rounded-md border px-3 py-2 ${a.sample.preliminary ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border text-muted-foreground'}`}>{a.sample.note}</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Closed trades" value={String(a.closedTradeCount)} />
                <Stat label="Win rate" value={pct(a.winRate)} />
                <Stat label="Expectancy dollars" value={usd(a.expectancyDollars)} />
                <Stat label="Realized P&L" value={usd(a.realizedPnl)} />
                <Stat label="Expectancy / authorized risk" value={rMultiple(a.expectancyR)} />
                <Stat label="Expectancy / fill risk" value={rMultiple(a.expectancyActualRiskR)} />
                <Stat label="Closed-trade drawdown" value={usd(a.maxClosedTradeDrawdownDollars)} />
                <Stat label="Profit factor" value={a.profitFactor == null ? '—' : a.profitFactor.toFixed(2)} />
                <Stat label="Avg win / loss" value={`${usd(a.averageWin)} / ${usd(a.averageLoss)}`} />
                <Stat label="Max losing streak" value={String(a.maxConsecutiveLosses)} />
                <Stat label="Avg hold" value={a.averageHoldMinutes == null ? '—' : `${a.averageHoldMinutes} min`} />
              </dl>
              <p className="text-muted-foreground">Authorized R divides realized P&amp;L by the approved entry risk. Fill-risk R uses initial risk at the actual entry fills and original stop. Missing risk is excluded from that R average. Drawdown uses closed trades only.</p>
              {a.evidence && <div className="space-y-1 border-y border-border py-3">
                <h3 className="font-medium">Evidence coverage</h3>
                <p>{a.evidence.classifiedTrades} of {a.evidence.totalTrades} trades classified · {a.evidence.measuredTrades} of {a.evidence.totalTrades} trades measured · {a.evidence.sampledObservationCount} sampled observations</p>
                <p className="text-muted-foreground">Unclassified history remains visible in its own groups. Sampled prices are observations, not a complete price path.</p>
              </div>}
              <div className="grid min-w-0 gap-3 xl:grid-cols-2">
                <Breakdown title="By stable setup" groups={a.bySetup} />
                <Breakdown title="By strategy version" groups={a.byStrategyVersion} />
                <Breakdown title="By exit outcome" groups={a.byExitReason} />
                <Breakdown title="By catalyst class" groups={a.byCatalyst} />
              </div>
              <details>
                <summary className="cursor-pointer py-2 font-medium">Entry window and session breakdowns</summary>
                <div className="grid min-w-0 gap-3 xl:grid-cols-2"><Breakdown title="By entry window (ET)" groups={a.byWindow} /><Breakdown title="By session date" groups={a.bySessionDate} /></div>
              </details>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div><dt className="text-muted-foreground">NO TRADE decisions ({a.noTrade.count})</dt><dd className="break-words font-mono">{Object.entries(a.noTrade.byReason).map(([reason, n]) => `${reason} ×${n}`).join(', ') || '—'}</dd></div>
                <div><dt className="text-muted-foreground">Attention incidents ({a.attention.count})</dt><dd className="break-words font-mono">{Object.entries(a.attention.byCode).map(([code, n]) => `${code} ×${n}`).join(', ') || '—'}</dd></div>
              </dl>
              <p className="text-muted-foreground">NO TRADE decisions, attention incidents, open plans, operator-resolved plans ({a.excludedOperatorResolved}), plans with incomplete fill evidence ({a.excludedIncompleteFills ?? 0}), and v1 history are excluded from expectancy.</p>
              <TradeEvidence trades={data.trades} />
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
