import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useAlpacaLive } from '@/hooks/useAlpacaLive'
import type { LiveOverview, LivePolicy } from '@/types/alpacaLive'

const money = (n?: number) => n == null ? 'Unavailable' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const inputClass = 'mt-1 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary'
const terminal = new Set(['filled', 'canceled', 'expired', 'rejected'])
type LiveHooks = ReturnType<typeof useAlpacaLive>

function PolicyEditor({ data, hooks }: { data: LiveOverview; hooks: LiveHooks }) {
  const [policy, setPolicy] = useState<LivePolicy>(() => structuredClone(data.policy))
  const [confirmation, setConfirmation] = useState('')
  const [importNote, setImportNote] = useState('')
  const phrase = policy.executionMode === 'automatic' ? 'ENABLE AUTOMATIC LIVE INVESTING' : 'ENABLE LIVE INVESTING'
  const setNumber = (key: keyof LivePolicy, value: string) => setPolicy(old => ({ ...old, [key]: value === '' ? Number.NaN : Number(value) }))
  const fields: { key: keyof LivePolicy; label: string; min: number; max: number; step: string }[] = [
    { key: 'budget', label: 'Capital ceiling ($)', min: 0, max: 1e9, step: '0.01' },
    { key: 'reservePct', label: 'Cash reserve (%)', min: 0, max: 100, step: '0.1' },
    { key: 'maxPositionPct', label: 'Maximum position (%)', min: 1, max: 100, step: '0.1' },
    { key: 'maxOrderValue', label: 'Maximum order ($)', min: 1, max: 1e7, step: '0.01' },
    { key: 'minTradeValue', label: 'Minimum trade ($)', min: 1, max: 1e6, step: '0.01' },
    { key: 'driftPct', label: 'Minimum allocation drift (%)', min: 0.1, max: 20, step: '0.1' },
    { key: 'maxSpreadBps', label: 'Maximum spread (bps)', min: 1, max: 100, step: '1' },
  ]
  async function importDraft() {
    try {
      const draft = await hooks.draft.mutateAsync()
      setPolicy(old => ({ ...old, targets: draft.targets }))
      setImportNote(draft.note + (draft.marks?.length ? ' Source marks: ' + draft.marks.map(mark => `${mark.symbol} (${mark.asOf})`).join(', ') + '.' : ''))
    } catch { /* The mutation error is rendered below; preserve the existing draft. */ }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    hooks.policy.mutate({ policy, expectedVersion: data.version, confirmation })
  }
  return <section aria-labelledby="live-policy-heading" className="rounded-xl border border-border bg-card p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="live-policy-heading" className="text-lg font-semibold">Approved allocation & execution</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Set a capital ceiling and target weights for stocks and ETFs. Your agent can request trades within these limits; each request uses current broker evidence.</p></div>
      <span className="text-xs text-muted-foreground">Policy version {data.version}</span>
    </div>
    <form onSubmit={submit} className="mt-5 space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{fields.map(field => <label key={field.key} className="min-w-0 text-sm">
        {field.label}<input className={inputClass} type="number" min={field.min} max={field.max} step={field.step} required
          value={Number.isNaN(policy[field.key]) ? '' : String(policy[field.key])} onChange={e => setNumber(field.key, e.target.value)} />
      </label>)}</div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Target weights</h3>
        <Button type="button" variant="outline" disabled={hooks.draft.isPending} onClick={() => void importDraft()}>{hooks.draft.isPending ? 'Valuing simulator…' : 'Import Long-Term simulator draft'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Importing changes this draft only. Review every broker symbol: a mutual fund such as FXAIX is never silently replaced with an ETF. Target weights must leave the cash reserve.</p>
      {importNote && <p role="status" className="text-sm text-muted-foreground">{importNote}</p>}
      {!policy.targets.length && <p className="text-sm text-muted-foreground">Import the simulator allocation or add a target to begin.</p>}
      <div className="space-y-2">{policy.targets.map((target, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
        <label className="min-w-0 text-xs">Broker symbol {index + 1}<input className={inputClass} required value={target.symbol} maxLength={10}
          onChange={e => setPolicy(old => ({ ...old, targets: old.targets.map((t, i) => i === index ? { ...t, symbol: e.target.value.toUpperCase().trim() } : t) }))} /></label>
        <label className="min-w-0 text-xs">Target weight (%) {index + 1}<input className={inputClass} required type="number" min="0.01" max={policy.maxPositionPct} step="0.01" value={Number.isNaN(target.weightPct) ? '' : target.weightPct}
          onChange={e => setPolicy(old => ({ ...old, targets: old.targets.map((t, i) => i === index ? { ...t, weightPct: e.target.value === '' ? Number.NaN : Number(e.target.value) } : t) }))} /></label>
        <Button type="button" variant="ghost" aria-label={'Remove target ' + (index + 1)} onClick={() => setPolicy(old => ({ ...old, targets: old.targets.filter((_, i) => i !== index) }))}>Remove</Button>
      </div>)}</div>
      <Button type="button" variant="outline" disabled={policy.targets.length >= 30} onClick={() => setPolicy(old => ({ ...old, targets: [...old.targets, { symbol: '', weightPct: 0 }] }))}>Add target</Button>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.fractional} onChange={e => setPolicy(old => ({ ...old, fractional: e.target.checked }))} />Allow fractional shares when the broker asset supports them</label>
      <fieldset className="space-y-3 border-t border-border pt-4">
        <legend className="pr-2 font-medium">Investment agent execution mode</legend>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="radio" name="live-execution-mode" checked={policy.executionMode === 'confirm'} onChange={() => { setConfirmation(''); setPolicy(old => ({ ...old, executionMode: 'confirm' })) }} /><span><strong>Confirm every order</strong><br /><span className="text-muted-foreground">Your agent’s decisions wait for your order review and exact confirmation.</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="radio" name="live-execution-mode" checked={policy.executionMode === 'automatic'} onChange={() => { setConfirmation(''); setPolicy(old => ({ ...old, executionMode: 'automatic' })) }} /><span><strong>Automatic execution</strong><br /><span className="text-muted-foreground">A scoped strategy-agent decision can submit one guarded order immediately. This mode does not create scheduled trades on its own.</span></span></label>
      </fieldset>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={policy.paused} onChange={e => { setConfirmation(''); setPolicy(old => ({ ...old, paused: e.target.checked })) }} />Pause new live orders</label>
      <p className="text-xs text-muted-foreground">Pausing blocks new submissions. Existing broker orders remain active until filled or explicitly canceled. Cash income stays at Alpaca; simulator DRIP credits and tax previews do not create live transactions.</p>
      {!policy.paused && <label className="block text-sm">Type {phrase}<input className={inputClass} autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}
      {hooks.policy.error && <p role="alert" className="text-sm text-destructive">{hooks.policy.error.message}</p>}
      {hooks.draft.error && <p role="alert" className="text-sm text-destructive">{hooks.draft.error.message}</p>}
      <Button type="submit" disabled={hooks.policy.isPending || (!policy.paused && (confirmation !== phrase || !(policy.budget > 0) || !policy.targets.length))}>{hooks.policy.isPending ? 'Saving…' : 'Save live policy'}</Button>
    </form>
  </section>
}

function OwnershipReview({ data, hooks }: { data: LiveOverview; hooks: LiveHooks }) {
  const [symbol, setSymbol] = useState('')
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const position = data.positions.find(p => p.symbol === symbol)
  const qty = position?.qty ?? 0
  const phrase = `MANAGE ${symbol} ${qty} LIVE`
  return <details className="rounded-lg border border-border bg-card p-4">
    <summary className="cursor-pointer text-sm font-medium">Review ownership of existing holdings or corporate-action changes</summary>
    <p className="mt-3 text-sm text-muted-foreground">Pause new orders first. This records your approval to manage the currently verified broker quantity; it does not place an order or create a fill. Review the asset and any external trades or corporate actions at Alpaca.</p>
    <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); hooks.ownership.mutate({ symbol, qty, reason, confirmation }) }}>
      <label className="text-sm">Symbol to review<input className={inputClass} value={symbol} maxLength={10} onChange={e => { setSymbol(e.target.value.toUpperCase().trim()); setConfirmation('') }} required /></label>
      <div className="text-sm"><p>Verified broker quantity</p><p className="mt-3 font-semibold tabular-nums">{qty} shares</p></div>
      <label className="text-sm sm:col-span-2">Reason for ownership review<input className={inputClass} value={reason} minLength={10} maxLength={500} onChange={e => setReason(e.target.value)} required /></label>
      <label className="text-sm sm:col-span-2">Type {phrase}<input className={inputClass} autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
      <div className="sm:col-span-2"><Button type="submit" variant="outline" disabled={!symbol || !data.connected || !data.policy.paused || confirmation !== phrase || reason.trim().length < 10 || hooks.ownership.isPending}>Confirm reviewed ownership</Button></div>
    </form>
    {hooks.ownership.error && <p role="alert" className="mt-3 text-sm text-destructive">{hooks.ownership.error.message}</p>}
    {hooks.ownership.isSuccess && <p role="status" className="mt-3 text-sm">Ownership review recorded. Build a new preview after checking the policy.</p>}
  </details>
}

export function AlpacaLivePage() {
  const hooks = useAlpacaLive()
  const { data, isLoading, error } = hooks.overview
  const [confirmation, setConfirmation] = useState('')
  const plan = hooks.preview.data
  const [expired, setExpired] = useState(true)
  useEffect(() => {
    const tick = () => setExpired(!plan || Date.parse(plan.expiresAt) <= Date.now())
    tick()
    if (!plan) return
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [plan])
  const next = plan?.nextOrder
  const phrase = next ? `${next.side.toUpperCase()} ${next.symbol} LIVE` : ''
  function preview(decisionKey?: string) {
    setConfirmation(''); hooks.execute.reset()
    hooks.preview.mutate(decisionKey ? { decisionKey } : {})
  }
  return <main className="min-h-screen bg-background p-4 text-foreground sm:p-6">
    <div className="mx-auto max-w-[1600px] space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-300">Live money · Alpaca</p>
          <h1 className="mt-1 text-2xl font-bold">Long-Term Investing</h1><p className="mt-1 text-sm text-muted-foreground">Approved allocations, real broker fills, and a clear decision trail.</p></div>
        <Button variant="outline" disabled={hooks.overview.isFetching} onClick={() => void hooks.overview.refetch()}>{hooks.overview.isFetching ? 'Reconciling…' : 'Refresh & reconcile'}</Button>
      </header>
      {isLoading && <p role="status">Loading live investing…</p>}
      {error && <p role="alert" className="text-destructive">{error.message}</p>}
      {data && <>
        <section aria-label="Live account readiness" className="border-y border-border py-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"><strong>{data.connected ? `Live account ${data.accountLabel}` : 'Live account not connected'}</strong><span>{data.policy.paused ? 'New orders paused' : data.policy.executionMode === 'automatic' ? 'Automatic execution enabled' : 'Confirmation required'}</span></div>
          <ol className="mt-3 space-y-1 text-sm text-muted-foreground">
            {!data.configuration.configured && <li>Add the live key and secret in the server environment.</li>}
            {!data.configuration.accountBound && <li>Set the expected live account ID on the server.</li>}
            {!data.configuration.tradingEnabled && <li>Enable the server-side live-trading gate after reviewing the account and limits.</li>}
            {data.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}
          </ol>
          <dl className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">{[['Broker account equity', money(data.equity)], ['Broker cash', money(data.cash)], ['Capital ceiling', money(data.policy.budget)], ['Cash reserve', data.policy.reservePct + '%']].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd></div>)}</dl>
        </section>
        <PolicyEditor key={data.version} data={data} hooks={hooks} />
        <section aria-labelledby="live-decisions-heading" className="space-y-3">
          <h2 id="live-decisions-heading" className="text-lg font-semibold">Investment agent decisions</h2>
          {!data.decisions.length && <p className="text-sm text-muted-foreground">No live decisions yet. Give your investment agent the dedicated live-investing credential after deployment. Its requests need a saved research packet, strategy version, dated analysis and matched factual claims, and follow the saved allocation limits and execution mode.</p>}
          {data.decisions.slice(0, 20).map(d => {
            const submitted = data.orders.some(o => o.decisionKey === d.decision_key)
            return <article key={d.decision_key} className="rounded-lg border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><strong>{d.side.toUpperCase()} {d.symbol}</strong><span className="text-xs text-muted-foreground">{submitted ? 'Order recorded' : 'Awaiting review / readiness'}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{d.reason}</p>{d.analysis && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Research reviewed {new Date(d.analysis.analyzedAt).toLocaleString()}</summary><p className="mt-2">Strategy: {d.analysis.strategyVersion} · Model reported by agent: {d.analysis.model}</p><p className="mt-1 whitespace-pre-wrap break-words">Invalidation: {d.analysis.invalidation}</p></details>}<Button className="mt-3" variant="outline" disabled={submitted || hooks.preview.isPending || !data.connected} onClick={() => preview(d.decision_key)}>Review current order</Button></article>
          })}
        </section>
        <section aria-labelledby="live-preview-heading" className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-preview-heading" className="text-lg font-semibold">Allocation drift & next order</h2><Button variant="outline" disabled={!data.connected || hooks.preview.isPending} onClick={() => preview()}>{hooks.preview.isPending ? 'Checking broker evidence…' : 'Build fresh preview'}</Button></div>
          <p className="mt-2 text-sm text-muted-foreground">One order at a time, with sells before buys. Each preview lasts 60 seconds. IEX quotes are checked for age and spread; actual fills come from Alpaca.</p>
          {hooks.preview.error && <p role="alert" className="mt-3 text-sm text-destructive">{hooks.preview.error.message}</p>}
          {plan && <div className="mt-4 space-y-4">
            <p className="text-sm">Allocation capital {money(plan.allocationCapital)} · App-managed value {money(plan.managedValue)} · Available within limits {money(plan.spendableCash)} · Protected unrelated holdings {money(plan.unmanagedValue)}</p>
            {plan.blockers.length > 0 && <ul role="status" className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">{plan.blockers.map(b => <li key={b}>{b}</li>)}</ul>}
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Target allocation and proposed adjustments</caption><thead className="border-b border-border text-muted-foreground"><tr>{['Symbol', 'Owned shares', 'Target', 'Adjustment', 'Limit', 'Value'].map(t => <th key={t} className="whitespace-nowrap px-2 py-2 font-medium">{t}</th>)}</tr></thead><tbody>{plan.rows.map(r => <tr key={r.symbol} className="border-b border-border/60"><td className="px-2 py-3 font-medium">{r.symbol}</td><td className="px-2 py-3 tabular-nums">{r.currentQty}</td><td className="px-2 py-3 tabular-nums">{r.targetWeightPct}%</td><td className="whitespace-nowrap px-2 py-3">{r.actionable ? `${r.side.toUpperCase()} ${r.qty}` : 'Within threshold'}</td><td className="px-2 py-3">{money(r.limitPrice)}</td><td className="px-2 py-3">{money(r.notional)}</td></tr>)}</tbody></table></div>
            {!next && <p role="status" className="text-sm text-muted-foreground">No actionable order under the current allocation and thresholds.</p>}
            {next && <div className="space-y-3 border-t border-border pt-4"><p className="font-medium">Next: {next.side.toUpperCase()} {next.qty} {next.symbol} · DAY limit {money(next.limitPrice)} · up to {money(next.notional)}</p><label className="block max-w-md text-sm">Type {phrase}<input className={inputClass} autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label><Button variant="destructive" disabled={confirmation !== phrase || plan.blockers.length > 0 || expired || hooks.execute.isPending || hooks.execute.isSuccess || Boolean(error)} onClick={() => hooks.execute.mutate({ planId: plan.id, confirmation })}>{hooks.execute.isPending ? 'Submitting once…' : 'Submit live limit order'}</Button></div>}
            {expired && <p role="status" className="text-sm text-muted-foreground">Preview expired. Build a fresh preview before confirming.</p>}
          </div>}
          {hooks.execute.error && <p role="alert" className="mt-3 text-sm text-destructive">{hooks.execute.error.message}</p>}
          {hooks.execute.isSuccess && <p role="status" className="mt-3 text-sm">Order recorded. Accepted is not the same as filled; refresh to reconcile before the next trade.</p>}
        </section>
        <section aria-labelledby="live-holdings-heading"><h2 id="live-holdings-heading" className="text-lg font-semibold">Broker holdings</h2><p className="mt-1 text-sm text-muted-foreground">Confirmed app fills and explicit ownership reviews establish managed quantities. External holdings and corporate-action discrepancies require review.</p><div className="mt-3 space-y-2">{!data.positions.length && <p className="text-sm text-muted-foreground">No verified broker positions to display.</p>}{data.positions.map(p => <div key={p.symbol} className="flex flex-wrap justify-between gap-2 border-b border-border py-3 text-sm"><strong>{p.symbol}</strong><span>{p.qty} shares · {money(p.value)}</span><span className="text-muted-foreground">{p.managedQty > 0 ? `${p.managedQty} managed shares` : 'Protected external holding'}</span></div>)}</div></section>
        <OwnershipReview data={data} hooks={hooks} />
        <section aria-labelledby="live-orders-heading"><h2 id="live-orders-heading" className="text-lg font-semibold">Broker order evidence</h2>{!data.orders.length && <p className="mt-2 text-sm text-muted-foreground">No live orders have been submitted.</p>}<div className="mt-3 space-y-3">{data.orders.slice(0, 100).map(o => <article key={o.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"><div><strong className="text-sm">{o.side.toUpperCase()} {o.qty} {o.symbol}</strong><p className="mt-1 text-xs text-muted-foreground">{o.status} · filled {o.filledQty} · average {o.filledAvgPrice == null ? 'Pending' : money(o.filledAvgPrice)}</p></div>{!terminal.has(o.status) && <Button variant="outline" disabled={hooks.cancel.isPending} onClick={() => hooks.cancel.mutate(o.id)}>Cancel remaining {o.symbol}</Button>}</article>)}</div>{hooks.cancel.error && <p role="alert" className="mt-3 text-sm text-destructive">{hooks.cancel.error.message}</p>}</section>
      </>}
    </div>
  </main>
}
