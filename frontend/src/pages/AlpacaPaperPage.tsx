import { LongTermInvestingWorkspace } from '@/components/investing/LongTermInvestingWorkspace'
import { LegacyPaperArchive } from '@/components/investing/LegacyPaperArchive'
import { useAlpacaPaperInvesting } from '@/hooks/useAlpacaPaperInvesting'
import { PaperPortfolioPanels } from '@/components/investing/PaperPortfolioPanels'

export function AlpacaPaperPage() {
  const hooks = useAlpacaPaperInvesting()
  return <div className="space-y-6">
    <LongTermInvestingWorkspace hooks={hooks} environment="paper" verified portfolio={<PaperPortfolioPanels />} />
    <LegacyPaperArchive overview={hooks.overview.data} />
  </div>
}
