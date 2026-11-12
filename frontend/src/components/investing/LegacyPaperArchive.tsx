import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { V2ActivePlansCard } from '@/components/alpacaDayTrading/V2ActivePlansCard'
import { V2DecisionJournalCard } from '@/components/alpacaDayTrading/V2DecisionJournalCard'
import { V2HistoryAuditCard } from '@/components/alpacaDayTrading/V2HistoryAuditCard'
import { DayTradingJournalCard } from '@/components/alpacaDayTrading/DayTradingJournalCard'
import { useSetV2Mode, useV2Status } from '@/hooks/useAlpacaDayTradingV2'
import type { InvestingOverview } from './LongTermInvestingWorkspace'
import { useRetirePaperDayTrading, useTransferLegacyPaperHolding, useReconcileLegacyPaperOrders } from '@/hooks/useAlpacaPaperInvesting'
import { v2ErrorMessage } from '@/lib/alpacaV2Errors'

const PLAN_RECOVERY_MESSAGES: Record<string, string> = {
  LEGACY_PAUSE_REQUIRED: 'Pause new long-term paper orders before reconciling legacy plans.',
  LEGACY_MONITORS_ENABLED: 'Retire both day-trading monitors below before reconciling plans.',
  LEGACY_SUBMISSION_PENDING: 'A legacy submission is unresolved. Verify its outcome before retrying.',
  LEGACY_ACCOUNT_MISMATCH: 'The broker account does not match the configured paper account. Review the server configuration.',
  LEGACY_BROKER_UNAVAILABLE: 'The broker is unavailable. Retry reconciliation when the connection recovers.',
  LEGACY_BROKER_DATA_INVALID: 'Broker account evidence could not be verified. Refresh before retrying.',
  LEGACY_ORDERS_OPEN: 'Working broker orders remain. Let them settle or review their cancellation at Alpaca.',
  LEGACY_HISTORY_UNVERIFIED: 'Complete broker order history is required to resolve this plan.',
  LEGACY_POSITION_OPEN: 'A broker position is still open. Review it at Alpaca or use the holdings transfer below.',
  LEGACY_ORDER_UNVERIFIED: 'A legacy order could not be verified. Reconcile its broker evidence before retrying.',
  LEGACY_STATE_CHANGED: 'The legacy plan changed during reconciliation. Refresh and try again.',
  LEGACY_EVIDENCE_STALE: 'Broker evidence expired during reconciliation. Refresh and try again.',
}

function LegacyHoldingTransfer({ overview }: { overview?: InvestingOverview }) {
  const transfer = useTransferLegacyPaperHolding()
  const [symbol, setSymbol] = useState('')
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const position = overview?.positions.find(holding => holding.symbol === symbol)
  const phrase = `TRANSFER ${symbol} ${position?.qty ?? 0} PAPER`
  const ready = !!position && overview?.connected === true && overview.policy.paused
    && confirmation === phrase && reason.trim().length >= 10 && !transfer.isPending && !transfer.isSuccess
  return <details className="rounded-lg border border-border p-4">
    <summary className="cursor-pointer font-medium">Transfer settled legacy holdings</summary>
    <p className="mt-3 text-sm text-muted-foreground">Keep an existing paper holding for long-term investing. Retire both day-trading monitors, pause the long-term policy, and settle or cancel all broker orders first. This transfers the reviewed holding into the long-term allocation and archives its legacy plans without selling shares or creating a fill.</p>
    {overview && !overview.policy.paused && <p role="status" className="mt-3 text-sm">Pause new paper orders before transferring a holding.</p>}
    <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); if (ready && position) transfer.mutate({ symbol, qty: position.qty, reason, confirmation }) }}>
      <label className="text-sm">Legacy holding to transfer<select aria-label="Legacy holding to transfer" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={symbol} onChange={event => { setSymbol(event.target.value); setConfirmation(''); transfer.reset() }}>
        <option value="">Select a broker holding</option>
        {overview?.positions.filter(holding => holding.qty > 0).map(holding => <option key={holding.symbol} value={holding.symbol}>{holding.symbol} · {holding.qty} shares</option>)}
      </select></label>
      <div className="text-sm"><p>Verified broker quantity</p><p className="mt-3 font-semibold tabular-nums">{position ? `${position.qty} shares` : 'Select a holding'}</p></div>
      <label className="text-sm sm:col-span-2">Reason for long-term transfer<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      {position && <label className="text-sm sm:col-span-2">Type {phrase}<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      <div className="sm:col-span-2"><Button type="submit" variant="outline" disabled={!ready}>{transfer.isPending ? 'Checking and transferring…' : 'Transfer reviewed holding'}</Button></div>
    </form>
    {transfer.error && <p role="alert" className="mt-3 text-sm text-destructive">{transfer.error.message}</p>}
    {transfer.isSuccess && <p role="status" className="mt-3 text-sm">Holding transferred. Review its long-term target weight before unpausing.</p>}
  </details>
}

function LegacyRecovery({ overview }: { overview?: InvestingOverview }) {
  const status = useV2Status()
  const disable = useSetV2Mode()
  const retire = useRetirePaperDayTrading()
  const reconcile = useReconcileLegacyPaperOrders()
  const [confirmation, setConfirmation] = useState('')
  return <div className="mt-4 space-y-4">
    <p className="text-sm text-muted-foreground">These records belong to the retired day-trading strategy. The account-wide paper portfolio review includes their broker activity. Resolve outstanding broker activity before starting long-term investing. Existing broker orders remain at Alpaca until filled or canceled.</p>
    <p className="text-sm text-muted-foreground">Transferred plans retain their historical state and fill evidence, but no longer belong to day-trading execution.</p>
    {(overview?.legacyHandovers?.length ?? 0) > 0 && <ul aria-label="Transferred legacy holdings" className="space-y-1 text-sm">
      {overview!.legacyHandovers!.map(handover => <li key={`${handover.legacyVersion}-${handover.planId}`}>
        {handover.symbol} · {handover.qty} shares · {handover.legacyVersion} plan #{handover.planId}: Transferred to long-term
      </li>)}
    </ul>}
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">Refresh retained orders and reconcile legacy v1 plans whose broker orders are settled and positions are flat. Plans stay blocked when broker status cannot be verified. Reconciliation does not submit or cancel broker orders.</p>
      <Button variant="outline" className="h-auto min-h-9 whitespace-normal text-left" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>{reconcile.isPending ? 'Reconciling legacy orders & plans…' : 'Reconcile legacy paper orders & plans'}</Button>
      {reconcile.error && <p role="alert" className="text-destructive">{reconcile.error.message}</p>}
      {reconcile.data && <p role={reconcile.data.failures ? 'alert' : 'status'}>
        Checked {reconcile.data.checked} orders; updated {reconcile.data.updated}, unchanged {reconcile.data.unchanged}.
        {reconcile.data.failures > 0 && ` ${reconcile.data.failures} could not be verified. Reconciliation is still required.`}
      </p>}
      {reconcile.data?.plans && <div role={reconcile.data.plans.blocked ? 'alert' : 'status'} aria-label="Legacy plan reconciliation" className="space-y-2">
        <p>Checked {reconcile.data.plans.checked} legacy v1 plans; reconciled {reconcile.data.plans.reconciled} ({reconcile.data.plans.closed} closed, {reconcile.data.plans.cancelled} canceled); {reconcile.data.plans.blocked} still blocked.</p>
        {reconcile.data.plans.skipped > 0 && <p>Transferred plans retained as history: {reconcile.data.plans.skipped}.</p>}
        {reconcile.data.plans.blockers.length > 0 && <ul className="list-disc space-y-1 pl-5">
          {reconcile.data.plans.blockers.map((blocker, index) => <li key={`${blocker.planId}-${index}`}>
            {blocker.symbol} · v1 plan #{blocker.planId}: {PLAN_RECOVERY_MESSAGES[blocker.code] ?? 'Review this legacy plan before retrying reconciliation.'}
          </li>)}
        </ul>}
      </div>}
    </div>
    {status.isLoading && <p role="status" className="text-sm">Loading retired monitor status…</p>}
    {status.isError && <p role="alert" className="text-sm text-destructive">Unable to load retired monitor status.</p>}
    {status.data && <div className="space-y-2 text-sm">
      <p>Retired v2 monitor: {status.data.mode} · {status.data.openPlanCount} records with a historical open state</p>
      <Button variant="outline" disabled={status.data.mode === 'disabled' || disable.isPending}
        onClick={() => disable.mutate({ mode: 'disabled', confirm: 'disabled' })}>
        {disable.isPending ? 'Disabling…' : 'Disable retired v2 monitor'}
      </Button>
      {disable.isError && <p role="alert" className="text-destructive">{v2ErrorMessage(disable.error)}</p>}
      {disable.isSuccess && <p role="status">Retired v2 monitor disabled. Refresh the paper account after resolving outstanding activity.</p>}
    </div>}
    <form className="space-y-3 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); if (confirmation === 'RETIRE DAY TRADING') retire.mutate(confirmation) }}>
      <p className="text-sm text-muted-foreground">Retire both historical monitors before managing a long-term allocation. This stops local day-trading automation and preserves broker orders and history.</p>
      <label className="block max-w-md text-sm">Type RETIRE DAY TRADING<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      <Button type="submit" variant="outline" disabled={confirmation !== 'RETIRE DAY TRADING' || retire.isPending || retire.isSuccess}>{retire.isPending ? 'Retiring…' : 'Retire day-trading monitors'}</Button>
      {retire.error && <p role="alert" className="text-sm text-destructive">{retire.error.message}</p>}
      {retire.isSuccess && <p role="status" className="text-sm">Both day-trading monitors are disabled. Resolve remaining broker activity and legacy plans before long-term investing.</p>}
    </form>
    <LegacyHoldingTransfer overview={overview} />
    <V2ActivePlansCard recovery transferredPlanIds={overview?.legacyHandovers?.filter(handover => handover.legacyVersion === 'v2').map(handover => handover.planId)} />
    <V2HistoryAuditCard />
    <V2DecisionJournalCard />
    <section aria-label="Historical v1 journal"><h3 className="mb-3 text-base font-semibold">Historical v1 journal (read-only)</h3><DayTradingJournalCard /></section>
  </div>
}

export function LegacyPaperArchive({ overview }: { overview?: InvestingOverview }) {
  const [open, setOpen] = useState(false)
  return <section aria-label="Legacy paper history and recovery" className="rounded-lg border border-dashed border-border p-4">
    <Button variant="ghost" className="h-auto whitespace-normal px-0 text-left" aria-expanded={open} aria-controls="legacy-paper-history" onClick={() => setOpen(value => !value)}>
      {open ? 'Hide legacy paper history & recovery' : 'Show legacy paper history & recovery'}
    </Button>
    {open && <div id="legacy-paper-history"><LegacyRecovery overview={overview} /></div>}
  </section>
}
