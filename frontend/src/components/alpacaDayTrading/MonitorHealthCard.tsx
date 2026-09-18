import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useAlpacaDayTradingMonitorHealth,
  useSetAlpacaDayTradingMode,
  useClearAlpacaDayTradingKillSwitch,
} from '@/hooks/useAlpacaDayTrading'
import type { AlpacaMonitorMode } from '@/types/alpacaDayTrading'

const MODES: AlpacaMonitorMode[] = ['disabled', 'shadow', 'paper_execute']

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

function MonitorControls({ mode, killSwitch }: { mode: string | null; killSwitch: boolean }) {
  const [token, setToken] = useState('')
  const [pendingMode, setPendingMode] = useState<AlpacaMonitorMode>('disabled')
  const [modeConfirmText, setModeConfirmText] = useState('')
  const [killSwitchConfirmText, setKillSwitchConfirmText] = useState('')
  const setMode = useSetAlpacaDayTradingMode()
  const clearKillSwitch = useClearAlpacaDayTradingKillSwitch()

  const modeChangeReady = token.length > 0 && modeConfirmText === pendingMode
  const killSwitchClearReady = token.length > 0 && killSwitchConfirmText === 'CLEAR'

  return (
    <div className="space-y-3 rounded-md border border-border/70 bg-background/60 p-3 text-xs">
      <p className="font-semibold text-foreground">Operator controls</p>
      <p className="text-muted-foreground">
        These act on the live paper account. Every action below requires the Day Trading operator token
        (never stored — sent only on the request you submit, exactly as if you called the API yourself).
        Both actions also require the backend's own ALPACA_DAY_TRADING_ENTRY_ENABLED flag to be on; if that's
        off, a correct token here still gets refused.
      </p>

      <div className="space-y-1">
        <label htmlFor="dt-operator-token" className="block text-muted-foreground">Operator token</label>
        <input
          id="dt-operator-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-md border border-border bg-secondary px-2 py-1"
        />
      </div>

      <div className="space-y-1 border-t border-border/70 pt-2">
        <label htmlFor="dt-new-mode" className="block text-muted-foreground">New mode (current: {mode ?? 'unknown'})</label>
        <select
          id="dt-new-mode"
          value={pendingMode}
          onChange={(e) => { setPendingMode(e.target.value as AlpacaMonitorMode); setModeConfirmText('') }}
          className="w-full rounded-md border border-border bg-secondary px-2 py-1"
        >
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label htmlFor="dt-mode-confirm" className="block text-muted-foreground">Type &quot;{pendingMode}&quot; to confirm</label>
        <input
          id="dt-mode-confirm"
          value={modeConfirmText}
          onChange={(e) => setModeConfirmText(e.target.value)}
          className="w-full rounded-md border border-border bg-secondary px-2 py-1"
        />
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!modeChangeReady || setMode.isPending}
          onClick={() => {
            setMode.mutate({ mode: pendingMode, token }, {
              onSuccess: () => { setModeConfirmText(''); setToken('') },
            })
          }}
        >
          {setMode.isPending ? 'Changing mode…' : 'Change mode'}
        </Button>
        {setMode.isError && (
          <p className="text-destructive">{setMode.error instanceof Error ? setMode.error.message : 'Mode change failed'}</p>
        )}
        {setMode.isSuccess && <p className="text-emerald-600 dark:text-emerald-300">Mode updated.</p>}
      </div>

      <div className="space-y-1 border-t border-border/70 pt-2">
        {killSwitch ? (
          <>
            <label htmlFor="dt-kill-switch-confirm" className="block text-muted-foreground">Type CLEAR to confirm</label>
            <input
              id="dt-kill-switch-confirm"
              value={killSwitchConfirmText}
              onChange={(e) => setKillSwitchConfirmText(e.target.value)}
              className="w-full rounded-md border border-border bg-secondary px-2 py-1"
            />
            <p className="text-muted-foreground">Verifies the account is flat/covered before clearing — refuses otherwise.</p>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!killSwitchClearReady || clearKillSwitch.isPending}
              onClick={() => {
                clearKillSwitch.mutate(token, {
                  onSuccess: () => { setKillSwitchConfirmText(''); setToken('') },
                })
              }}
            >
              {clearKillSwitch.isPending ? 'Clearing…' : 'Clear kill switch'}
            </Button>
            {clearKillSwitch.isError && (
              <p className="text-destructive">{clearKillSwitch.error instanceof Error ? clearKillSwitch.error.message : 'Kill switch clear failed'}</p>
            )}
            {clearKillSwitch.isSuccess && <p className="text-emerald-600 dark:text-emerald-300">Kill switch cleared.</p>}
          </>
        ) : (
          <p className="text-muted-foreground">Kill switch is not tripped.</p>
        )}
      </div>
    </div>
  )
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
            <MonitorControls mode={data.mode} killSwitch={data.killSwitch} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
