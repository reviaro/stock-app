import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAlpacaDayTradingPlans, useAlpacaDayTradingPlanDetail } from '@/hooks/useAlpacaDayTrading'

function usd(value?: number | null) {
  return value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function rMultiple(value?: number | null) {
  return value == null ? '—' : `${value.toFixed(2)}R`
}

function stateBadge(state: string) {
  if (state === 'closed') return <Badge variant="outline">closed</Badge>
  if (state === 'error') return <Badge variant="destructive">error</Badge>
  if (state === 'cancelled') return <Badge variant="secondary">cancelled</Badge>
  return <Badge variant="default">{state}</Badge>
}

function PlanDetail({ planId }: { planId: number }) {
  const { data, isLoading, isError } = useAlpacaDayTradingPlanDetail(planId)

  if (isLoading) return <p className="text-xs text-muted-foreground">Loading plan detail…</p>
  if (isError || !data) return <p className="text-xs text-destructive">Unable to load plan detail.</p>

  const { plan, fills } = data
  return (
    <div className="space-y-3 rounded-md border border-border bg-background/60 p-3 text-xs">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div><p className="text-muted-foreground">Setup</p><p className="font-medium">{plan.setup}</p></div>
        <div><p className="text-muted-foreground">Catalyst</p><p className="font-medium">{plan.catalyst}</p></div>
        <div><p className="text-muted-foreground">Thesis</p><p className="font-medium">{plan.thesis}</p></div>
        <div><p className="text-muted-foreground">Invalidation</p><p className="font-medium">{plan.invalidation}</p></div>
        <div><p className="text-muted-foreground">Planned stop / target</p><p className="font-mono">{usd(plan.plannedStop)} / {usd(plan.plannedTarget)}</p></div>
        <div><p className="text-muted-foreground">Planned risk</p><p className="font-mono">{usd(plan.plannedRiskDollars)} ({rMultiple(plan.plannedRewardRisk)} reward:risk)</p></div>
        <div><p className="text-muted-foreground">Filled entry</p><p className="font-mono">{plan.filledEntryQty} @ {usd(plan.avgEntryPrice)}</p></div>
        <div><p className="text-muted-foreground">Filled exit</p><p className="font-mono">{plan.filledExitQty} @ {usd(plan.avgExitPrice)}</p></div>
      </div>
      {plan.reviewNotes && (
        <div className="rounded-md border border-border/70 bg-secondary/40 p-2">
          <p className="font-medium text-muted-foreground">{plan.state === 'error' ? 'System note (this plan errored)' : 'Review notes'}</p>
          <p className="mt-0.5">{plan.reviewNotes}</p>
        </div>
      )}
      <div>
        <p className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Fills ({fills.length})</p>
        {fills.length === 0 ? <p className="text-muted-foreground">No fills recorded yet.</p> : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[480px]">
              <thead className="bg-secondary/60 text-muted-foreground"><tr><th className="px-2 py-1 text-left">Side</th><th>Qty</th><th>Price</th><th>Executed</th><th>Source</th></tr></thead>
              <tbody>
                {fills.map((fill) => (
                  <tr key={fill.activityId} className="border-t border-border/60">
                    <td className="px-2 py-1 font-medium uppercase">{fill.side}</td>
                    <td className="text-center font-mono">{fill.qty}</td>
                    <td className="text-center font-mono">{usd(fill.price)}</td>
                    <td className="text-center font-mono">{new Date(fill.executedAt).toLocaleString()}</td>
                    <td className="text-center">{fill.source}{fill.isBust ? ' (busted)' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export function PlansTable() {
  const [stateFilter, setStateFilter] = useState<string>('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const { data, isLoading, isError } = useAlpacaDayTradingPlans(stateFilter || undefined)
  const plans = data ?? []

  return (
    <Card aria-label="Alpaca Day Trading plans">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle><h2>Plans ({plans.length})</h2></CardTitle>
        <select
          aria-label="Filter plans by state"
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          value={stateFilter}
          onChange={(event) => { setStateFilter(event.target.value); setSelectedId(null) }}
        >
          <option value="">All states</option>
          <option value="entry_pending">entry_pending</option>
          <option value="partially_entered">partially_entered</option>
          <option value="active">active</option>
          <option value="exit_pending">exit_pending</option>
          <option value="closed">closed</option>
          <option value="cancelled">cancelled</option>
          <option value="error">error</option>
        </select>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-4">
        {isLoading && <p className="text-xs text-muted-foreground">Loading plans…</p>}
        {isError && <p className="text-xs text-destructive">Unable to load plans.</p>}
        {data && plans.length === 0 && <p className="text-xs text-muted-foreground">No plans match this filter.</p>}
        {data && plans.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">Symbol</th>
                  <th>Setup</th>
                  <th>State</th>
                  <th>Risk $</th>
                  <th>Realized P&amp;L</th>
                  <th>Realized R</th>
                  <th>Exit reason</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr
                    key={plan.id}
                    className={`cursor-pointer border-t border-border/60 hover:bg-secondary/40 ${selectedId === plan.id ? 'bg-secondary/50' : ''}`}
                    onClick={() => setSelectedId(selectedId === plan.id ? null : plan.id)}
                  >
                    <td className="px-2 py-1.5 font-medium">{plan.symbol}</td>
                    <td className="text-center">{plan.setup}</td>
                    <td className="text-center">{stateBadge(plan.state)}</td>
                    <td className="text-center font-mono">{usd(plan.plannedRiskDollars)}</td>
                    <td className={`text-center font-mono ${plan.realizedPnl != null && plan.realizedPnl < 0 ? 'text-destructive' : plan.realizedPnl != null && plan.realizedPnl > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{usd(plan.realizedPnl)}</td>
                    <td className="text-center font-mono">{rMultiple(plan.realizedR)}</td>
                    <td className="text-center">{plan.exitReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedId != null && <PlanDetail planId={selectedId} />}
      </CardContent>
    </Card>
  )
}
