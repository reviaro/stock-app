import { useState } from 'react'
import { AccountHeader } from '@/components/simulator/AccountHeader'
import { HoldingsPanel } from '@/components/simulator/HoldingsPanel'
import { TradePanel } from '@/components/simulator/TradePanel'
import { TransactionHistory } from '@/components/simulator/TransactionHistory'
import { SimulatorReviewPanel } from '@/components/simulator/SimulatorReviewPanel'
import { RiskMonitorPanel } from '@/components/simulator/RiskMonitorPanel'
import { JournalAnalyticsPanel } from '@/components/simulator/JournalAnalyticsPanel'
import { ReinvestmentPanel } from '@/components/simulator/ReinvestmentPanel'
import { useSimSleeves } from '@/hooks/useSimulator'
import type { SimHolding } from '@/types/simulator'

export function SimulatorPage() {
  const [selectedAccountId, setSelectedAccountId] = useState(1)
  const [sellTarget, setSellTarget] = useState<SimHolding | null>(null)
  const { data: sleeves, isLoading: sleevesLoading } = useSimSleeves()
  const selectedSleeve = sleeves?.find((sleeve) => sleeve.id === selectedAccountId)

  const selectSleeve = (accountId: number) => {
    setSelectedAccountId(accountId)
    setSellTarget(null)
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Paper Trading Simulator</h1>
            <p className="text-xs text-muted-foreground mt-1">Each sleeve has separate cash, holdings, trade history, and performance.</p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card/60 p-1" aria-label="Simulator sleeve">
            {sleevesLoading && <span className="px-3 py-1.5 text-xs text-muted-foreground">Loading sleeves…</span>}
            {sleeves?.map((sleeve) => (
              <button
                key={sleeve.id}
                type="button"
                onClick={() => selectSleeve(sleeve.id)}
                className={`relative z-10 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  sleeve.id === selectedAccountId
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {sleeve.name}
              </button>
            ))}
          </div>
        </div>

        {selectedSleeve?.slug === 'day-trading' && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-100">
            <strong>Day-trading sleeve:</strong> use defined entries, hard exits, and limited sizing. This ledger is isolated from the long-term investing sleeve.
          </div>
        )}

        {/* key resets confirm/deposit inputs so they can't fire against a different sleeve */}
        <AccountHeader key={selectedAccountId} accountId={selectedAccountId} />
        <ReinvestmentPanel key={`reinvestment-${selectedAccountId}`} accountId={selectedAccountId} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 min-h-[320px]">
            <HoldingsPanel accountId={selectedAccountId} onSell={(holding) => setSellTarget(holding)} />
          </div>
          <div className="min-h-[320px]">
            <TradePanel accountId={selectedAccountId} sellTarget={sellTarget} onSellClose={() => setSellTarget(null)} structuredJournal={selectedSleeve?.slug === 'day-trading'} />
          </div>
        </div>
        <SimulatorReviewPanel accountId={selectedAccountId} />
        {selectedSleeve?.slug === 'day-trading' && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <RiskMonitorPanel accountId={selectedAccountId} />
            <JournalAnalyticsPanel accountId={selectedAccountId} />
          </div>
        )}
        <TransactionHistory accountId={selectedAccountId} />
      </div>
    </div>
  )
}
