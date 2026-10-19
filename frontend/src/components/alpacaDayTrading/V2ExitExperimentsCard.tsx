import { useState, type FormEvent } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCreateV2Experiment, useV2Experiments } from '@/hooks/useAlpacaDayTradingV2'
import { v2ErrorMessage } from '@/lib/alpacaV2Errors'
import type { AlpacaV2Experiment, AlpacaV2ExperimentDefinition } from '@/types/alpacaDayTrading'
import { time, usd } from './v2Format'

const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const tokenValid = (value: string) => value === '*' || /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value)
const inRange = (value: string, min: number, max: number, integer = false) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max && (!integer || Number.isInteger(Number(value)))

function ExperimentForm() {
  const create = useCreateV2Experiment()
  const [name, setName] = useState('')
  const [setupId, setSetupId] = useState('*')
  const [strategyVersion, setStrategyVersion] = useState('*')
  const [kind, setKind] = useState<'stall_exit' | 'atr_target'>('stall_exit')
  const [afterMinutes, setAfterMinutes] = useState('30')
  const [minimumProgressR, setMinimumProgressR] = useState('0.25')
  const [atrMultiple, setAtrMultiple] = useState('2')
  const [durationDays, setDurationDays] = useState('30')
  const [minTrades, setMinTrades] = useState('30')
  const [costBps, setCostBps] = useState('0')
  const valid = name.trim().length > 0 && name.trim().length <= 80 && tokenValid(setupId) && tokenValid(strategyVersion)
    && inRange(durationDays, 1, 90, true) && inRange(minTrades, 1, 1000, true) && inRange(costBps, 0, 100)
    && (kind === 'stall_exit' ? inRange(afterMinutes, 5, 240, true) && inRange(minimumProgressR, 0, 1) : inRange(atrMultiple, 0.25, 10))
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || create.isPending) return
    const base = { name: name.trim(), setupId, strategyVersion, durationDays: Number(durationDays), minTrades: Number(minTrades), costBps: Number(costBps) }
    const definition: AlpacaV2ExperimentDefinition = kind === 'stall_exit'
      ? { ...base, kind, parameters: { afterMinutes: Number(afterMinutes), minimumProgressR: Number(minimumProgressR) } }
      : { ...base, kind, parameters: { atrMultiple: Number(atrMultiple) } }
    create.mutate(definition, { onSuccess: () => setName('') })
  }
  return (
    <form onSubmit={submit} className="space-y-3" onChange={() => { if (create.isError || create.isSuccess) create.reset() }}>
      <fieldset disabled={create.isPending} className="space-y-3">
        <legend className="sr-only">New shadow exit experiment</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1"><span className="block">Experiment name</span><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
          <label className="space-y-1"><span className="block">Stable setup ID</span><input className={inputClass} value={setupId} onChange={(event) => setSetupId(event.target.value)} required aria-describedby="v2-experiment-scope" /></label>
          <label className="space-y-1"><span className="block">Strategy version</span><input className={inputClass} value={strategyVersion} onChange={(event) => setStrategyVersion(event.target.value)} required aria-describedby="v2-experiment-scope" /></label>
          <div className="space-y-1"><label htmlFor="v2-experiment-kind" className="block">Exit hypothesis</label><select id="v2-experiment-kind" className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="stall_exit">Stalled progress exit</option><option value="atr_target">ATR target</option></select></div>
          {kind === 'stall_exit' ? <>
            <label className="space-y-1"><span className="block">Check after minutes (5–240)</span><input type="number" className={inputClass} value={afterMinutes} onChange={(event) => setAfterMinutes(event.target.value)} min={5} max={240} step={1} required /></label>
            <label className="space-y-1"><span className="block">Minimum progress R (0–1)</span><input type="number" className={inputClass} value={minimumProgressR} onChange={(event) => setMinimumProgressR(event.target.value)} min={0} max={1} step="any" required /></label>
          </> : <label className="space-y-1"><span className="block">ATR multiple (0.25–10)</span><input type="number" className={inputClass} value={atrMultiple} onChange={(event) => setAtrMultiple(event.target.value)} min={0.25} max={10} step="any" required /></label>}
          <label className="space-y-1"><span className="block">Collection days (1–90)</span><input type="number" className={inputClass} value={durationDays} onChange={(event) => setDurationDays(event.target.value)} min={1} max={90} step={1} required /></label>
          <label className="space-y-1"><span className="block">Minimum trades (1–1,000)</span><input type="number" className={inputClass} value={minTrades} onChange={(event) => setMinTrades(event.target.value)} min={1} max={1000} step={1} required /></label>
          <label className="space-y-1"><span className="block">Assumed cost per side (0–100 bps)</span><input type="number" className={inputClass} value={costBps} onChange={(event) => setCostBps(event.target.value)} min={0} max={100} step="any" required aria-describedby="v2-experiment-cost" /></label>
        </div>
        <p id="v2-experiment-scope" className="text-muted-foreground">Use * for every setup or version. Otherwise copy the stable label from analytics: start with a letter, then use letters, numbers, underscores, dots, or hyphens (up to 64 characters).</p>
        <p id="v2-experiment-cost" className="text-muted-foreground">One basis point is 0.01%. This assumption is charged on each entry and exit; 0 means no costs are modeled.</p>
        <p className="text-muted-foreground">Starts when saved and includes only future eligible trades. Definitions are fixed once started. This records a shadow comparison and never changes broker orders or execution mode.</p>
        <Button type="submit" size="sm" variant="outline" disabled={!valid || create.isPending}>{create.isPending ? 'Starting…' : 'Start shadow experiment'}</Button>
      </fieldset>
      {create.isError && <p role="alert" className="text-destructive">{v2ErrorMessage(create.error)}</p>}
      {create.isSuccess && <p role="status" className="text-positive">Shadow experiment started. Future eligible trades will contribute observations.</p>}
    </form>
  )
}

function ExperimentResult({ experiment: e }: { experiment: AlpacaV2Experiment }) {
  const r = e.results
  return (
    <article className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-semibold">{e.name}</h3><Badge variant="outline">{r.status === 'complete' ? 'Collection ended' : 'Collecting'}</Badge><Badge variant="secondary">{r.minimumTradesMet ? 'Minimum sample reached' : 'Preliminary sample'}</Badge></div>
      <p className="break-words text-muted-foreground">Setup: {e.setupId === '*' ? 'all' : e.setupId} · Version: {e.strategyVersion === '*' ? 'all' : e.strategyVersion} · {time(e.createdAt)}–{time(e.endsAt)} ET</p>
      <p>{e.kind === 'stall_exit' ? 'Stall exit if sampled progress has not reached ' + e.parameters.minimumProgressR + 'R at the first check after ' + e.parameters.afterMinutes + ' minutes.' : 'Target at ' + e.parameters.atrMultiple + ' × entry ATR.'} Cost assumption: {e.costBps} bps per side.</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Eligible trades</dt><dd>{r.eligibleCount} / {e.minTrades} minimum</dd></div>
        <div><dt className="text-muted-foreground">Excluded trades</dt><dd>{r.excludedCount}</dd></div>
        <div><dt className="text-muted-foreground">Sampled triggers</dt><dd>{r.triggeredCount}</dd></div>
        <div><dt className="text-muted-foreground">Mean net difference</dt><dd className="font-mono">{usd(r.meanDifferenceNetPnl)}</dd></div>
      </dl>
      <div className="overflow-x-auto" role="region" aria-label={e.name + ' estimated outcomes'} tabIndex={0}>
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">Baseline and sampled hypothetical exit results</caption>
          <thead className="text-muted-foreground"><tr><th scope="col" className="py-2">Outcome</th><th scope="col">Gross P&amp;L</th><th scope="col">Net after assumed costs</th></tr></thead>
          <tbody><tr className="border-t border-border"><th scope="row" className="py-2 font-normal">Baseline</th><td className="font-mono">{usd(r.baselineGrossPnl)}</td><td className="font-mono">{usd(r.baselineNetPnl)}</td></tr><tr className="border-t border-border"><th scope="row" className="py-2 font-normal">Shadow estimate</th><td className="font-mono">{usd(r.shadowGrossPnl)}</td><td className="font-mono">{usd(r.shadowNetPnl)}</td></tr></tbody>
        </table>
      </div>
      <p>Estimated net difference: <span className="font-mono">{usd(r.differenceNetPnl)}</span></p>
      {Object.keys(r.exclusions).length > 0 && <p className="break-words text-muted-foreground">Excluded: {Object.entries(r.exclusions).map(([reason, count]) => reason.replace(/_/g, ' ') + ' (' + count + ')').join(' · ')}</p>}
    </article>
  )
}

export function V2ExitExperimentsCard() {
  const { data, isLoading, isError } = useV2Experiments()
  return (
    <section aria-label="Shadow exit experiments">
      <Card>
        <CardHeader className="pb-2"><CardTitle>Shadow exit experiments</CardTitle></CardHeader>
        <CardContent className="space-y-3 px-3 pb-4 text-xs">
          <p className="text-muted-foreground">Forward-only comparisons using sampled prices. Results are hypothetical estimates; sparse observations can miss triggers and cannot reproduce executable fills. Existing broker exits stay in place.</p>
          <details className="rounded-md border border-border p-3"><summary className="cursor-pointer py-1 font-medium">Define a future experiment</summary><div className="pt-3"><ExperimentForm /></div></details>
          {isLoading && <p className="text-muted-foreground">Loading experiments…</p>}
          {isError && <p role="alert" className="text-destructive">Unable to load experiments.</p>}
          {data?.experiments.length === 0 && <p className="text-muted-foreground">No shadow experiments yet. Define a hypothesis before collecting the trades used to assess it.</p>}
          {data?.experiments.map((experiment) => <ExperimentResult key={experiment.id} experiment={experiment} />)}
        </CardContent>
      </Card>
    </section>
  )
}
