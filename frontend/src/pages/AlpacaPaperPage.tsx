import { useAlpacaPaperSnapshot, useAlpacaPaperStatus } from '@/hooks/useAlpacaPaper'

const formatUsd = (value?: string) => value == null
  ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value))

export function AlpacaPaperPage() {
  const { data: status, isLoading, isError } = useAlpacaPaperStatus()
  const { data: snapshot, isLoading: isSnapshotLoading, isError: isSnapshotError } = useAlpacaPaperSnapshot()

  return (
    <main className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-[1200px] space-y-4">
        <header>
          <h1 className="text-2xl font-bold text-foreground">Alpaca Paper Broker</h1>
          <p className="mt-1 text-sm text-muted-foreground">A separate broker-backed paper account. It does not alter the local simulator or real portfolio ledger.</p>
        </header>

        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-100">
          <p className="font-semibold">Paper account — no real money.</p>
          <p className="mt-1">Long-only US equity trades using cash-only sizing. Margin, short sales, options, crypto, extended-hours, and advanced orders are disabled.</p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4" aria-label="Alpaca paper connection status">
          <h2 className="text-base font-semibold text-foreground">Connection status</h2>
          {isLoading && <p className="mt-2 text-sm text-muted-foreground">Checking paper connection…</p>}
          {isError && <p className="mt-2 text-sm text-destructive">Unable to check Alpaca paper status. No order entry is available.</p>}
          {status && (
            <div className="mt-3 space-y-2 text-sm">
              <p><span className="font-medium">Environment:</span> PAPER</p>
              <p><span className="font-medium">Endpoint:</span> {status.baseUrl}</p>
              {status.configured ? (
                status.connection === 'verified' ? (
                  <div className="space-y-2">
                    <p className="font-medium text-emerald-700 dark:text-emerald-300">Paper connection verified — account {status.accountStatus}.</p>
                    <p><span className="font-medium">Cash available for sizing:</span> {formatUsd(status.cash)}</p>
                    <p><span className="font-medium">Equity:</span> {formatUsd(status.equity)}</p>
                    <p className="text-xs text-muted-foreground">The broker reports {formatUsd(status.buyingPower)} of margin buying power, but the dashboard never uses it: cash-only sizing is enforced.</p>
                  </div>
                ) : (
                  <p className="text-muted-foreground">Paper credentials are configured, but the broker connection has not been verified. No order entry is available.</p>
                )
              ) : (
                <p className="text-muted-foreground">API credentials are not configured. Add paper-only credentials to the backend environment; never enter them in this dashboard or chat.</p>
              )}
              {status.orderEntryEnabled ? (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-100">
                  <p className="font-semibold">Paper order execution is enabled.</p>
                  <p className="mt-1 text-xs">Every submission still requires the independent server-side order token and remains restricted to cash-covered, whole-share, day-limit buys.</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Paper order execution is disabled. Enabling it requires both explicit backend configuration gates.</p>
              )}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-4" aria-label="Alpaca paper broker reconciliation">
          <h2 className="text-base font-semibold text-foreground">Broker reconciliation</h2>
          {isSnapshotLoading && <p className="mt-2 text-sm text-muted-foreground">Refreshing broker positions and open orders…</p>}
          {isSnapshotError && <p className="mt-2 text-sm text-destructive">Unable to load the read-only broker reconciliation.</p>}
          {snapshot && (
            <div className="mt-3 space-y-3 text-sm">
              <p><span className="font-medium">Market:</span> {snapshot.clock.isOpen ? 'Open' : 'Closed'} · next open {snapshot.clock.nextOpen}</p>
              <div>
                <p className="font-medium">Positions ({snapshot.positions.length})</p>
                {snapshot.positions.length === 0 ? <p className="text-muted-foreground">No Alpaca paper positions.</p> : snapshot.positions.map((position) => (
                  <p key={position.symbol}>{position.symbol}: {position.qty} shares · value {formatUsd(position.marketValue)} · unrealized P&L {formatUsd(position.unrealizedPnl)}</p>
                ))}
              </div>
              <div>
                <p className="font-medium">Open orders ({snapshot.openOrders.length})</p>
                {snapshot.openOrders.length === 0 ? <p className="text-muted-foreground">No open Alpaca paper orders.</p> : snapshot.openOrders.map((order, index) => (
                  <p key={`${order.symbol}-${order.submittedAt}-${index}`}>{order.side.toUpperCase()} {order.qty} {order.symbol} · {order.type} · {order.status}</p>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">This is a read-only broker reconciliation. It does not submit, modify, or cancel orders.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
