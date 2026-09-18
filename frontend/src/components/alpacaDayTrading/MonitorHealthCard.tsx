import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAlpacaDayTradingMonitorHealth } from '@/hooks/useAlpacaDayTrading'

function timeAgo(iso: string | null) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString()
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

function modeBadge(mode: string | null) {
  if (mode === 'paper_execute') return <Badge variant="destructive">paper_execute</Badge>
  if (mode === 'shadow') return <Badge variant="secondary">shadow</Badge>
  return <Badge variant="outline">{mode ?? 'unknown'}</Badge>
}

export function MonitorHealthCard() {
  const { data, isLoading, isError } = useAlpacaDayTradingMonitorHealth()

  return (
    <Card aria-label="Day Trading monitor health">
      <CardHeader className="pb-2"><CardTitle><h2>Monitor health</h2></CardTitle></CardHeader>
      <CardContent className="space-y-3 px-3 pb-4 text-sm">
        {isLoading && <p className="text-xs text-muted-foreground">Loading monitor health…</p>}
        {isError && <p className="text-xs text-destructive">Unable to load monitor health.</p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Mode</span>
              {modeBadge(data.mode)}
              <span className="text-xs text-muted-foreground ml-2">Kill switch</span>
              {data.killSwitch ? <Badge variant="destructive">TRIPPED</Badge> : <Badge variant="outline">off</Badge>}
            </div>
            {data.healthCode && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                <p className="font-semibold">{data.healthCode}</p>
                {data.healthError && <p className="mt-0.5">{data.healthError}</p>}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><p className="text-muted-foreground">Last reconciliation</p><p className="font-mono">{timeAgo(data.lastRestReconciliationAt)}</p></div>
              <div><p className="text-muted-foreground">Last WebSocket event</p><p className="font-mono">{timeAgo(data.lastWebsocketEventAt)}</p></div>
              <div><p className="text-muted-foreground">Session date</p><p className="font-mono">{data.sessionDate ?? '— (not yet tracked)'}</p></div>
              <div><p className="text-muted-foreground">Last flatten sweep</p><p className="font-mono">{timeAgo(data.lastFlattenSweepAt)}</p></div>
            </div>
            <div className="rounded-md border border-border/70 bg-background/60 p-2 text-xs text-muted-foreground">
              Mode and kill-switch controls are not yet exposed here — how they should be authorized from the dashboard (separately from the agent-facing entry token) is an open decision. Until then, use the API directly.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
