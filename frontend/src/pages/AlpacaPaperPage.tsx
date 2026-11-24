import { useState } from 'react'
import { LongTermInvestingWorkspace } from '@/components/investing/LongTermInvestingWorkspace'
import { LegacyPaperArchive } from '@/components/investing/LegacyPaperArchive'
import { useAlpacaPaperInvesting } from '@/hooks/useAlpacaPaperInvesting'
import { PaperTradePanel } from '@/components/investing/PaperTradePanel'
import type { TradePrefill } from '@/components/investing/PaperTradePanel'
import { PaperPortfolioPanels } from '@/components/investing/PaperPortfolioPanels'

export function AlpacaPaperPage() {
  const hooks = useAlpacaPaperInvesting()
  const [prefill, setPrefill] = useState<TradePrefill>()
  const sell = (symbol: string, qty: number) => setPrefill({ symbol, side: 'sell', qty, nonce: Date.now() })
  return <div className="space-y-6">
    <LongTermInvestingWorkspace hooks={hooks} environment="paper" verified
      portfolio={<><PaperPortfolioPanels onSell={sell} /><PaperTradePanel hooks={hooks} prefill={prefill} /></>} />
    <LegacyPaperArchive overview={hooks.overview.data} />
  </div>
}
