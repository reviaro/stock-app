import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { usePaperTradePrice } from '@/hooks/useAlpacaPaperInvesting'
import type { useAlpacaPaperInvesting } from '@/hooks/useAlpacaPaperInvesting'
import type { LiveOrder, LivePlan } from '@/types/alpacaLive'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const terminal = new Set(['filled', 'canceled', 'expired', 'rejected'])
const inputClass = 'mt-1 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground'
// Only explicit execute refusals before reservation may discard the reviewed intent.
const preReservationRefusals = new Set([
  'PAPER_TARGET_CHANGED', 'PAPER_PLAN_EXPIRED', 'PAPER_PRICE_CHANGED', 'PAPER_PLAN_BLOCKED',
  'PAPER_CONFIRMATION_REQUIRED', 'PAPER_GATE_CLOSED', 'PAPER_STATE_CHANGED', 'PAPER_ACCOUNT_CHANGED',
  'PAPER_ASSET_CHANGED', 'PAPER_CASH_CHANGED', 'PAPER_POSITION_LIMIT', 'PAPER_MARKET_CLOSED',
  'PAPER_EXECUTION_EVIDENCE_STALE', 'PAPER_PLAN_NOT_FOUND',
])
type Hooks = Pick<ReturnType<typeof useAlpacaPaperInvesting>, 'overview' | 'manualPreview' | 'manualExecute'>
type Side = 'buy' | 'sell'
export type TradePrefill = { symbol: string; side: Side; qty: number; nonce: number }

function targetOutcome(plan: LivePlan) {
  const change = plan.targetChange
  if (!change) return 'Saved target unchanged.'
  if (change.weightPct === 0) return `Target removed (was ${change.previous?.weightPct ?? 0}%)`
  return `Target after trade: ${change.weightPct}%`
}

export function PaperTradePanel({ hooks, prefill }: { hooks: Hooks; prefill?: TradePrefill }) {
  const { overview, manualPreview, manualExecute } = hooks
  const data = overview.data
  const [symbol, setSymbol] = useState('')
  const [side, setSide] = useState<Side>('buy')
  const [shares, setShares] = useState('')
  const [appliedPrefill, setAppliedPrefill] = useState<number>()
  const [plan, setPlan] = useState<LivePlan>()
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [receipt, setReceipt] = useState<LiveOrder>()
  const [attempted, setAttempted] = useState(false)
  const busy = useRef(false)
  const sharesInput = useRef<HTMLInputElement>(null)
  const [expired, setExpired] = useState(false)
  const price = usePaperTradePrice(symbol)
  useEffect(() => {
    const remaining = Date.parse(plan?.expiresAt ?? '') - Date.now()
    setExpired(!(remaining > 0))
    if (remaining > 0) {
      const timer = setTimeout(() => setExpired(true), remaining)
      return () => clearTimeout(timer)
    }
  }, [plan])
  useEffect(() => { if (appliedPrefill !== undefined) sharesInput.current?.focus() }, [appliedPrefill])
  if (!data) return null
  const reconciled = attempted && plan ? data.orders.find(o => o.planId === plan.id) : undefined
  const order = reconciled || receipt
  const locked = attempted && !(reconciled && terminal.has(reconciled.status))
  function clearReview() {
    setPlan(undefined); setReceipt(undefined); setConfirmation(''); setMessage(''); setAttempted(false)
  }
  // A Sell click in the holdings table fills the form once no trade is in flight.
  if (prefill && prefill.nonce !== appliedPrefill && !locked) {
    setAppliedPrefill(prefill.nonce); setSymbol(prefill.symbol); setSide(prefill.side); setShares(String(prefill.qty)); clearReview()
  }
  const qty = Number(shares)
  const next = plan?.nextOrder
  const phrase = `${side.toUpperCase()} ${symbol} PAPER`
  const pending = manualPreview.isPending || manualExecute.isPending
  const validInput = /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) && shares.trim() !== '' && Number.isFinite(qty) && qty > 0
  const canPreview = validInput && data.connected && !overview.error && !locked && !pending
  const canSubmit = canPreview && !attempted && plan?.policyVersion === data.version && !plan?.decisionKey && !plan?.blockers.length &&
    next?.side === side && next.symbol === symbol && !data.policy.paused && data.configuration.tradingEnabled && !data.blockers.length &&
    confirmation === phrase && !expired
  async function preview() {
    if (!canPreview || busy.current) return
    busy.current = true
    clearReview()
    try { setPlan(await manualPreview.mutateAsync({ symbol, side, qty })) }
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
  return <section aria-labelledby="paper-trade" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
    <h2 id="paper-trade" className="text-lg font-semibold">Trade</h2>
    <p className="text-sm text-muted-foreground">Buy or sell by shares. Your policy limits apply, every trade needs typed confirmation, and the saved target follows the position.</p>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
      <label className="block min-w-0 text-sm">Trade symbol<input className={inputClass} value={symbol} maxLength={10} autoComplete="off" disabled={locked || pending}
        onChange={e => { clearReview(); setSymbol(e.target.value.toUpperCase().trim()) }} /></label>
      <fieldset className="flex gap-4 text-sm" disabled={locked || pending}><legend className="sr-only">Side</legend>
        {(['buy', 'sell'] as const).map(value => <label key={value} className="flex items-center gap-2"><input type="radio" name="paper-trade-side" checked={side === value}
          onChange={() => { clearReview(); setSide(value) }} />{value === 'buy' ? 'Buy' : 'Sell'}</label>)}
      </fieldset>
      <label className="block min-w-0 text-sm">Shares<input ref={sharesInput} className={inputClass} type="number" min="0" step="any" value={shares} disabled={locked || pending}
        onChange={e => { clearReview(); setShares(e.target.value) }} /></label>
    </div>
    <p className="text-sm text-muted-foreground">Current price: {price.data != null ? money.format(price.data) : '—'}</p>
    <Button variant="outline" disabled={!canPreview} onClick={preview}>Preview trade</Button>
    {plan && <div className="space-y-2 text-sm">
      <p>Preview expires: <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleString()}</time>{expired && ' — expired'}</p>
      {plan.blockers.map(b => <p key={b} role="status" className="text-amber-700 dark:text-amber-300">{b}</p>)}
      {next ? <><p>{next.side.toUpperCase()} {next.symbol}: {next.qty} shares · limit {money.format(next.limitPrice)} · up to {money.format(next.notional)}</p>
        <p className="text-muted-foreground">{targetOutcome(plan)}</p>
        <label className="block">Type {phrase} <input className="rounded border bg-background p-2" value={confirmation} autoComplete="off" disabled={attempted} onChange={e => setConfirmation(e.target.value)} /></label>
        <Button disabled={!canSubmit} onClick={submit}>{`Submit paper ${side}`}</Button></> : <p>No order for this quantity.</p>}
    </div>}
    {message && !order && <p role="alert">{message}</p>}
    {order && <p role="status">Broker status: {order.status} · Filled quantity: {order.filledQty}. Refresh & reconcile to verify fills.</p>}
  </section>
}
