import { useState } from 'react'
import { AccountHeader } from '@/components/simulator/AccountHeader'
import { HoldingsPanel } from '@/components/simulator/HoldingsPanel'
import { TradePanel } from '@/components/simulator/TradePanel'
import { TransactionHistory } from '@/components/simulator/TransactionHistory'
import type { SimHolding } from '@/types/simulator'

export function SimulatorPage() {
  const [sellTarget, setSellTarget] = useState<SimHolding | null>(null)

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Paper Trading Simulator</h1>
        <AccountHeader />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 min-h-[320px]">
            <HoldingsPanel onSell={(holding) => setSellTarget(holding)} />
          </div>
          <div className="min-h-[320px]">
            <TradePanel sellTarget={sellTarget} onSellClose={() => setSellTarget(null)} />
          </div>
        </div>
        <TransactionHistory />
      </div>
    </div>
  )
}
