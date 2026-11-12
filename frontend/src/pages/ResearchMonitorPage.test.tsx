import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchMonitorPage } from './ResearchMonitorPage'
import type { MonitorOverview } from '@/types/researchMonitor'

let data: MonitorOverview
let failWrites: boolean
let writes: { url: string; body: Record<string, unknown> }[]
beforeEach(() => {
  failWrites = false; writes = []
  data = { unread: 2, nextCursor: null, tracked: ['AAPL'], alerts: [], checking: false, intervalMinutes: 15,
    symbols: [{ symbol: 'AAPL', checkedAt: '2026-11-12T15:00:00Z', status: { news: null, filings: null, price: 'No fresh, dated USD quote; alerts were not evaluated.' } }],
    events: [{ id: 41, symbol: 'AAPL', kind: 'news', title: 'Quarterly results released', url: 'https://example.test/results', publishedAt: '2026-11-12T14:00:00Z', createdAt: '2026-11-12T15:00:00Z', reviewedAt: null, detail: { category: 'Earnings', publisher: 'Example' } },
      { id: 42, symbol: 'AAPL', kind: 'filing', title: '<script>untrusted filing title</script>', url: 'javascript:alert(1)', publishedAt: null, createdAt: '2026-11-12T15:00:00Z', reviewedAt: null, detail: {} }],
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body as string); writes.push({ url: String(url), body })
      if (failWrites) return { ok: false, json: async () => ({ status: 'error', error: 'Unable to save. Please retry.' }) }
      if (String(url).endsWith('/reviewed')) data = { ...data, events: data.events.filter(event => !(body.ids as number[]).includes(event.id)) }
      return { ok: true, json: async () => ({ status: 'success', data: {} }) }
    }
    return { ok: true, json: async () => ({ status: 'success', data: String(url).includes('/earnings/')
      ? { report: null, checkedAt: null, status: 'SEC contact configuration is needed for earnings.' } : data }) }
  }))
})
afterEach(() => vi.unstubAllGlobals())
const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ResearchMonitorPage /></QueryClientProvider>)
const ready = () => screen.findByRole('link', { name: 'Quarterly results released' }, { timeout: 5000 })

describe('Research monitor', () => {
  it('shows source gaps and safely renders untrusted headlines with explicit review actions', async () => {
    show()
    expect(await ready()).toHaveAttribute('href', 'https://example.test/results')
    expect(screen.getByText('<script>untrusted filing title</script>')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '<script>untrusted filing title</script>' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/Source coverage/))
    expect(screen.getByText(/No fresh, dated USD quote/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Mark displayed reviewed' }))
    await waitFor(() => expect(writes[0].body).toEqual({ ids: [41, 42] }))
    expect(await screen.findByText('Displayed items marked reviewed.')).toBeVisible()
    expect(screen.getByText('No items in this view.')).toBeVisible()
  })
  it('preserves alert input after an error, then creates a typed repeating rule on retry', async () => {
    show(); await ready()
    fireEvent.change(screen.getByLabelText('Price (USD)'), { target: { value: '150.50' } })
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'Buy level review' } })
    fireEvent.click(screen.getByLabelText(/Repeat after price/))
    failWrites = true; fireEvent.click(screen.getByRole('button', { name: 'Create alert' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save')
    expect(screen.getByLabelText('Price (USD)')).toHaveValue(150.5)
    expect(screen.getByLabelText('Label (optional)')).toHaveValue('Buy level review')
    failWrites = false; fireEvent.click(screen.getByRole('button', { name: 'Create alert' }))
    await screen.findByText(/Price alert created/)
    expect(writes.at(-1)?.body).toEqual({ symbol: 'AAPL', condition: 'below', threshold: 150.5, repeat: true, label: 'Buy level review' })
    expect(screen.getByLabelText('Price (USD)')).toHaveValue(null)
  })
  it('imports memo levels for the explicitly opened company and keeps check failures visible', async () => {
    show(); await ready()
    fireEvent.change(screen.getByLabelText('Stock or ETF symbol'), { target: { value: 'MSFT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import saved memo levels' }))
    await screen.findByText(/Saved memo price levels imported/)
    expect(writes[0]).toEqual({ url: '/api/research/monitor/alerts/import-memo', body: { symbol: 'MSFT' } })
    failWrites = true; fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save')
  })
})
