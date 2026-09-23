import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useClearV2KillSwitch, useSetV2Mode, useV2Status } from '@/hooks/useAlpacaDayTradingV2'
import { v2ErrorMessage } from '@/lib/alpacaV2Errors'
import type { AlpacaV2Mode } from '@/types/alpacaDayTrading'
import { timeAgo } from './v2Format'

const MODE_LABELS: Record<AlpacaV2Mode, string> = {
  disabled: 'Execution disabled',
  shadow: 'Shadow',
  paper_execute: 'Paper execute',
}

const MODE_HELP: Record<AlpacaV2Mode, string> = {
  disabled: 'Monitor idle; no entries.',
  shadow: 'Monitor reads and journals; never places or cancels orders.',
  paper_execute: 'Validated entries submit one bracket order each; the monitor may run time exits.',
}

function ModeControl({ mode }: { mode: AlpacaV2Mode }) {
  const setMode = useSetV2Mode()
  const [pending, setPending] = useState<AlpacaV2Mode>(mode)
  const [confirmText, setConfirmText] = useState('')
  const locked = setMode.isPending
  const needsTyped = pending === 'paper_execute'
  const ready = pending !== mode && (!needsTyped || confirmText === 'paper_execute')

  return (
    <fieldset className="space-y-2 border-t border-border/70 pt-3" disabled={locked}>
      <legend className="text-xs font-semibold text-foreground">Execution mode</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(MODE_LABELS) as AlpacaV2Mode[]).map((option) => (
          <label
            key={option}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs ${pending === option ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}
          >
            <input
              type="radio"
              name="v2-mode"
              value={option}
              checked={pending === option}
              disabled={locked}
              onChange={() => { setPending(option); setConfirmText(''); if (setMode.isError || setMode.isSuccess) setMode.reset() }}
              aria-labelledby={`v2-mode-${option}-label`}
              aria-describedby={`v2-mode-${option}-help`}
              className="mt-0.5"
            />
            <span>
              <span id={`v2-mode-${option}-label`} className="block font-medium text-foreground">{MODE_LABELS[option]}</span>
              <span id={`v2-mode-${option}-help`} className="block text-muted-foreground">{MODE_HELP[option]}</span>
            </span>
          </label>
        ))}
      </div>
      {needsTyped && (
        <div className="space-y-1">
          <label htmlFor="v2-mode-confirm" className="block text-xs text-muted-foreground">Type paper_execute to confirm</label>
          <input
            id="v2-mode-confirm"
            autoComplete="off"
            value={confirmText}
            disabled={locked}
            onChange={(event) => setConfirmText(event.target.value)}
            className="w-full rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs"
          />
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant={needsTyped ? 'destructive' : 'outline'}
        disabled={!ready || locked}
        onClick={() => {
          if (!ready || locked) return
          setMode.mutate({ mode: pending, confirm: needsTyped ? confirmText : pending }, { onSuccess: () => setConfirmText('') })
        }}
      >
        {locked ? 'Applying…' : 'Apply mode'}
      </Button>
      {setMode.isError && <p className="text-xs text-destructive">{v2ErrorMessage(setMode.error)}</p>}
      {setMode.isSuccess && <p className="text-xs text-emerald-700 dark:text-emerald-300">Mode updated.</p>}
    </fieldset>
  )
}

function LatchControl() {
  const clear = useClearV2KillSwitch()
  const [confirmText, setConfirmText] = useState('')
  const locked = clear.isPending
  return (
    <div className="space-y-1 border-t border-border/70 pt-3">
      <label htmlFor="v2-clear-confirm" className="block text-xs text-muted-foreground">Type CLEAR to confirm</label>
      <input
        id="v2-clear-confirm"
        autoComplete="off"
        value={confirmText}
        disabled={locked}
        onChange={(event) => { setConfirmText(event.target.value); if (clear.isError || clear.isSuccess) clear.reset() }}
        className="w-full rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">Refused unless every plan is resolved and the broker shows nothing unaccounted for. Never changes broker state.</p>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={confirmText !== 'CLEAR' || locked}
        onClick={() => { if (confirmText === 'CLEAR' && !locked) clear.mutate(undefined, { onSuccess: () => setConfirmText('') }) }}
      >
        {locked ? 'Clearing…' : 'Clear kill switch and attention'}
      </Button>
      {clear.isError && <p className="text-xs text-destructive">{v2ErrorMessage(clear.error)}</p>}
      {clear.isSuccess && <p className="text-xs text-emerald-700 dark:text-emerald-300">Cleared.</p>}
    </div>
  )
}

export function V2MonitorStatusCard() {
  const { data, isLoading, isError } = useV2Status()
  return (
    <section aria-label="Monitor status">
      <Card>
        <CardHeader className="pb-2"><CardTitle><h2>Monitor status</h2></CardTitle></CardHeader>
        <CardContent className="space-y-3 px-3 pb-4 text-sm">
          {isLoading && <p className="text-xs text-muted-foreground">Loading monitor status…</p>}
          {isError && <p className="text-xs text-destructive">Unable to load monitor status.</p>}
          {data && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={data.mode === 'paper_execute' ? 'destructive' : 'secondary'}>{`Current mode: ${MODE_LABELS[data.mode] ?? data.mode}`}</Badge>
                {data.killSwitch ? <Badge variant="destructive">Kill switch on</Badge> : <Badge variant="outline">Kill switch off</Badge>}
                {data.heartbeatFresh ? <Badge variant="outline">Heartbeat fresh</Badge> : <Badge variant="destructive">Heartbeat stale</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div><dt className="text-muted-foreground">Last reconciliation</dt><dd className="font-mono">{timeAgo(data.lastReconciledAt)}</dd></div>
                <div><dt className="text-muted-foreground">Last WebSocket fill</dt><dd className="font-mono">{timeAgo(data.lastWebsocketAt)}</dd></div>
                <div><dt className="text-muted-foreground">Session date</dt><dd className="font-mono">{data.sessionDate ?? '—'}</dd></div>
                <div><dt className="text-muted-foreground">Open plans</dt><dd className="font-mono">{data.openPlanCount} ({data.attentionPlanCount} need attention)</dd></div>
              </dl>
              <ModeControl key={data.mode} mode={data.mode} />
              {(data.killSwitch || data.attentionRequired) && <LatchControl />}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
