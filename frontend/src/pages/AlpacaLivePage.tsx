import { useEffect, useState } from 'react'
import { LiveActionVerification } from '@/components/LiveActionVerification'
import { LongTermInvestingWorkspace } from '@/components/investing/LongTermInvestingWorkspace'
import { useAlpacaLive } from '@/hooks/useAlpacaLive'

export function AlpacaLivePage() {
  const hooks = useAlpacaLive()
  const [clock, setClock] = useState(Date.now)
  const security = hooks.security.data
  const verified = security?.authenticated === true && security.mfaConfigured === true && security.recentMfa === true
    && typeof security.recentAuthUntil === 'string' && Date.parse(security.recentAuthUntil) > clock
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <main>
    <LongTermInvestingWorkspace hooks={hooks} environment="live" verified={verified}
      verification={<LiveActionVerification security={security} verified={verified} error={hooks.security.error} onVerified={() => hooks.security.refetch()} />} />
  </main>
}
