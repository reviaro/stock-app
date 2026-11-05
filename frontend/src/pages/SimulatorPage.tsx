import { useState } from 'react'
import { AccountHeader } from '@/components/simulator/AccountHeader'
import { HoldingsPanel } from '@/components/simulator/HoldingsPanel'
import { TradePanel } from '@/components/simulator/TradePanel'
import { TransactionHistory } from '@/components/simulator/TransactionHistory'
import { SimulatorReviewPanel } from '@/components/simulator/SimulatorReviewPanel'
import { ReinvestmentPanel } from '@/components/simulator/ReinvestmentPanel'
import { AlpacaPaperPage } from '@/pages/AlpacaPaperPage'
import type { SimHolding } from '@/types/simulator'

type PaperAccount = 'simulator' | 'alpaca'

function LongTermSimulator() {
  const [sellTarget, setSellTarget] = useState<SimHolding | null>(null)
  return <div className="space-y-4">
    <AccountHeader accountId={1} />
    <ReinvestmentPanel accountId={1} />
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="min-h-[320px] lg:col-span-2"><HoldingsPanel accountId={1} onSell={setSellTarget} /></div>
      <div className="min-h-[320px]"><TradePanel accountId={1} sellTarget={sellTarget} onSellClose={() => setSellTarget(null)} /></div>
    </div>
    <SimulatorReviewPanel accountId={1} />
    <TransactionHistory accountId={1} />
  </div>
}

export function SimulatorPage() {
  const [account, setAccount] = useState<PaperAccount>('simulator')
  return <main className="min-h-screen bg-background p-4 sm:p-6">
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">Paper Trading Simulator</h1>
        <p className="font-medium text-foreground">Long-Term Investing</p>
        <p className="max-w-3xl text-sm text-muted-foreground">Practice building and reviewing a portfolio. The local simulator and Alpaca paper account keep separate cash, holdings, and history. Import simulator target weights into an editable Alpaca allocation draft when ready.</p>
      </header>
      <div className="flex flex-wrap gap-1 border-b border-border" aria-label="Paper account">
        {([{ id: 'simulator', label: 'Local simulator' }, { id: 'alpaca', label: 'Alpaca paper' }] as const).map(option => <button
          key={option.id} type="button" aria-pressed={account === option.id} aria-controls="paper-account-workspace"
          onClick={() => setAccount(option.id)}
          className={`min-h-11 border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${account === option.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {option.label}
        </button>)}
      </div>
      <section id="paper-account-workspace" aria-label={account === 'simulator' ? 'Local long-term simulator' : 'Alpaca long-term paper account'}>
        {account === 'simulator' ? <LongTermSimulator /> : <AlpacaPaperPage />}
      </section>
    </div>
  </main>
}
