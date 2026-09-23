import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useResolveV2Plan, useV2Plans } from '@/hooks/useAlpacaDayTradingV2'
import { v2ErrorMessage } from '@/lib/alpacaV2Errors'
import type { AlpacaV2Plan } from '@/types/alpacaDayTrading'
import { price, time, usd } from './v2Format'

const TERMINAL = new Set(['closed', 'cancelled', 'rejected'])

function stateBadge(state: string) {
  if (state === 'attention_required') return <Badge variant="destructive">attention required</Badge>
  if (state === 'active' || state === 'time_exit_pending') return <Badge>{state.replace(/_/g, ' ')}</Badge>
  return <Badge variant="secondary">{state.replace(/_/g, ' ')}</Badge>
}

// Operator acknowledgement once the broker is flat for this symbol. The backend re-reads the
// broker and refuses if anything is still exposed; nothing here places or cancels an order.
function ResolveControl({ plan }: { plan: AlpacaV2Plan }) {
  const resolve = useResolveV2Plan()
  const [confirmText, setConfirmText] = useState('')
  const locked = resolve.isPending
  const id = `v2-resolve-${plan.id}`
  return (
    <div className="mt-2 space-y-1 rounded-md border border-destructive/40 p-2">
      <label htmlFor={id} className="block text-xs text-muted-foreground">Type {plan.symbol} to mark this plan resolved (the broker must be flat for it)</label>
      <div className="flex gap-2">
        <input id={id} autoComplete="off" value={confirmText} disabled={locked} onChange={(event) => setConfirmText(event.target.value)}
          className="w-32 rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs" />
        <Button type="button" size="sm" variant="outline" disabled={confirmText !== plan.symbol || locked}
          onClick={() => { if (confirmText === plan.symbol && !locked) resolve.mutate({ planId: plan.id, symbol: plan.symbol }) }}>
          {locked ? 'Checking broker…' : 'Resolve plan'}
        </Button>
      </div>
      {resolve.isError && <p className="text-xs text-destructive">{v2ErrorMessage(resolve.error)}</p>}
    </div>
  )
}

export function V2ActivePlansCard() {
  const { data, isLoading, isError } = useV2Plans()
  const active = (data ?? []).filter((plan) => !TERMINAL.has(plan.state))
  return (
    <section aria-label="Active plans">
      <Card>
        <CardHeader className="pb-2"><CardTitle><h2>Active plans ({active.length})</h2></CardTitle></CardHeader>
        <CardContent className="space-y-2 px-3 pb-4 text-xs">
          {isLoading && <p className="text-muted-foreground">Loading plans…</p>}
          {isError && <p className="text-destructive">Unable to load plans.</p>}
          {data && active.length === 0 && <p className="text-muted-foreground">No open v2 plans.</p>}
          {active.map((plan) => (
            <article key={plan.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{plan.symbol}</span>
                {stateBadge(plan.state)}
                {plan.attentionCode && <span className="font-mono text-destructive">{plan.attentionCode}</span>}
                <span className="ml-auto text-muted-foreground">Plan #{plan.id} · exit by {time(plan.exitDeadline)} ET</span>
              </div>
              <p className="mt-1"><span className="text-muted-foreground">Setup</span> {plan.setup} · <span className="text-muted-foreground">Catalyst</span> {plan.catalyst}</p>
              <p><span className="text-muted-foreground">Thesis</span> {plan.thesis}</p>
              <p><span className="text-muted-foreground">Invalidation</span> {plan.invalidation}</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                <div><dt className="text-muted-foreground">Qty</dt><dd className="font-mono">{plan.filledEntryQty}/{plan.plannedQty}</dd></div>
                <div><dt className="text-muted-foreground">Entry</dt><dd className="font-mono">{price(plan.avgEntryPrice ?? plan.plannedEntryPrice)}</dd></div>
                <div><dt className="text-muted-foreground">Stop</dt><dd className="font-mono">{price(plan.plannedStop)}</dd></div>
                <div><dt className="text-muted-foreground">Target</dt><dd className="font-mono">{price(plan.plannedTarget)}</dd></div>
                <div><dt className="text-muted-foreground">Risk</dt><dd className="font-mono">{usd(plan.plannedRiskDollars)}</dd></div>
                <div><dt className="text-muted-foreground">Exited</dt><dd className="font-mono">{plan.filledExitQty}</dd></div>
              </dl>
              {plan.state === 'attention_required' && <ResolveControl plan={plan} />}
            </article>
          ))}
        </CardContent>
      </Card>
    </section>
  )
}
