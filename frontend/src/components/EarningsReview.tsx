import { useQuery } from '@tanstack/react-query'
import { monitorRequest, sourceUrl, monitorDate } from '@/lib/researchMonitor'
import type { EarningsResponse } from '@/types/researchMonitor'

const money = (value?: number) => value == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value)
const pct = (value: number | null) => value == null ? '—' : `${value.toFixed(1)}%`

export function EarningsReview({ symbol }: { symbol: string }) {
  const query = useQuery({ queryKey: ['monitor-earnings', symbol], queryFn: () => monitorRequest<EarningsResponse>(`/earnings/${encodeURIComponent(symbol)}`), enabled: Boolean(symbol), staleTime: 60_000, refetchInterval: 60_000, retry: 1 })
  const report = query.data?.report
  return <section id="monitor-earnings-review" aria-label="Earnings review" className="min-w-0 scroll-mt-40 border-t border-border pt-6">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-xl font-semibold">Earnings review <span className="text-primary">{symbol}</span></h2>
      {report && <p className="text-xs text-muted-foreground">SEC reported results · USD · As of {report.asOf}</p>}
    </div>
    {!symbol && <p className="mt-3 text-sm text-muted-foreground">Choose a company to compare reported quarters and open its earnings release.</p>}
    {query.isLoading && <p role="status" className="mt-3 text-sm text-muted-foreground">Reading reported earnings…</p>}
    {query.error && <p role="alert" className="mt-3 text-sm text-destructive">{query.error.message}</p>}
    {query.data?.status && <p role="status" className="mt-3 text-sm text-warning">{query.data.status}</p>}
    {report && <>
      {report.changes.length > 0 && <ul className="my-4 space-y-1 text-sm">{report.changes.map(text => <li key={text}>{text}</li>)}</ul>}
      {report.warnings.map(text => <p key={text} className="my-3 text-sm text-warning">{text}</p>)}
      <div className="my-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {sourceUrl(report.latestReport?.url) && <a className="text-primary underline underline-offset-4" href={sourceUrl(report.latestReport?.url)} target="_blank" rel="noreferrer">Latest {report.latestReport?.form} · {report.latestReport?.filedAt}</a>}
        {sourceUrl(report.earningsRelease?.exhibitUrl || report.earningsRelease?.url) && <a className="text-primary underline underline-offset-4" href={sourceUrl(report.earningsRelease?.exhibitUrl || report.earningsRelease?.url)} target="_blank" rel="noreferrer">{report.earningsRelease?.exhibitUrl ? 'Earnings release' : 'Earnings announcement (8-K)'} · {report.earningsRelease?.filedAt}</a>}
      </div>
      {report.rows.length > 0 && <div className="overflow-x-auto rounded-md border border-border" role="region" aria-label="Quarterly earnings table" tabIndex={0}>
        <table className="w-full whitespace-nowrap text-right text-sm tabular-nums">
          <caption className="sr-only">Reported quarterly revenue, income and diluted EPS for {symbol}. Asterisk indicates a derived value.</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>{['Quarter ended', 'Revenue', 'Revenue YoY', 'Operating margin', 'Net income', 'Diluted EPS', 'EPS YoY'].map(label => <th key={label} scope="col" className="px-4 py-3 first:text-left font-medium">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">{report.rows.map(row => <tr key={row.end}>
            <th scope="row" className="px-4 py-3 text-left font-medium">{row.end}</th>
            <td className="px-4 py-3">{money(row.metrics.revenue?.value)}{row.metrics.revenue?.derived ? '*' : ''}</td>
            <td className="px-4 py-3">{pct(row.revenueYoY)}</td><td className="px-4 py-3">{pct(row.operatingMargin)}</td>
            <td className="px-4 py-3">{money(row.metrics.netIncome?.value)}{row.metrics.netIncome?.derived ? '*' : ''}</td>
            <td className="px-4 py-3">{row.metrics.eps ? `$${row.metrics.eps.value.toFixed(2)}` : '—'}</td><td className="px-4 py-3">{pct(row.epsYoY)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer py-1">Calculation notes and filing evidence</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">{report.limitations.map(text => <li key={text}>{text}</li>)}</ul>
        <p className="mt-2">* Derived value. Missing values remain unavailable. Comparisons use matching quarter lengths; year-over-year growth requires a positive prior value.</p>
        {report.rows.map(row => <div key={row.end} className="mt-3"><p className="font-medium text-foreground">{row.start} – {row.end}</p><ul className="mt-1 space-y-1">{Object.entries(row.metrics).filter(([, fact]) => fact).map(([key, fact]) => <li key={key}>{key}: {fact?.tag} · filed {fact?.filed}{fact?.derived ? ' · derived' : ''}{sourceUrl(fact?.url) && <> · <a className="text-primary underline" href={sourceUrl(fact?.url)} target="_blank" rel="noreferrer">Source filing</a></>}</li>)}</ul></div>)}
      </details>
    </>}
    {query.data?.checkedAt && <p className="mt-3 text-xs text-muted-foreground">Last checked {monitorDate(query.data.checkedAt)}. ETFs and unsupported financial-statement formats may have no earnings report.</p>}
  </section>
}
