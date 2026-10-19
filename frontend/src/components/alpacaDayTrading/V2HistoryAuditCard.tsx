import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useApplyAlpacaHistory, useDisableLegacyAlpacaMonitor, usePreviewAlpacaHistory } from '@/hooks/useAlpacaDayTradingV2'
import { v2ErrorMessage } from '@/lib/alpacaV2Errors'
import type { AlpacaHistoryValues } from '@/types/alpacaDayTrading'
import { price, rMultiple, time, usd } from './v2Format'

const ISSUE_MESSAGES: Record<string, string> = {
  DUPLICATE_DELIVERIES: 'Repeated fill deliveries were found; they must not count as additional executions.',
  LOCAL_FILL_CONFLICT: 'Local records disagree about a fill.',
  UNLINKED_FILLS: 'Some fills are not linked to a plan.',
  LOCAL_FILLS_NOT_IN_BROKER_HISTORY: 'Some local fills are absent from the available broker history.',
  BROKER_LOCAL_FILL_MISMATCH: 'Broker and local fill details disagree.',
  BROKER_FILL_INVALID: 'A broker fill lacks usable evidence.',
  BROKER_FILL_CONFLICT: 'Broker fill records contain conflicting evidence.',
  CROSS_VERSION_EXECUTION_OVERLAP: 'Execution evidence overlaps between v1 and v2.',
  BROKER_FILLS_MISSING_LOCALLY: 'Broker history contains fills missing from local history.',
  PLAN_FILL_SUMMARY_MISMATCH: 'A plan summary differs from its fill evidence.',
  MANUAL_FILL_REVIEW_REQUIRED: 'Fill ownership needs explicit operator review.',
  PLAN_BROKER_EVIDENCE_INCOMPLETE: 'Broker evidence does not fully support this plan.',
  ENTRY_BASIS_UNAVAILABLE: 'The entry cost basis is unavailable; P&L cannot be established.',
  PLAN_HISTORY_COVERAGE_INCOMPLETE: 'Available history does not cover the full plan.',
  AMBIGUOUS_OR_UNBALANCED_HISTORY: 'The history is ambiguous or entry and exit quantities do not balance.',
  OVERLAPPING_SYMBOL_HISTORY: 'Other trades in this symbol overlap the candidate history.',
  PLAN_TOO_RECENT_FOR_REPAIR: 'This plan is too recent for historical repair.',
  PRIOR_SYMBOL_EXPOSURE_REVIEW_REQUIRED: 'Earlier exposure in this symbol requires ownership review.',
}

function valueRows(values: AlpacaHistoryValues): [string, string][] {
  return [
    ['State', values.state?.replace(/_/g, ' ') || 'Unknown'],
    ['Entry quantity', values.entryQty == null ? '—' : String(values.entryQty)],
    ['Exit quantity', values.exitQty == null ? '—' : String(values.exitQty)],
    ['Entry price', price(values.entryPrice)], ['Exit price', price(values.exitPrice)],
    ['Realized P&L', usd(values.realizedPnl)], ['Realized R', rMultiple(values.realizedR)],
    ['Opened (ET)', time(values.openedAt)], ['Closed (ET)', time(values.closedAt)],
    ['Exit reason', values.exitReason?.replace(/_/g, ' ') || 'Unknown'],
  ]
}

function HistoryReview() {
  const preview = usePreviewAlpacaHistory()
  const apply = useApplyAlpacaHistory()
  const disableLegacy = useDisableLegacyAlpacaMonitor()
  const [selected, setSelected] = useState<number[]>([])
  const [attributed, setAttributed] = useState<number[]>([])
  const [confirm, setConfirm] = useState('')
  const [disableConfirm, setDisableConfirm] = useState('')
  const data = preview.data
  const busy = preview.isPending || apply.isPending || disableLegacy.isPending
  const locked = busy || apply.isSuccess || apply.isError || disableLegacy.isSuccess
  const requiredAttribution = data?.repairs.filter((repair) => selected.includes(repair.planId) && repair.requiresAttributionReview) ?? []
  const ready = !!data && data.applyBlockers.length === 0 && selected.length > 0
    && requiredAttribution.every((repair) => attributed.includes(repair.planId)) && confirm === 'APPLY_HISTORY_REPAIR' && !locked
  function reload() {
    if (busy) return
    setSelected([]); setAttributed([]); setConfirm(''); setDisableConfirm('')
    apply.reset(); disableLegacy.reset(); preview.reset(); preview.mutate()
  }
  function select(planId: number, checked: boolean) {
    setSelected((current) => checked ? [...current, planId] : current.filter((id) => id !== planId))
    setAttributed((current) => current.filter((id) => id !== planId))
    setConfirm('')
  }
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">Compare v1 and v2 records with broker fill history. Repairs affect selected historical v1 records only; they do not place orders, change broker balances, or add v1 results to v2 analytics.</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={reload}>{preview.isPending ? 'Reading history…' : data ? 'Load a new preview' : 'Preview history discrepancies'}</Button>
      {preview.isError && <p role="alert" className="text-destructive">{v2ErrorMessage(preview.error)}</p>}
      {data && <>
        <div className="overflow-x-auto" role="region" aria-label="History audit counts" tabIndex={0}>
          <table className="w-full min-w-[480px] text-left"><caption className="sr-only">Local historical evidence counts</caption><thead className="text-muted-foreground"><tr>{['History', 'Plans', 'Fill rows', 'Unique fills', 'Duplicate rows', 'Unlinked fills'].map((heading) => <th key={heading} scope="col" className="px-2 py-2">{heading}</th>)}</tr></thead><tbody>{(['v1', 'v2'] as const).map((version) => <tr key={version} className="border-t border-border"><th scope="row" className="px-2 py-2">{version}</th>{[data.summary[version].planCount, data.summary[version].fillCount, data.summary[version].canonicalFillCount, data.summary[version].duplicateRows, data.summary[version].unlinkedFills].map((count, index) => <td key={index} className="px-2 py-2">{count}</td>)}</tr>)}</tbody></table>
        </div>
        <p className="text-muted-foreground">Broker history: {data.summary.broker.fillCount} fills · {data.summary.broker.complete ? 'Coverage complete' : 'Coverage incomplete'}. {data.summary.repairablePlans} repair candidates; {data.summary.attributionReviewPlans} need ownership attribution review.</p>
        {data.issues.length > 0 && <details><summary className="cursor-pointer py-2 font-medium">Audit findings ({data.issues.length})</summary><ul className="space-y-2 py-2">{data.issues.map((issue, index) => <li key={index} className={issue.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{issue.version && <span>{issue.version} · </span>}{issue.symbol && <span>{issue.symbol} · </span>}{issue.planId != null && <span>Plan #{issue.planId} · </span>}{ISSUE_MESSAGES[issue.code] ?? 'A historical discrepancy needs review.'}{issue.count != null && <span> ({issue.count})</span>}</li>)}</ul></details>}
        {data.applyBlockers.length > 0 && <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3"><p className="font-medium">Repair is blocked</p><ul className="list-inside list-disc space-y-1">{data.applyBlockers.map((code) => <li key={code}>{v2ErrorMessage({ code })}</li>)}</ul></div>}
        {data.monitorModes?.v1 != null && data.monitorModes.v1 !== 'disabled' && <fieldset disabled={busy || disableLegacy.isSuccess} className="space-y-2 border-t border-border pt-3">
          <legend className="font-medium">Disable retired v1 execution</legend>
          <p className="text-muted-foreground">Stops the retired monitor only. The account must have no positions, working orders, or active execution. Review a new history preview afterward.</p>
          <label className="block space-y-1"><span>Type DISABLE_LEGACY to confirm</span><input className="w-full rounded-md border border-border bg-background px-3 py-2 sm:max-w-sm" autoComplete="off" value={disableConfirm} onChange={(event) => setDisableConfirm(event.target.value)} /></label>
          <Button type="button" size="sm" variant="outline" disabled={busy || disableLegacy.isSuccess || disableConfirm !== 'DISABLE_LEGACY'} onClick={() => { if (disableConfirm === 'DISABLE_LEGACY' && !busy) disableLegacy.mutate(undefined, { onSuccess: () => { setDisableConfirm(''); setConfirm(''); setSelected([]); setAttributed([]) } }) }}>{disableLegacy.isPending ? 'Disabling…' : 'Disable retired v1 monitor'}</Button>
          {disableLegacy.isError && <p role="alert" className="text-destructive">{v2ErrorMessage(disableLegacy.error)}</p>}
          {disableLegacy.isSuccess && <p role="status" className="text-positive">Retired v1 monitor disabled. Load a new preview before selecting repairs.</p>}
        </fieldset>}
        {data.repairs.length === 0 && <p className="text-muted-foreground">No supported v1 repair candidates in this preview. Audit findings remain available for review.</p>}
        {data.repairs.map((repair) => {
          const before = valueRows(repair.before)
          const after = valueRows(repair.after)
          const checked = selected.includes(repair.planId)
          return <article key={repair.planId} className="space-y-2 border-t border-border pt-3">
            <label className="flex min-h-11 items-center gap-2 font-medium"><input type="checkbox" checked={checked} disabled={locked || data.applyBlockers.length > 0} onChange={(event) => select(repair.planId, event.target.checked)} />Select {repair.symbol} v1 plan #{repair.planId}</label>
            <p className="text-muted-foreground">{repair.missingFillCount} missing fills to import · {repair.linkedFillCount} fills to link. Unknown exit reasons stay unknown.</p>
            <div className="overflow-x-auto" role="region" aria-label={repair.symbol + ' plan ' + repair.planId + ' proposed changes'} tabIndex={0}>
              <table className="w-full table-fixed text-left"><caption className="sr-only">Before and after the proposed historical repair</caption><thead className="text-muted-foreground"><tr><th scope="col" className="w-2/5 px-2 py-2">Field</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead><tbody>{before.map(([label, value], index) => <tr key={label} className="border-t border-border/60"><th scope="row" className="px-2 py-1 font-normal">{label}</th><td className="break-words px-1 py-1 align-top">{value}</td><td className="break-words px-1 py-1 align-top">{after[index][1]}</td></tr>)}</tbody></table>
            </div>
            {repair.requiresAttributionReview && <div className="space-y-1 rounded-md border border-warning/40 p-3"><p>Ownership is inferred. Check the trade in your broker history before confirming attribution.</p><label className="flex min-h-11 items-center gap-2"><input type="checkbox" disabled={!checked || locked} checked={attributed.includes(repair.planId)} onChange={(event) => { setAttributed((current) => event.target.checked ? [...current, repair.planId] : current.filter((id) => id !== repair.planId)); setConfirm('') }} />I confirm these fills belong to {repair.symbol} v1 plan #{repair.planId}</label></div>}
          </article>
        })}
        {data.repairs.length > 0 && <fieldset disabled={locked || data.applyBlockers.length > 0} className="space-y-2 border-t border-border pt-3">
          <legend className="font-medium">Apply reviewed v1 repairs</legend>
          <p className="text-muted-foreground">{selected.length} selected. Only the selected changes shown above will be applied after the account and evidence are checked again.</p>
          <label className="block space-y-1"><span>Type APPLY_HISTORY_REPAIR to confirm</span><input className="w-full rounded-md border border-border bg-background px-3 py-2 sm:max-w-sm" autoComplete="off" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
          <Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => { if (ready) apply.mutate({ reviewToken: data.reviewToken, selectedPlanIds: selected, attributionPlanIds: attributed.filter((id) => selected.includes(id)), confirm: 'APPLY_HISTORY_REPAIR' }, { onSuccess: () => setConfirm('') }) }}>{apply.isPending ? 'Checking and applying…' : 'Apply selected history repairs'}</Button>
        </fieldset>}
      </>}
      {apply.isError && <p role="alert" className="text-destructive">{v2ErrorMessage(apply.error)} Load a new preview before another attempt.</p>}
      {apply.isSuccess && apply.data && <p role="status" className="text-positive">{apply.data.replayed ? 'These repairs were already applied.' : 'History repair complete.'} {apply.data.repairedPlanCount} plans repaired, {apply.data.importedFillCount} fills imported, {apply.data.linkedFillCount} fills linked. Load a new preview to review current history.</p>}
    </div>
  )
}

export function V2HistoryAuditCard() {
  const [open, setOpen] = useState(false)
  return <section aria-label="Historical evidence audit"><Card>
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2"><CardTitle>Historical evidence audit</CardTitle><Button type="button" size="sm" variant="outline" aria-expanded={open} aria-controls="history-audit-review" onClick={() => setOpen((value) => !value)}>{open ? 'Hide history audit' : 'Review history audit'}</Button></CardHeader>
    <CardContent className="px-3 pb-4 text-xs">{open ? <div id="history-audit-review"><HistoryReview /></div> : <p className="text-muted-foreground">Review duplicate fills, missing evidence, and proposed v1 history corrections before applying any local changes.</p>}</CardContent>
  </Card></section>
}
