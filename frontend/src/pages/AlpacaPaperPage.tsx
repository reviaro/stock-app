import { useAlpacaPaperStatus } from '@/hooks/useAlpacaPaper'
import { MonitorHealthCard } from '@/components/alpacaDayTrading/MonitorHealthCard'
import { AccountRiskCard } from '@/components/alpacaDayTrading/AccountRiskCard'
import { PositionsTable } from '@/components/alpacaDayTrading/PositionsTable'
import { PlansTable } from '@/components/alpacaDayTrading/PlansTable'
import { DayTradingJournalCard } from '@/components/alpacaDayTrading/DayTradingJournalCard'

const formatUsd = (value?: string) => value == null
  ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value))

export function AlpacaPaperPage() {
  const { data: status, isLoading, isError } = useAlpacaPaperStatus()

  return (
    <main className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-[1200px] space-y-4">
        <header>
          <h1 className="text-2xl font-bold text-foreground">Alpaca Day Trading</h1>
          <p className="mt-1 text-sm text-muted-foreground">A separate broker-backed paper account for the Day Trading strategy. It does not alter the local simulator or real portfolio ledger.</p>
        </header>

        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-100">
          <p className="font-semibold">Paper account — no real money.</p>
          <p className="mt-1">Long-only US equity bracket orders. Margin, short sales, options, crypto, extended-hours, and advanced order types outside the bracket contract are disabled.</p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4" aria-label="Alpaca paper connection status">
          <h2 className="text-base font-semibold text-foreground">Connection status</h2>
          {isLoading && <p className="mt-2 text-sm text-muted-foreground">Checking paper connection…</p>}
          {isError && <p className="mt-2 text-sm text-destructive">Unable to check Alpaca paper status.</p>}
          {status && (
            <div className="mt-3 space-y-2 text-sm">
              <p><span className="font-medium">Environment:</span> PAPER</p>
              <p><span className="font-medium">Endpoint:</span> {status.baseUrl}</p>
              {status.configured ? (
                status.connection === 'verified' ? (
                  <p className="font-medium text-emerald-700 dark:text-emerald-300">Paper connection verified — account {status.accountStatus}. Cash: {formatUsd(status.cash)} · Equity: {formatUsd(status.equity)}</p>
                ) : (
                  <p className="text-muted-foreground">Paper credentials are configured, but the broker connection has not been verified.</p>
                )
              ) : (
                <p className="text-muted-foreground">API credentials are not configured. Add paper-only credentials to the backend environment; never enter them in this dashboard or chat.</p>
              )}
            </div>
          )}
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <MonitorHealthCard />
          <AccountRiskCard />
        </div>

        <PositionsTable />
        <PlansTable />
        <DayTradingJournalCard />
      </div>
    </main>
  )
}
