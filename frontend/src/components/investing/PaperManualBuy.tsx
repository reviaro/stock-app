import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { useAlpacaPaperInvesting } from '@/hooks/useAlpacaPaperInvesting'
import type { LiveOrder, LivePlan } from '@/types/alpacaLive'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const terminal = new Set(['filled', 'canceled', 'expired', 'rejected'])
// Only explicit execute refusals before reservation may discard the reviewed intent.
const preReservationRefusals = new Set([
  'PAPER_TARGET_CHANGED', 'PAPER_PLAN_EXPIRED', 'PAPER_PRICE_CHANGED', 'PAPER_PLAN_BLOCKED',
  'PAPER_CONFIRMATION_REQUIRED', 'PAPER_GATE_CLOSED', 'PAPER_STATE_CHANGED', 'PAPER_ACCOUNT_CHANGED',
  'PAPER_ASSET_CHANGED', 'PAPER_CASH_CHANGED', 'PAPER_POSITION_LIMIT', 'PAPER_MARKET_CLOSED',
  'PAPER_EXECUTION_EVIDENCE_STALE', 'PAPER_PLAN_NOT_FOUND',
])
type Hooks = Pick<ReturnType<typeof useAlpacaPaperInvesting>, 'overview' | 'manualPreview' | 'manualExecute'>

export function PaperManualBuy({ hooks }: { hooks: Hooks }) {
  const { overview, manualPreview, manualExecute } = hooks
  const data = overview.data
  const [symbol, setSymbol] = useState('')
  const [plan, setPlan] = useState<LivePlan>()
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [receipt, setReceipt] = useState<LiveOrder>()
  const [attempted, setAttempted] = useState(false)
  const busy = useRef(false)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const remaining = Date.parse(plan?.expiresAt ?? '') - Date.now()
    setExpired(!(remaining > 0))
    if (remaining > 0) {
      const timer = setTimeout(() => setExpired(true), remaining)
      return () => clearTimeout(timer)
    }
  }, [plan])
  if (!data) return null
  const reconciled = attempted && plan ? data.orders.find(o => o.planId === plan.id) : undefined
  const order = reconciled || receipt
  const locked = attempted && !(reconciled && terminal.has(reconciled.status))
  const target = data.policy.targets.find(t => t.symbol === symbol)
  const next = plan?.nextOrder
  const phrase = `BUY ${symbol} PAPER`
  const canPreview = !!target && data.connected && !overview.error && !locked && !manualPreview.isPending && !manualExecute.isPending
  const canSubmit = canPreview && !attempted && plan?.policyVersion === data.version && !plan?.decisionKey && !plan?.blockers.length &&
    next?.side === 'buy' && next.symbol === symbol && !data.policy.paused && data.configuration.tradingEnabled && !data.blockers.length &&
    confirmation === phrase && !expired
  function clearReview() {
    setPlan(undefined); setReceipt(undefined); setConfirmation(''); setMessage(''); setAttempted(false)
  }
  async function preview() {
    if (!canPreview || busy.current) return
    busy.current = true
    clearReview()
    try { setPlan(await manualPreview.mutateAsync(symbol)) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Preview unavailable.') }
    finally { busy.current = false }
  }
  async function submit() {
    if (!canSubmit || !plan || !(Date.parse(plan.expiresAt) > Date.now()) || busy.current) return
    busy.current = true
    setAttempted(true)
    try { setReceipt((await manualExecute.mutateAsync({ planId: plan.id, confirmation })).order) }
    catch (error) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && preReservationRefusals.has(error.code)) {
        clearReview()
        setMessage(`${error.message} Build a fresh preview before confirming.`)
      } else {
        setMessage(`Outcome uncertain. ${error instanceof Error ? error.message : ''} Refresh & reconcile before taking further action; do not resubmit.`)
      }
    }
    finally { busy.current = false }
  }
  return <section aria-labelledby="manual-paper-buy" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
    <h2 id="manual-paper-buy" className="text-lg font-semibold">Buy a saved Paper target</h2>
    <p className="text-sm">Preview one buy toward its saved weight. Manual buys always require your confirmation.</p>
    <label className="block">Saved policy target <select className="rounded border bg-background p-2" value={symbol} disabled={locked || manualPreview.isPending || manualExecute.isPending}
      onChange={e => { clearReview(); setSymbol(e.target.value) }}>
      <option value="">{data.policy.targets.length ? 'Select a target' : 'No saved targets'}</option>
      {data.policy.targets.map(t => <option key={t.symbol} value={t.symbol}>{t.symbol} — {t.weightPct}%</option>)}
    </select></label>
    <Button variant="outline" disabled={!canPreview} onClick={preview}>Preview selected buy</Button>
    {plan && <div className="space-y-2">
      <p>Preview expires: <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleString()}</time>{expired && ' — expired'}</p>
      {plan.blockers.map(b => <p key={b} role="status">{b}</p>)}
      {next ? <><p>{next.side.toUpperCase()} {next.symbol}: {next.qty} shares · limit {money.format(next.limitPrice)} · up to {money.format(next.notional)}</p>
        <label className="block">Type {phrase} <input className="rounded border bg-background p-2" value={confirmation} autoComplete="off" disabled={attempted} onChange={e => setConfirmation(e.target.value)} /></label>
        <Button disabled={!canSubmit} onClick={submit}>Submit selected paper buy</Button></> : <p>No actionable buy.</p>}
    </div>}
    {message && !order && <p role="alert">{message}</p>}
    {order && <p role="status">Broker status: {order.status} · Filled quantity: {order.filledQty}. Refresh & reconcile to verify fills.</p>}
  </section>
}
