import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  useAddStrategyRun,
  useAddStrategyVersion,
  useCreateStrategyExperiment,
  useStrategyExperiment,
  useStrategyExperiments,
} from '@/hooks/useStrategyLab'
import type { PromotionGate, StrategyRunType } from '@/types/strategyLab'

function blockerLabel(value: string) {
  return value.replaceAll('_', ' ')
}

function Gate({ label, gate }: { label: string; gate: PromotionGate }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${gate.ready ? 'border-green-500/40 bg-green-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
      <div className="flex items-center justify-between gap-2">
        <strong>{label}</strong>
        <span className="uppercase text-[10px] font-semibold">{gate.ready ? 'evidence complete' : 'blocked'}</span>
      </div>
      {!gate.ready && <p className="mt-1 text-muted-foreground">{gate.blockers.map(blockerLabel).join(' · ')}</p>}
    </div>
  )
}

export function StrategyLabPage() {
  const experiments = useStrategyExperiments()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const detail = useStrategyExperiment(selectedId)
  const createExperiment = useCreateStrategyExperiment()
  const latestVersion = detail.data?.versions.at(-1) ?? null
  const addVersion = useAddStrategyVersion(selectedId)
  const addRun = useAddStrategyRun(selectedId, latestVersion?.id ?? null)

  const [name, setName] = useState('')
  const [hypothesis, setHypothesis] = useState('')
  const [rulesJson, setRulesJson] = useState('{\n  "entry": {},\n  "exit": {},\n  "sizing": {},\n  "regime_filter": {}\n}')
  const [versionNotes, setVersionNotes] = useState('')
  const [rulesError, setRulesError] = useState('')
  const [run, setRun] = useState({
    run_type: 'backtest' as StrategyRunType,
    start_date: '', end_date: '', trade_count: '', total_return_pct: '', benchmark_return_pct: '',
    max_drawdown_pct: '', sharpe: '', win_rate: '', expectancy: '', avg_r: '', notes: '',
  })

  useEffect(() => {
    if (selectedId == null && experiments.data?.length) setSelectedId(experiments.data[0].id)
  }, [experiments.data, selectedId])

  const selectedSummary = useMemo(
    () => experiments.data?.find((experiment) => experiment.id === selectedId),
    [experiments.data, selectedId],
  )

  async function submitExperiment(event: React.FormEvent) {
    event.preventDefault()
    const created = await createExperiment.mutateAsync({ name, hypothesis })
    setName('')
    setHypothesis('')
    setSelectedId(created.id)
  }

  async function submitVersion(event: React.FormEvent) {
    event.preventDefault()
    try {
      const rules = JSON.parse(rulesJson)
      if (!rules || typeof rules !== 'object' || Object.keys(rules).length === 0) throw new Error('Rules must be a non-empty JSON object.')
      setRulesError('')
      await addVersion.mutateAsync({ rules, notes: versionNotes })
      setVersionNotes('')
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('Rules'))) {
        setRulesError(error instanceof Error ? error.message : 'Rules must be valid JSON.')
        return
      }
      throw error
    }
  }

  async function submitRun(event: React.FormEvent) {
    event.preventDefault()
    const optionalNumber = (value: string) => value === '' ? undefined : Number(value)
    await addRun.mutateAsync({
      run_type: run.run_type,
      start_date: run.start_date,
      end_date: run.end_date,
      trade_count: Number(run.trade_count),
      total_return_pct: Number(run.total_return_pct),
      benchmark_return_pct: Number(run.benchmark_return_pct),
      max_drawdown_pct: Number(run.max_drawdown_pct),
      sharpe: optionalNumber(run.sharpe),
      win_rate: optionalNumber(run.win_rate),
      expectancy: optionalNumber(run.expectancy),
      avg_r: optionalNumber(run.avg_r),
      notes: run.notes,
    })
  }

  const updateRun = (field: keyof typeof run, value: string) => setRun((current) => ({ ...current, [field]: value }))

  return (
    <main className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <header>
          <h1 className="text-2xl font-bold">Strategy Research Lab</h1>
          <p className="mt-1 text-xs text-muted-foreground">Evidence registry only. It records hypotheses and test results; it cannot promote a strategy or place an order.</p>
        </header>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle>New hypothesis</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-2" onSubmit={submitExperiment}>
                  <label className="block text-xs text-muted-foreground">Name<input value={name} onChange={(event) => setName(event.target.value)} required className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-foreground" /></label>
                  <label className="block text-xs text-muted-foreground">Hypothesis<textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} required rows={3} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-foreground" /></label>
                  <button disabled={createExperiment.isPending} className="w-full rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">Create experiment</button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle>Experiments</CardTitle></CardHeader>
              <CardContent className="space-y-2 px-3">
                {experiments.isLoading && <p className="text-xs text-muted-foreground">Loading experiments…</p>}
                {experiments.data?.map((experiment) => (
                  <button key={experiment.id} type="button" onClick={() => setSelectedId(experiment.id)} className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${selectedId === experiment.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary'}`}>
                    <strong className="block text-foreground">{experiment.name}</strong>
                    <span className="mt-1 line-clamp-2 text-muted-foreground">{experiment.hypothesis}</span>
                  </button>
                ))}
                {!experiments.isLoading && experiments.data?.length === 0 && <p className="text-xs text-muted-foreground">No hypotheses recorded yet.</p>}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            {selectedSummary && <Card><CardContent className="pt-4"><h2 className="text-lg font-semibold">{detail.data?.name ?? selectedSummary.name}</h2><p className="mt-1 text-sm text-muted-foreground">{detail.data?.hypothesis ?? selectedSummary.hypothesis}</p></CardContent></Card>}

            {detail.data && (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Gate label="Paper evidence gate" gate={detail.data.promotion_readiness.paper} />
                  <Gate label="Live evidence gate (informational only)" gate={detail.data.promotion_readiness.live} />
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <Card>
                    <CardHeader className="pb-2"><CardTitle>Add strategy version</CardTitle></CardHeader>
                    <CardContent>
                      <form className="space-y-2" onSubmit={submitVersion}>
                        <label className="block text-xs text-muted-foreground">Rules JSON<textarea aria-label="Rules JSON" value={rulesJson} onChange={(event) => setRulesJson(event.target.value)} rows={10} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground" /></label>
                        {rulesError && <p className="text-xs text-destructive">{rulesError}</p>}
                        <label className="block text-xs text-muted-foreground">Version notes<textarea value={versionNotes} onChange={(event) => setVersionNotes(event.target.value)} rows={2} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-foreground" /></label>
                        <button disabled={addVersion.isPending} className="w-full rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">Save new version</button>
                      </form>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2"><CardTitle>Record evidence run {latestVersion ? `· v${latestVersion.version_number}` : ''}</CardTitle></CardHeader>
                    <CardContent>
                      {!latestVersion ? <p className="text-xs text-muted-foreground">Create a measurable rule version before recording results.</p> : (
                        <form className="grid grid-cols-2 gap-2" onSubmit={submitRun}>
                          <Field label="Run type"><select aria-label="Run type" value={run.run_type} onChange={(event) => updateRun('run_type', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground"><option value="backtest">Backtest</option><option value="out_of_sample">Out of sample</option><option value="paper">Paper</option></select></Field>
                          <Field label="Trade count"><input type="number" min="0" required value={run.trade_count} onChange={(event) => updateRun('trade_count', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Start date"><input type="date" required value={run.start_date} onChange={(event) => updateRun('start_date', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="End date"><input type="date" required value={run.end_date} onChange={(event) => updateRun('end_date', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Return %"><input type="number" step="any" required value={run.total_return_pct} onChange={(event) => updateRun('total_return_pct', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Benchmark %"><input type="number" step="any" required value={run.benchmark_return_pct} onChange={(event) => updateRun('benchmark_return_pct', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Max drawdown %"><input type="number" step="any" min="0" required value={run.max_drawdown_pct} onChange={(event) => updateRun('max_drawdown_pct', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Sharpe"><input type="number" step="any" value={run.sharpe} onChange={(event) => updateRun('sharpe', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Win rate %"><input type="number" step="any" value={run.win_rate} onChange={(event) => updateRun('win_rate', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Expectancy"><input type="number" step="any" value={run.expectancy} onChange={(event) => updateRun('expectancy', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Average R"><input type="number" step="any" value={run.avg_r} onChange={(event) => updateRun('avg_r', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <Field label="Notes"><input value={run.notes} onChange={(event) => updateRun('notes', event.target.value)} className="mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground" /></Field>
                          <button disabled={addRun.isPending} className="col-span-2 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">Record evidence</button>
                        </form>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader className="pb-2"><CardTitle>Version history and independent results</CardTitle></CardHeader>
                  <CardContent className="space-y-3 px-3">
                    {detail.data.versions.length === 0 && <p className="text-xs text-muted-foreground">No rule versions yet.</p>}
                    {detail.data.versions.map((version) => (
                      <div key={version.id} className="rounded-md border border-border p-3 text-xs">
                        <div className="flex items-center justify-between"><strong>Version {version.version_number}</strong><span className="text-muted-foreground">{version.runs.length} evidence run(s)</span></div>
                        <pre className="mt-2 overflow-x-auto rounded bg-secondary/70 p-2 text-[11px]">{JSON.stringify(version.rules, null, 2)}</pre>
                        {version.runs.length > 0 && <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[700px]"><thead className="text-muted-foreground"><tr><th className="text-left">Type</th><th>Period</th><th>Trades</th><th>Return</th><th>Benchmark</th><th>Max DD</th><th>Avg R</th></tr></thead><tbody>{version.runs.map((item) => <tr key={item.id} className="border-t border-border/60"><td>{blockerLabel(item.run_type)}</td><td className="text-center">{item.start_date}–{item.end_date}</td><td className="text-center">{item.trade_count}</td><td className="text-center">{item.total_return_pct}%</td><td className="text-center">{item.benchmark_return_pct}%</td><td className="text-center">{item.max_drawdown_pct}%</td><td className="text-center">{item.avg_r == null ? '—' : `${item.avg_r}R`}</td></tr>)}</tbody></table></div>}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </>
            )}
            {selectedId != null && detail.isLoading && <p className="text-xs text-muted-foreground">Loading experiment evidence…</p>}
          </div>
        </div>
      </div>
    </main>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] text-muted-foreground">{label}{children}</label>
}
