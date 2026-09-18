import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useAlpacaDayTradingSnapshot } from '@/hooks/useAlpacaDayTrading'

function usd(value?: string | number | null) {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value))
}

function pct(value: number | null | undefined) {
  return value == null ? '—' : `${(value * 100).toFixed(2)}%`
}

function LimitBar({ label, current, limit }: { label: string; current: number | null; limit: number }) {
  const pctOfLimit = current == null ? 0 : Math.min(100, (Math.abs(current) / limit) * 100)
  const nearLimit = current != null && Math.abs(current) / limit >= 0.8
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={nearLimit ? 'font-semibold text-destructive' : 'font-mono'}>{pct(current)} / {pct(limit)}</span>
      </div>
      <Progress value={pctOfLimit} className={nearLimit ? '[&>div]:bg-destructive' : undefined} />
    </div>
  )
}

export function AccountRiskCard() {
  const { data, isLoading, isError } = useAlpacaDayTradingSnapshot()

  return (
    <Card aria-label="Alpaca Day Trading account and risk">
      <CardHeader className="pb-2"><CardTitle><h2>Account &amp; risk</h2></CardTitle></CardHeader>
      <CardContent className="space-y-4 px-3 pb-4 text-sm">
        {isLoading && <p className="text-xs text-muted-foreground">Loading account snapshot…</p>}
        {isError && <p className="text-xs text-destructive">Unable to load the Alpaca account snapshot. If no paper credentials are configured, this panel cannot load.</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Cash</p><p className="font-mono font-semibold">{usd(data.account.cash)}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Equity</p><p className="font-mono font-semibold">{usd(data.account.equity)}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Buying power (unused)</p><p className="font-mono">{usd(data.account.buyingPower)}</p></div>
              <div className="rounded-md border border-border/70 bg-background/60 p-2"><p className="text-muted-foreground">Market</p><p className="font-semibold">{data.clock.isOpen ? 'Open' : 'Closed'}</p></div>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Daily P&amp;L</p>
              {data.risk.dailyRealizedPnl == null ? (
                <p className="text-xs text-muted-foreground">Unavailable{data.risk.dailyPnlUnavailableReason ? ` — ${data.risk.dailyPnlUnavailableReason}` : ''}.</p>
              ) : (
                <p className={`font-mono text-base font-semibold ${data.risk.dailyRealizedPnl < 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}`}>{usd(data.risk.dailyRealizedPnl)}</p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Account-2 policy limits</p>
              <LimitBar label="Total open risk (of equity)" current={data.risk.totalOpenRiskPct} limit={data.risk.limits.maxTotalOpenRiskPct} />
              <LimitBar label="Daily loss (of equity)" current={data.risk.dailyLossPct} limit={data.risk.limits.maxDailyLossPct} />
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Cash reserve (of equity)</span>
                <span className="font-mono">{pct(data.risk.cashPct)} (floor {pct(data.risk.limits.minCashPct)})</span>
              </div>
              <p className="text-xs text-muted-foreground">Max position size ({pct(data.risk.limits.maxPositionPct)}) and max risk/trade ({pct(data.risk.limits.maxRiskPerTradePct)}) are enforced per entry, not shown as account-level gauges here.</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
