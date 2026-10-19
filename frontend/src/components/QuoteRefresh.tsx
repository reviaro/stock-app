import { useEffect, useState } from 'react'

/** A successful response time is not the exchange's quote timestamp. */
export function QuoteRefresh({ updatedAt = 0, isFetching, isError, onRefresh, label }: {
  updatedAt?: number
  isFetching?: boolean
  isError?: boolean
  onRefresh: () => unknown
  label: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const stale = updatedAt > 0 && now - updatedAt > 120_000
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <p>
        {updatedAt > 0 ? <>Last checked <time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>. </> : 'Not checked yet. '}
        {isError ? 'Refresh failed; values may be out of date.' : stale ? 'Refresh overdue; values may be out of date.' : 'Quotes may be delayed.'}
      </p>
      <button type="button" disabled={isFetching} onClick={() => { void onRefresh() }} aria-label={`Refresh ${label}`} className="shrink-0 rounded-md border border-border px-3 py-2 disabled:opacity-60">
        {isFetching ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )
}
