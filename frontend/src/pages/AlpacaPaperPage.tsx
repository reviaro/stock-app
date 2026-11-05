import { LongTermInvestingWorkspace } from '@/components/investing/LongTermInvestingWorkspace'
import { LegacyPaperArchive } from '@/components/investing/LegacyPaperArchive'
import { useAlpacaPaperInvesting } from '@/hooks/useAlpacaPaperInvesting'

export function AlpacaPaperPage() {
  const hooks = useAlpacaPaperInvesting()
  return <div className="space-y-6">
    <LongTermInvestingWorkspace hooks={hooks} environment="paper" verified />
    <LegacyPaperArchive overview={hooks.overview.data} />
  </div>
}
