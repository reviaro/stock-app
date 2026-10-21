import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface Definition { strategyVersion: string; model: string; benchmark: string; durationDays: number; horizonDays: number; minDecisions: number; costBps: number }
interface EvaluationRow { id: string; definition_json: string; created_at: string; ends_at: string }
interface Reference { id: string; contentHash: string }
interface Report { assessment: { observationCount: number; meanBuyExcessReturnPct: number | null; decisionAccuracyPct: number | null; blockers: string[]; limitations: string[] } }
const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/research/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const json = await res.json()
  if (!res.ok || json.status !== 'success') throw new Error(json.error || 'Research evaluation unavailable')
  return json.data as T
}
export function ResearchEvaluationPanel() {
  const client = useQueryClient()
  const [definition, setDefinition] = useState<Definition>({ strategyVersion: '', model: '', benchmark: 'SPY', durationDays: 30, horizonDays: 90, minDecisions: 30, costBps: 10 })
  const [selectedId, setSelectedId] = useState('')
  const [symbol, setSymbol] = useState('')
  const [action, setAction] = useState('hold')
  const [reason, setReason] = useState('')
  const [actualModel, setActualModel] = useState('')
  const [actualStrategy, setActualStrategy] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const rows = useQuery({ queryKey: ['research-evaluations'], queryFn: () => api<EvaluationRow[]>('evaluations'), retry: 1 })
  const report = useQuery({ queryKey: ['research-evaluation', selectedId], queryFn: () => api<Report>(`evaluations/${selectedId}`), enabled: Boolean(selectedId), retry: 1 })
  async function perform(task: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('')
    try { await task(); await client.invalidateQueries({ queryKey: ['research-evaluations'] }); await client.invalidateQueries({ queryKey: ['research-evaluation', selectedId] }) } catch (e) { setError(e instanceof Error ? e.message : 'Action failed') } finally { setBusy(false) }
  }
  return <Card className="mt-6">
    <CardHeader><CardTitle className="text-lg">Agent research evaluations</CardTitle></CardHeader>
    <CardContent className="space-y-5">
      <p className="text-sm text-muted-foreground">For long-term account 1, freeze a strategy, model, benchmark and evaluation window before collecting decisions. These trials measure prospective research outcomes and never place orders or promote a live strategy.</p>
      <details><summary className="cursor-pointer text-sm font-medium">Create a prospective evaluation</summary>
        <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); void perform(async () => { const result = await api<{ id: string }>('evaluations', definition); setSelectedId(result.id); setMessage('Evaluation definition saved. It cannot be changed.') }) }}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(['strategyVersion', 'model', 'benchmark'] as const).map(key => <label className="text-xs" key={key}>{key === 'strategyVersion' ? 'Strategy version' : key === 'model' ? 'Agent model identifier' : 'Benchmark ticker'}<input required className={field} value={definition[key]} onChange={e => setDefinition(v => ({ ...v, [key]: key === 'benchmark' ? e.target.value.toUpperCase() : e.target.value }))} /></label>)}
            {([['durationDays', 'Collection days'], ['horizonDays', 'Outcome horizon (calendar days)'], ['minDecisions', 'Minimum distinct symbols'], ['costBps', 'Estimated round-trip cost (bps)']] as const).map(([key, label]) => <label className="text-xs" key={key}>{label}<input required type="number" min={key === 'minDecisions' ? 30 : key === 'costBps' ? 0 : 1} max={key === 'minDecisions' ? 10000 : key === 'costBps' ? 100 : 365} className={field} value={definition[key]} onChange={e => setDefinition(v => ({ ...v, [key]: Number(e.target.value) }))} /></label>)}
          </div>
          <Button variant="outline" disabled={busy}>Freeze evaluation definition</Button>
        </form>
      </details>
      {rows.error && <p role="alert" className="text-sm text-destructive">{rows.error.message}</p>}
      {!rows.isLoading && rows.data?.length === 0 && <p className="text-sm text-muted-foreground">No prospective evaluations yet. Create one before collecting agent decisions.</p>}
      {!!rows.data?.length && <label className="block text-xs">Evaluation<select className={field} value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="">Select an evaluation</option>{rows.data.map(row => { const d = JSON.parse(row.definition_json) as Definition; return <option key={row.id} value={row.id}>{d.strategyVersion} · {d.model} · {row.created_at.slice(0, 10)}</option> })}</select></label>}
      {selectedId && <form className="space-y-3 border-t border-border pt-4" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const selected = rows.data?.find(r => r.id === selectedId)
        if (!selected) throw new Error('Select an evaluation')
        const d = JSON.parse(selected.definition_json) as Definition
        const [packet, benchmark] = await Promise.all([api<Reference>(`${encodeURIComponent(symbol)}?refresh=1`), api<Reference>(`${encodeURIComponent(d.benchmark)}?refresh=1`)])
        await api(`evaluations/${selectedId}/decisions`, { account_id: 1, packetId: packet.id, benchmarkPacketId: benchmark.id, action, reason, model: actualModel, strategyVersion: actualStrategy })
        setMessage('Prospective decision recorded. Its outcome will remain unavailable until the frozen horizon has elapsed.')
      }) }}>
        <p className="text-sm font-medium">Record a research decision</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs">Ticker<input required className={field} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} /></label>
          <label className="text-xs">Research action<select className={field} value={action} onChange={e => setAction(e.target.value)}><option value="buy">Buy thesis</option><option value="hold">Hold / no new trade</option><option value="avoid">Avoid</option></select></label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs">Model actually used<input required className={field} value={actualModel} onChange={e => setActualModel(e.target.value)} /></label>
          <label className="text-xs">Strategy version actually used<input required className={field} value={actualStrategy} onChange={e => setActualStrategy(e.target.value)} /></label>
        </div>
        <label className="block text-xs">Evidence-based rationale<textarea required minLength={10} maxLength={1000} className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} variant="outline">Record decision</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => void perform(async () => { const result = await api<{ recorded: number; requested: number; remaining: number }>(`evaluations/${selectedId}/observe`, {}); setMessage(result.requested === 0 ? 'No decisions have matured yet.' : `Saved ${result.recorded} symbol histories; ${result.remaining} remain unavailable or need another collection batch.`) })}>Collect outcome observations</Button></div>
      </form>}
      {report.error && <p role="alert" className="text-sm text-destructive">{report.error.message}</p>}
      {report.data && <div className="space-y-2 text-sm">
        <p>{report.data.assessment.observationCount} matured observations · Mean buy excess return: {report.data.assessment.meanBuyExcessReturnPct == null ? 'Unavailable' : `${report.data.assessment.meanBuyExcessReturnPct.toFixed(2)}%`}</p>
        {report.data.assessment.blockers.length > 0 && <p className="text-xs text-muted-foreground">Evidence remains incomplete. No live readiness is inferred.</p>}
        <details><summary className="cursor-pointer text-xs">Method and limitations</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">{report.data.assessment.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p role="status" className="text-xs text-muted-foreground">{busy ? 'Saving research evidence…' : message}</p>
    </CardContent>
  </Card>
}
