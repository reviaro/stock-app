export async function monitorRequest<T>(path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/research/monitor${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok || result.status !== 'success') throw new Error(result.error || 'Unable to load research monitor')
  return result.data
}
export function sourceUrl(url: string | null | undefined): string | undefined {
  try { const value = new URL(url || ''); return ['https:', 'http:'].includes(value.protocol) && !value.username && !value.password ? value.href : undefined }
  catch { return undefined }
}
export const monitorDate = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleString(undefined, value.length === 10 ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable'
