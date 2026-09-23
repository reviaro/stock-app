export function usd(value: number | null | undefined) {
  return value == null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function price(value: number | null | undefined) {
  return value == null ? '—' : value.toFixed(value >= 1 ? 2 : 4)
}

export function pct(value: number | null | undefined) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function rMultiple(value: number | null | undefined) {
  return value == null ? '—' : `${value.toFixed(2)}R`
}

export function time(iso: string | null | undefined) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return '—'
  if (ms < 0) return time(iso)
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}
