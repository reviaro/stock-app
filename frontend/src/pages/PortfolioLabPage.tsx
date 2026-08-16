import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { usePortfolioLabAnalysis } from '@/hooks/usePortfolioLab'
import { useWatchlist } from '@/hooks/useWatchlist'
import { useSimAccount, useSimHoldings } from '@/hooks/useSimulator'
import { useAddStrategyRun, useStrategyExperiment, useStrategyExperiments } from '@/hooks/useStrategyLab'
import type { PortfolioLabModel, PortfolioLabResult } from '@/types/portfolioLab'

const inputClass = 'mt-1 w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary'
const buttonClass = 'rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50'

function parseSymbols(value: string) {
  return [...new Set(value.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
}

function Metric({ label, value, suffix = '' }: { label: string; value: number | undefined; suffix?: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3 py-2">
      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <strong className="text-sm">{value == null ? '—' : `${value.toFixed(2)}${suffix}`}</strong>
    </div>
  )
}

export function PortfolioLabPage() {
  const analysis = usePortfolioLabAnalysis()
  const watchlist = useWatchlist()
  const longTermAccount = useSimAccount(1)
  const longTermHoldings = useSimHoldings(1)
  const dayAccount = useSimAccount(2)
  const dayHoldings = useSimHoldings(2)
  const experiments = useStrategyExperiments()

  const [symbolsText, setSymbolsText] = useState('AAPL, MSFT, JPM, JNJ')
  const symbols = useMemo(() => parseSymbols(symbolsText), [symbolsText])
  const [currentWeights, setCurrentWeights] = useState<Record<string, number>>({})
  const [cashTarget, setCashTarget] = useState(10)
  const [maxPosition, setMaxPosition] = useState(35)
  const [maxSector, setMaxSector] = useState(55)
  const [costBps, setCostBps] = useState(10)
  const [lookbackYears, setLookbackYears] = useState(3)
  const [trainDays, setTrainDays] = useState(252)
  const [testDays, setTestDays] = useState(63)
  const [result, setResult] = useState<PortfolioLabResult | null>(null)
  const [selectedModelId, setSelectedModelId] = useState('equal_weight')
  const [error, setError] = useState('')
  const [sourceMessage, setSourceMessage] = useState('')
  const [selectedExperimentId, setSelectedExperimentId] = useState<number | null>(null)
  const [evidenceMessage, setEvidenceMessage] = useState('')

  const experiment = useStrategyExperiment(selectedExperimentId)
  const latestVersion = experiment.data?.versions.at(-1) ?? null
  const addEvidence = useAddStrategyRun(selectedExperimentId, latestVersion?.id ?? null)
  const selectedModel = result?.models.find((model) => model.id === selectedModelId && model.status === 'success') ?? null

  function loadSymbols(nextSymbols: string[], weights: Record<string, number>, label: string) {
    const limited = nextSymbols.slice(0, 30)
    setSymbolsText(limited.join(', '))
    setCurrentWeights(weights)
    setResult(null)
    setEvidenceMessage('')
    setSourceMessage(nextSymbols.length > 30 ? `${label}: loaded the first 30 symbols.` : `${label}: loaded ${limited.length} symbols.`)
  }

  function loadWatchlist() {
    const values = (watchlist.data ?? []).map((item) => item.symbol)
    loadSymbols(values, {}, 'Watchlist')
  }

  function loadSleeve(accountId: number) {
    const holdings = accountId === 1 ? longTermHoldings.data : dayHoldings.data
    const account = accountId === 1 ? longTermAccount.data : dayAccount.data
    const total = Number(account?.total_value || 0)
    if (!Number.isFinite(total) || total <= 0 || !holdings?.length
      || holdings.some((holding) => holding.currentValue == null || !Number.isFinite(holding.currentValue))) {
      setError('Sleeve current values are unavailable. Refresh market data before deriving allocation weights.')
      return
    }
    const weights = Object.fromEntries((holdings ?? []).map((holding) => [
      holding.symbol,
      Number(((holding.currentValue! / total) * 100).toFixed(4)),
    ]))
    setError('')
    loadSymbols((holdings ?? []).map((holding) => holding.symbol), weights, accountId === 1 ? 'Long-Term sleeve' : 'Day Trading sleeve')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setEvidenceMessage('')
    if (symbols.length < 3) {
      setError('Select at least three unique symbols.')
      return
    }
    try {
      const data = await analysis.mutateAsync({
        symbols,
        current_weights_pct: Object.fromEntries(symbols.map((symbol) => [symbol, Number(currentWeights[symbol] || 0)])),
        cash_target_pct: cashTarget,
        max_position_pct: maxPosition,
        max_sector_pct: maxSector,
        transaction_cost_bps: costBps,
        lookback_years: lookbackYears,
        train_days: trainDays,
        test_days: testDays,
      })
      setResult(data)
      const firstSuccess = data.models.find((model) => model.status === 'success')
      setSelectedModelId(firstSuccess?.id ?? 'equal_weight')
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Portfolio Lab analysis failed')
    }
  }

  async function recordEvidence() {
    if (!selectedModel?.strategy_lab_evidence || !latestVersion) return
    setEvidenceMessage('')
    try {
      await addEvidence.mutateAsync(selectedModel.strategy_lab_evidence)
      setEvidenceMessage(`Evidence recorded for ${selectedModel.name} in version ${latestVersion.version_number}.`)
    } catch (recordError) {
      setEvidenceMessage(recordError instanceof Error ? recordError.message : 'Unable to record evidence')
    }
  }

  return (
    <main className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <header>
          <h1 className="text-2xl font-bold">Portfolio Lab</h1>
          <p className="mt-1 text-xs text-muted-foreground">Read-only allocation research. It compares constrained models and may record evidence in Strategy Lab; it cannot place orders or modify portfolio ledgers.</p>
        </header>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[430px_1fr]">
          <form className="space-y-4" onSubmit={submit}>
            <Card>
              <CardHeader className="pb-2"><CardTitle>1. Universe and current weights</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} onClick={loadWatchlist}>Load Watchlist</button>
                  <button type="button" className={buttonClass} onClick={() => loadSleeve(1)}>Load Long-Term sleeve</button>
                  <button type="button" className={buttonClass} onClick={() => loadSleeve(2)}>Load Day Trading sleeve</button>
                </div>
                {sourceMessage && <p className="text-xs text-muted-foreground">{sourceMessage}</p>}
                <label className="block text-xs text-muted-foreground">Selected symbols
                  <textarea aria-label="Selected symbols" rows={3} value={symbolsText} onChange={(event) => { setSymbolsText(event.target.value); setResult(null) }} className={inputClass} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {symbols.map((symbol) => (
                    <label key={symbol} className="block text-[11px] text-muted-foreground">{symbol} current %
                      <input aria-label={`${symbol} current weight`} type="number" min="0" max="100" step="any" value={currentWeights[symbol] ?? 0} onChange={(event) => setCurrentWeights((current) => ({ ...current, [symbol]: Number(event.target.value) }))} className={inputClass} />
                    </label>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle>2. Constraints and validation</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-2">
                <NumberField label="Cash target %" value={cashTarget} setValue={setCashTarget} min={0} max={90} />
                <NumberField label="Max position %" value={maxPosition} setValue={setMaxPosition} min={1} max={100} />
                <NumberField label="Max sector %" value={maxSector} setValue={setMaxSector} min={1} max={100} />
                <NumberField label="Trading cost (bps)" value={costBps} setValue={setCostBps} min={0} max={100} />
                <NumberField label="History (years)" value={lookbackYears} setValue={setLookbackYears} min={1} max={10} />
                <NumberField label="Training days" value={trainDays} setValue={setTrainDays} min={126} max={756} />
                <NumberField label="Test days / fold" value={testDays} setValue={setTestDays} min={21} max={252} />
                <div className="flex items-end"><span className="pb-2 text-[11px] text-muted-foreground">Rolling, non-overlapping test windows</span></div>
                <button type="submit" disabled={analysis.isPending} className="col-span-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{analysis.isPending ? 'Running models…' : 'Run Portfolio Lab'}</button>
                {error && <p role="alert" className="col-span-2 text-xs text-destructive">{error}</p>}
              </CardContent>
            </Card>
          </form>

          <section className="space-y-4">
            {!result && <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Choose at least three symbols, set the risk constraints, and run the lab. The calculation may take a minute while market history is collected.</CardContent></Card>}
            {result && (
              <>
                <Card>
                  <CardHeader className="pb-2"><CardTitle>3. Walk-forward model comparison</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>{result.validation.fold_count} rolling folds</span>
                      <span>{result.validation.train_days} training days</span>
                      <span>{result.validation.test_days} test days</span>
                      {result.validation.includes_partial_final_fold && <span>Final fold: {result.validation.fold_lengths_days.at(-1)} days</span>}
                      <span>{result.validation.out_of_sample_start}–{result.validation.out_of_sample_end}</span>
                      <span>Complete shared adjusted prices from {result.data_quality.provider}; no forward fill</span>
                      <span>{result.engine.name} {result.engine.version}</span>
                    </div>
                    {result.warnings.map((warning) => <p key={warning} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">{warning}</p>)}
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[850px] text-xs">
                        <thead className="text-muted-foreground"><tr><th className="text-left">Model</th><th>OOS return</th><th>Benchmark</th><th>Volatility</th><th>Max DD</th><th>Sharpe</th><th>Turnover</th><th>Costs</th></tr></thead>
                        <tbody>{result.models.map((model) => <ModelRow key={model.id} model={model} selected={selectedModelId === model.id} onSelect={() => model.status === 'success' && setSelectedModelId(model.id)} />)}</tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                {selectedModel?.out_of_sample && (
                  <Card>
                    <CardHeader className="pb-2"><CardTitle>Selected allocation</CardTitle></CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs text-muted-foreground">Current target weights use all available history. Out-of-sample metrics come only from the rolling test folds. Sharpe assumes a 0% risk-free rate. Constraint handling: {selectedModel.constraint_handling === 'native_optimization' ? 'native optimizer constraints' : 'post-optimization projection'}.</p>
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                        <Metric label="Annual return" value={selectedModel.out_of_sample.annualized_return_pct} suffix="%" />
                        <Metric label="Annual volatility" value={selectedModel.out_of_sample.annualized_volatility_pct} suffix="%" />
                        <Metric label="Max drawdown" value={selectedModel.out_of_sample.max_drawdown_pct} suffix="%" />
                        <Metric label="Cash" value={selectedModel.cash_weight_pct} suffix="%" />
                        <Metric label="Current target turnover" value={selectedModel.current_target_turnover_pct ?? undefined} suffix="%" />
                      </div>
                      <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs"><thead className="text-muted-foreground"><tr><th className="text-left">Symbol</th><th className="text-left">Sector</th><th className="text-right">Target weight</th><th className="text-right">Current weight</th></tr></thead><tbody>{selectedModel.target_weights.map((row) => <tr key={row.symbol} className="border-t border-border/60"><td className="py-1.5 font-semibold">{row.symbol}</td><td>{row.sector}</td><td className="text-right">{row.weight_pct.toFixed(2)}%</td><td className="text-right">{Number(currentWeights[row.symbol] || 0).toFixed(2)}%</td></tr>)}</tbody></table></div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-2"><CardTitle>4. Strategy Lab evidence</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-xs text-muted-foreground">This stores only the selected model’s out-of-sample metrics in an existing strategy version.</p>
                    <select aria-label="Evidence experiment" value={selectedExperimentId ?? ''} onChange={(event) => setSelectedExperimentId(event.target.value ? Number(event.target.value) : null)} className={inputClass}>
                      <option value="">Select an experiment</option>
                      {experiments.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    {selectedExperimentId == null && <p className="text-xs text-amber-500">Explicitly select the matching allocation experiment. Nothing is selected automatically.</p>}
                    {!latestVersion && selectedExperimentId != null && <p className="text-xs text-amber-500">Create a rule version in Research Lab before recording evidence.</p>}
                    <button type="button" disabled={!selectedModel?.strategy_lab_evidence || !latestVersion || addEvidence.isPending} onClick={() => void recordEvidence()} className={buttonClass}>Record selected result as evidence</button>
                    {evidenceMessage && <p className="text-xs text-green-500">{evidenceMessage}</p>}
                  </CardContent>
                </Card>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

function NumberField({ label, value, setValue, min, max }: { label: string; value: number; setValue: (value: number) => void; min: number; max: number }) {
  return <label className="block text-[11px] text-muted-foreground">{label}<input type="number" step="any" min={min} max={max} required value={value} onChange={(event) => setValue(Number(event.target.value))} className={inputClass} /></label>
}

function ModelRow({ model, selected, onSelect }: { model: PortfolioLabModel; selected: boolean; onSelect: () => void }) {
  if (model.status === 'error' || !model.out_of_sample) {
    return <tr className="border-t border-border/60"><td className="py-2 font-semibold">{model.name}</td><td colSpan={7} className="text-destructive">{model.error || 'Model failed'}</td></tr>
  }
  const metrics = model.out_of_sample
  return (
    <tr className={`border-t border-border/60 ${selected ? 'bg-primary/10' : ''}`}>
      <td className="py-1.5"><button type="button" aria-label={`Select ${model.name}`} onClick={onSelect} className="rounded px-2 py-1 text-left font-semibold transition-colors hover:bg-secondary">{model.name}</button></td>
      <td className="text-center">{metrics.total_return_pct.toFixed(2)}%</td><td className="text-center">{metrics.benchmark_return_pct.toFixed(2)}%</td><td className="text-center">{metrics.annualized_volatility_pct.toFixed(2)}%</td><td className="text-center">{metrics.max_drawdown_pct.toFixed(2)}%</td><td className="text-center">{metrics.sharpe.toFixed(2)}</td><td className="text-center">{metrics.turnover_pct.toFixed(2)}%</td><td className="text-center">{metrics.transaction_cost_pct.toFixed(3)}%</td>
    </tr>
  )
}
