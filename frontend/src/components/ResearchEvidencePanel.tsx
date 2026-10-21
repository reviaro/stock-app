import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useTickerStore } from '@/lib/store'

type Provenance = { source: string; available: boolean; stale: boolean; eventAt?: string | null; retrievedAt?: string | null }
type Fund = { applicable?: boolean; issuerVerified?: boolean; expenseRatioPct?: number | null; benchmark?: string | null; holdingsAsOf?: string; disclosedWeightPct?: number; holdings?: { symbol: string; weightPct: number }[] }
export interface ResearchPacket {
  id: string; contentHash: string; symbol: string; generatedAt: string; eligibleForDecision: boolean; blockers: string[]
  provenance: Record<string, Provenance>
  data: { info?: { quoteType?: string }; fund?: Fund; news: { title: string; url: string | null; publisher: string | null; publishedAt: string | null }[]; filings?: { filings: { form: string; filedAt: string; url: string | null }[] } }
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const json = await response.json()
  if (!response.ok || json.status !== 'success') throw new Error(json.error || 'Research unavailable')
  return json.data as T
}
const SOURCE_LABELS: Record<string, string> = { yfinance: 'Yahoo Finance', sec_edgar: 'SEC filings', issuer_disclosure: 'Issuer disclosure', alpaca_benzinga: 'Alpaca / Benzinga' }
const EVIDENCE_LABELS: Record<string, string> = { info: 'Quote and profile', quality: 'Business quality', technical: 'Daily indicators', canslim: 'CAN SLIM', news: 'News', fund: 'Fund disclosure', filings: 'Filings' }
const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

function FundDisclosureForm({ symbol, onSaved }: { symbol: string; onSaved: () => void }) {
  const [benchmark, setBenchmark] = useState('')
  const [expense, setExpense] = useState('')
  const [asOf, setAsOf] = useState('')
  const [url, setUrl] = useState('')
  const [holdings, setHoldings] = useState('')
  const [attest, setAttest] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return <form className="space-y-3 border-t border-border pt-4" onSubmit={async event => {
    event.preventDefault(); setPending(true); setError('')
    try {
      if (!expense.trim() || !holdings.trim()) throw new Error('Provide fund costs and disclosed holdings.')
      const rows = holdings.trim().split('\n').map(line => { const [ticker, weight] = line.split(',').map(x => x.trim()); return { symbol: ticker.toUpperCase(), weightPct: weight ? Number(weight) : NaN } })
      await request('/api/research/fund-disclosures', { symbol, benchmark, expenseRatioPct: Number(expense), asOf, issuerUrl: url, holdings: rows, attestation: attest ? 'I VERIFIED THIS ISSUER DISCLOSURE' : '' })
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Disclosure could not be saved') } finally { setPending(false) }
  }}>
    <p className="text-xs text-muted-foreground">Record facts from the issuer’s dated disclosure. This is your verification; the app does not authenticate the linked document. Partial holdings leave residual exposure unknown.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Benchmark<input required className={field} value={benchmark} onChange={e => setBenchmark(e.target.value)} /></label>
      <label className="text-xs">Annual expense ratio (%)<input required type="number" min="0" max="10" step="0.001" className={field} value={expense} onChange={e => setExpense(e.target.value)} /></label>
      <label className="text-xs">Disclosure date<input required type="date" className={field} value={asOf} onChange={e => setAsOf(e.target.value)} /></label>
      <label className="text-xs">Issuer disclosure URL<input required type="url" className={field} value={url} onChange={e => setUrl(e.target.value)} /></label>
    </div>
    <label className="block text-xs">Disclosed holdings — one symbol, percentage per line<textarea required rows={4} className={field} placeholder={'SYMBOL, 5.25'} value={holdings} onChange={e => setHoldings(e.target.value)} /></label>
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" required checked={attest} onChange={e => setAttest(e.target.checked)} />I checked these costs, benchmark and holdings against the issuer disclosure.</label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" variant="outline" disabled={pending || !attest}>{pending ? 'Saving…' : 'Save verified disclosure'}</Button>
  </form>
}

export function ResearchEvidencePanel({ symbol, snapshot }: { symbol?: string; snapshot?: ResearchPacket }) {
  const [observedAt, setObservedAt] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setObservedAt(Date.now()), 60_000); return () => clearInterval(timer) }, [])
  const selected = useTickerStore(s => s.selectedTicker)
  const ticker = symbol || selected
  const client = useQueryClient()
  const [showFundForm, setShowFundForm] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const query = useQuery({ queryKey: ['research-evidence', ticker], queryFn: () => request<ResearchPacket>(`/api/research/${encodeURIComponent(ticker)}`), enabled: Boolean(ticker) && !snapshot, staleTime: 60_000, retry: 1 })
  const sources = useQuery({ queryKey: ['research-sources'], queryFn: () => request<{ secConfigured: boolean; alpacaNewsConfigured: boolean; models: string[] }>('/api/research/sources'), staleTime: 60_000, retry: 1 })
  const packet = snapshot || query.data
  const isFund = packet?.data.info?.quoteType === 'ETF'
  return <Card className="min-w-0">
    <CardHeader className="pb-2"><CardTitle className="text-base">Research evidence {ticker && <span className="text-primary">{ticker}</span>}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {!ticker && <p className="text-sm text-muted-foreground">Select a stock or ETF to review its sources and missing evidence.</p>}
      {!snapshot && query.isLoading && <p className="text-sm text-muted-foreground" role="status">Collecting dated research…</p>}
      {!snapshot && query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}</p>}
      {packet && <>
        <p className="text-xs text-muted-foreground">Research collected {new Date(packet.generatedAt).toLocaleString()}{observedAt - Date.parse(packet.generatedAt) > 30 * 60_000 ? ' · Expired for new agent decisions' : ''}</p>
        <p className="text-sm">{packet.eligibleForDecision ? 'Research coverage checks passed. Review the thesis and account limits before trading.' : 'Research is incomplete. Resolve these gaps before an agent decision.'}</p>
        {packet.blockers.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{packet.blockers.map(b => <li key={b}>{b}</li>)}</ul>}
        <dl className="grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
          {Object.entries(packet.provenance).filter(([key]) => key !== 'history').map(([key, item]) => <div key={key}>
            <dt className="font-medium capitalize">{EVIDENCE_LABELS[key] || key} · {SOURCE_LABELS[item.source] || item.source}</dt>
            <dd className="text-muted-foreground">{!item.available ? 'Unavailable' : item.stale ? 'Stale' : 'Available'} · {item.eventAt ? `As of ${item.eventAt.slice(0, 10)}` : 'Event date unavailable'}</dd>
          </div>)}
        </dl>
        {isFund && <div className="space-y-3 border-t border-border pt-3">
          <p className="text-sm font-medium">Fund research</p>
          <p className="text-xs text-muted-foreground">{packet.data.fund?.issuerVerified ? 'Operator-verified issuer disclosure' : 'Issuer verification needed'} · {packet.data.fund?.holdingsAsOf || 'Holdings date unavailable'}</p>
          <p className="text-sm">Expense ratio: {packet.data.fund?.expenseRatioPct != null ? `${packet.data.fund.expenseRatioPct}%` : 'Unavailable'} · Benchmark: {packet.data.fund?.benchmark || 'Unavailable'}</p>
          {!snapshot && <Button variant="outline" size="sm" onClick={() => setShowFundForm(v => !v)}>{showFundForm ? 'Hide disclosure form' : 'Review issuer disclosure'}</Button>}
          {showFundForm && <FundDisclosureForm key={ticker} symbol={ticker} onSaved={() => { setShowFundForm(false); void client.invalidateQueries({ queryKey: ['research-evidence', ticker] }) }} />}
        </div>}
        <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm">News and filing sources</summary>
          <ul className="mt-2 space-y-2 text-xs">{packet.data.news.map((n, i) => <li key={n.url || i}>{n.url ? <a href={n.url} target="_blank" rel="noreferrer" className="text-primary underline">{n.title}</a> : n.title}<span className="block text-muted-foreground">{n.publisher || 'Publisher unavailable'} · {n.publishedAt?.slice(0, 10) || 'Date unavailable'}</span></li>)}</ul>
          {!packet.data.news.length && <p className="mt-2 text-xs text-muted-foreground">No available headlines. This does not establish that there are no material events.</p>}
          <ul className="mt-3 space-y-1 text-xs">{packet.data.filings?.filings?.slice(0, 5).map(f => f.url && <li key={f.url}><a href={f.url} target="_blank" rel="noreferrer" className="text-primary underline">{f.form} · {f.filedAt}</a></li>)}</ul>
        </details>
        <Button variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify({ packetId: packet.id, contentHash: packet.contentHash, symbol: packet.symbol, generatedAt: packet.generatedAt, blockers: packet.blockers })); setCopyStatus('Research reference copied') } catch { setCopyStatus('Clipboard unavailable') } }}>Copy agent research reference</Button>
        <span role="status" className="text-xs text-muted-foreground">{copyStatus}</span>
      </>}
      {sources.data && <p className="border-t border-border pt-3 text-xs text-muted-foreground">SEC filings: {sources.data.secConfigured ? 'configured' : 'contact configuration needed'} · Alpaca news: {sources.data.alpacaNewsConfigured ? 'configured' : 'not configured'}<br />Configured model: {sources.data.models.join(', ') || 'not configured'}. Research prices are separate from broker execution quotes.</p>}
    </CardContent>
  </Card>
}
