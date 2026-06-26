import { useState } from 'react'
import { useValueScreener } from '@/hooks/useScreener'
import { MemoDrawer } from '@/components/MemoDrawer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

function fmt(n: number | null | undefined, d = 2) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function actionClass(action: string) {
  if (action === 'Candidate') return 'bg-green-900/40 text-green-300 border-green-500/40'
  if (action === 'Avoid') return 'bg-red-900/40 text-red-300 border-red-500/40'
  if (action === 'Wait') return 'bg-amber-900/40 text-amber-300 border-amber-500/40'
  return 'bg-blue-900/40 text-blue-300 border-blue-500/40'
}

export function OpportunitiesPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useValueScreener()
  const [memoSymbol, setMemoSymbol] = useState<string | null>(null)

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Opportunities</h1>
            <p className="text-sm text-muted-foreground">Quality/value triage for the watchlist. A high score means “research first,” not “buy blindly.”</p>
          </div>
          <button type="button" onClick={() => void refetch()} className="data-hover text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground">
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Value / Quality Screener</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-3 pb-4">
            {isLoading && <p className="text-sm text-muted-foreground">Loading candidates…</p>}
            {isError && <p className="text-sm text-destructive">{error instanceof Error ? error.message : 'Failed to load screener.'}</p>}
            {!isLoading && !isError && (!data || data.length === 0) && <p className="text-sm text-muted-foreground">No watchlist names to screen yet.</p>}
            {data && data.length > 0 && (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-3">Ticker</th>
                    <th className="text-right py-2 pr-3">Score</th>
                    <th className="text-left py-2 pr-3">Action</th>
                    <th className="text-right py-2 pr-3">Price</th>
                    <th className="text-right py-2 pr-3">Fwd/PE</th>
                    <th className="text-right py-2 pr-3">Quality</th>
                    <th className="text-left py-2 pr-3">Why it scored this way</th>
                    <th className="text-left py-2">Red flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr key={row.symbol} className="data-hover border-b border-border/50 align-top">
                      <td className="py-2 pr-3">
                        <button type="button" onClick={() => setMemoSymbol(row.symbol)} className="text-left hover:text-primary">
                          <span className="font-semibold text-foreground">{row.symbol}</span>
                          <span className="block text-[10px] text-muted-foreground max-w-[220px] truncate">{row.name}</span>
                          {row.hasThesis && <span className="block text-[10px] text-primary">thesis saved</span>}
                        </button>
                      </td>
                      <td className="font-mono text-right py-2 pr-3">{row.score}</td>
                      <td className="py-2 pr-3"><Badge variant="outline" className={`text-[10px] ${actionClass(row.action)}`}>{row.action}</Badge></td>
                      <td className="font-mono text-right py-2 pr-3">${fmt(row.price)}</td>
                      <td className="font-mono text-right py-2 pr-3">{fmt(row.forwardPE, 1)}x</td>
                      <td className="font-mono text-right py-2 pr-3">{fmt(row.qualityComposite, 0)}</td>
                      <td className="py-2 pr-3 min-w-[260px]">
                        <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
                          {row.reasons.map((r) => <li key={r}>{r}</li>)}
                        </ul>
                      </td>
                      <td className="py-2 min-w-[180px] text-muted-foreground">
                        {row.red_flags.length ? row.red_flags.join(', ') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
      <MemoDrawer symbol={memoSymbol} open={!!memoSymbol} onOpenChange={(o) => { if (!o) setMemoSymbol(null) }} />
    </div>
  )
}
