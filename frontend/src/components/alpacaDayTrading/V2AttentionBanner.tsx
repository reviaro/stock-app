import { useV2Status } from '@/hooks/useAlpacaDayTradingV2'

// A latch is a human's job: this banner only tells the operator; nothing here acts on the broker.
export function V2AttentionBanner() {
  const { data } = useV2Status()
  if (!data?.attentionRequired && !data?.killSwitch) return null
  return (
    <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <p className="font-semibold">{data.attentionRequired ? 'Attention required' : 'Kill switch on'} — new entries are blocked.</p>
      <p className="mt-1">
        {data.attentionCode ? <>Reason code <span className="font-mono">{data.attentionCode}</span>. </> : null}
        Broker state has been preserved as found. Review the plans below, resolve at the broker if needed, then clear with CLEAR in Monitor status.
      </p>
    </div>
  )
}
