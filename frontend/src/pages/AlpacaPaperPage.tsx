import { useState } from 'react'
import { useAlpacaPaperStatus } from '@/hooks/useAlpacaPaper'
import { Button } from '@/components/ui/button'
import { V2AttentionBanner } from '@/components/alpacaDayTrading/V2AttentionBanner'
import { V2MonitorStatusCard } from '@/components/alpacaDayTrading/V2MonitorStatusCard'
import { V2BrokerSnapshotCard } from '@/components/alpacaDayTrading/V2BrokerSnapshotCard'
import { V2ActivePlansCard } from '@/components/alpacaDayTrading/V2ActivePlansCard'
import { V2PositionsCard } from '@/components/alpacaDayTrading/V2PositionsCard'
import { V2DecisionJournalCard } from '@/components/alpacaDayTrading/V2DecisionJournalCard'
import { V2SetupAnalyticsCard } from '@/components/alpacaDayTrading/V2SetupAnalyticsCard'
import { DayTradingJournalCard } from '@/components/alpacaDayTrading/DayTradingJournalCard'

// v1 execution is retired. Its journal stays readable here, collapsed by default and kept out
// of every v2 figure above it.
function HistoricalV1Section() {
  const [open, setOpen] = useState(false)
  return (
    <section aria-label="Historical v1 (read-only)" className="rounded-lg border border-dashed border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Historical v1 (read-only)</h2>
          <p className="text-xs text-muted-foreground">Retired v1 journal. It cannot place orders and is not included in v2 P&amp;L or expectancy.</p>
        </div>
        <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide v1 history' : 'Show v1 history'}
        </Button>
      </div>
      {open && <div className="mt-3"><DayTradingJournalCard /></div>}
    </section>
  )
}

export function AlpacaPaperPage() {
  const { data: status } = useAlpacaPaperStatus()

  return (
    <main className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-[1200px] space-y-4">
        <header>
          <h1 className="text-2xl font-bold text-foreground">Alpaca Day Trading</h1>
          <p className="mt-1 text-sm font-medium text-foreground">Paper strategy lab — v2</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A separate broker-backed paper account for evaluating Day Trading decisions. Alpaca paper is authoritative for cash,
            positions, orders, fills, and native bracket protection; it never alters the simulator or the real portfolio ledger.
          </p>
        </header>

        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-100">
          <p className="font-semibold">Paper account — no real money.</p>
          <p className="mt-1">
            Long-only, regular-hours US equity bracket orders sized from cash only. Margin, shorting, options, crypto, and extended hours are disabled.
            {status && (status.configured && status.connection === 'verified' ? ' Paper connection verified.' : ' Paper connection not verified.')}
          </p>
        </section>

        <V2AttentionBanner />

        <div className="grid gap-4 lg:grid-cols-2">
          <V2MonitorStatusCard />
          <V2BrokerSnapshotCard />
        </div>

        <V2ActivePlansCard />
        <V2PositionsCard />
        <V2SetupAnalyticsCard />
        <V2DecisionJournalCard />
        <HistoricalV1Section />
      </div>
    </main>
  )
}
