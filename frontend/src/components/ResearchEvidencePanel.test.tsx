import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchEvidencePanel } from './ResearchEvidencePanel'

const packet = () => ({ id: 'synthetic-packet', contentHash: 'a'.repeat(64), symbol: 'TEST', generatedAt: '2026-10-21T14:00:00Z', eligibleForDecision: false,
  blockers: ['Insufficient applicable financial-statement coverage'], provenance: { info: { source: 'yfinance', available: true, stale: true, eventAt: '2026-10-01T14:00:00Z' } },
  data: { info: { quoteType: 'EQUITY' }, news: [], filings: null } })
let data: ReturnType<typeof packet>
let calls: { url: string; body?: string }[]
beforeEach(() => {
  data = packet(); calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    calls.push({ url: String(input), body: options?.body as string })
    if (options?.method === 'POST') return { ok: false, json: async () => ({ status: 'error', error: 'Disclosure date must be current' }) }
    return { ok: true, json: async () => ({ status: 'success', data: String(input).endsWith('/sources') ? { secConfigured: false, alpacaNewsConfigured: false, models: ['synthetic-model'] } : data }) }
  }))
})
afterEach(() => vi.unstubAllGlobals())
function show() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ResearchEvidencePanel symbol="TEST" /></QueryClientProvider>) }
describe('Research evidence', () => {
  it('shows missing and stale evidence without suggesting readiness', async () => {
    show()
    expect(await screen.findByText(/Research is incomplete/)).toBeVisible()
    expect(screen.getByText(/Stale · As of 2026-10-01/)).toBeVisible()
    expect(screen.getByText('Insufficient applicable financial-statement coverage')).toBeVisible()
    fireEvent.click(screen.getByText('News and filing sources'))
    expect(screen.getByText(/does not establish that there are no material events/)).toBeVisible()
    expect(calls.every(c => c.url.startsWith('/api/research/'))).toBe(true)
  })
  it('keeps an issuer disclosure draft after a server validation error', async () => {
    data.data.info.quoteType = 'ETF'
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Review issuer disclosure' }))
    fireEvent.change(screen.getByLabelText('Benchmark'), { target: { value: 'Synthetic index' } })
    fireEvent.change(screen.getByLabelText('Annual expense ratio (%)'), { target: { value: '0.05' } })
    fireEvent.change(screen.getByLabelText('Disclosure date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Issuer disclosure URL'), { target: { value: 'https://issuer.example/disclosure' } })
    fireEvent.change(screen.getByLabelText(/Disclosed holdings/), { target: { value: 'TEST, 20' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save verified disclosure' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disclosure date must be current')
    expect(screen.getByLabelText('Benchmark')).toHaveValue('Synthetic index')
    expect(screen.getByLabelText(/Disclosed holdings/)).toHaveValue('TEST, 20')
    expect(JSON.parse(calls.find(c => c.body)?.body || '{}').holdings).toEqual([{ symbol: 'TEST', weightPct: 20 }])
  })
})
